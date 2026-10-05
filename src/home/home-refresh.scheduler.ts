import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HomeService } from './home.service';
import { HOME_RETRY_INTERVAL_MS } from './home-policy';
export {
  HOME_FULL_REFRESH_INTERVAL_MS,
  HOME_RECENT_REFRESH_INTERVAL_MS,
} from './home-policy';

@Injectable()
export class HomeRefreshScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(
    private readonly config: ConfigService,
    private readonly home: HomeService,
  ) {}
  onModuleInit() {
    if (this.config.get<string>('JOBS_ENABLED', 'true') === 'false') return;
    void this.run();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  private async run() {
    let delay = HOME_RETRY_INTERVAL_MS;
    try {
      // Durable deadlines schedule episodes at 3 minutes and full home at 10,
      // independently of visits. Fresh boot copies aren't scraped again.
      await this.home.refreshIfDue();
      delay = await this.home.nextRefreshDelay();
    } catch {
      /* Retry database outages without an unhandled background rejection. */
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.run();
    }, delay);
    this.timer.unref?.();
  }
}
