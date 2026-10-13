import { Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBoss, type Queue, type QueuePolicy } from 'pg-boss';
import { databaseSchema } from '../prisma/prisma.service';

/** The process's one pg-boss instance, shared by every queue. */
@Injectable()
export class JobQueue implements OnModuleDestroy {
  private readonly logger = new Logger(JobQueue.name);
  private boss?: Promise<PgBoss>;

  constructor(private readonly config: ConfigService) {}

  /**
   * Starts pg-boss on first use and declares the queue with these options,
   * also when it already exists. null when JOBS_ENABLED is false: no worker,
   * no queue.
   */
  async open(
    name: string,
    policy: QueuePolicy,
    options: Omit<Queue, 'name' | 'policy' | 'partition'>,
  ) {
    if (this.config.get<string>('JOBS_ENABLED', 'true') === 'false') {
      return null;
    }
    this.boss ??= this.start();
    const boss = await this.boss;
    await boss.createQueue(name, { policy, ...options });
    // createQueue leaves an existing queue as it was first created.
    await boss.updateQueue(name, options);
    return boss;
  }

  async onModuleDestroy() {
    await (await this.boss)?.stop({ graceful: true });
  }

  private async start() {
    const connectionString = this.config.getOrThrow<string>('DATABASE_URL');
    // Our own schema on a shared PostgreSQL, so that other projects' pg-boss
    // tables do not collide with ours; pg-boss's default without ?schema=.
    const schema = databaseSchema(connectionString);
    const boss = new PgBoss({
      connectionString,
      application_name: 'animehub-api',
      ...(schema ? { schema } : {}),
    });
    boss.on('error', (error) => this.logger.error(error.message));
    await boss.start();
    return boss;
  }
}

@Module({ providers: [JobQueue], exports: [JobQueue] })
export class JobsModule {}
