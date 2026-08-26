import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HomeService } from './home.service';

export const HOME_RECENT_REFRESH_INTERVAL_MS = 3 * 60_000;

@Injectable()
export class HomeRefreshScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HomeRefreshScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly home: HomeService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('JOBS_ENABLED', 'true') === 'false') return;
    // This heartbeat is process-local, matching ScheduleRefreshScheduler. The
    // current deployment has one JOBS_ENABLED API replica. If the API is scaled
    // horizontally, keep JOBS_ENABLED on a single worker replica (pg-boss is
    // already the project's distributed-work mechanism) before enabling it on
    // more replicas; duplicating this cheap source read is safe but unnecessary.
    this.runRefresh();
    this.timer = setInterval(
      () => this.runRefresh(),
      HOME_RECENT_REFRESH_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private runRefresh() {
    void this.home.refreshRecentEpisodes().catch((error) => {
      this.logger.warn(
        `Scheduled recent-episode refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}
