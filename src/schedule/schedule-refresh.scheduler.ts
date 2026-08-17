import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleService } from './schedule.service';

// The weekly board changes slowly (its roster ~once a day, each show's latest
// episode ~once a week), so a few-minute cadence keeps it fresh without hammering
// the source. This decouples freshness from visitor traffic, so the first visitor
// after a new episode airs already sees it — no "warm-up" refresh needed.
export const SCHEDULE_REFRESH_INTERVAL_MS = 4 * 60_000;

@Injectable()
export class ScheduleRefreshScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleRefreshScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly schedule: ScheduleService,
  ) {}

  onModuleInit() {
    // Gated by the same flag as the download worker so CI and job-less
    // deployments don't run background work. refresh() is single-flight and
    // rejects degraded scrapes, so a slow/partial source never corrupts the
    // served snapshot; here we just drive it on a fixed cadence.
    if (this.config.get<string>('JOBS_ENABLED', 'true') === 'false') return;
    // Warm the snapshot immediately on boot: after a restart the stored snapshot
    // can be stale (e.g. a day-old board), and serve-stale-while-revalidate would
    // show that to the first visitor until a request or the interval's first tick
    // (a full period away) refreshed it. Fire-and-forget — the server still starts
    // without waiting for the scrape.
    this.runRefresh();
    this.timer = setInterval(
      () => this.runRefresh(),
      SCHEDULE_REFRESH_INTERVAL_MS,
    );
    // Never keep the process alive just for this heartbeat.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private runRefresh() {
    void this.schedule.refresh().catch((error) => {
      this.logger.warn(
        `Scheduled schedule refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}
