import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { SqsService } from "../../../infrastructure/sqs/sqs.service.js";

interface ClaimedOutbox {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  traceparent: string | null;
}

@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisher.name);
  private stopped = false;
  private queueUrl?: string;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!roles().has("outbox")) return;
    this.queueUrl =
      process.env.EVENTS_QUEUE_URL ?? (await this.sqs.ensureQueue("wagering-events.fifo"));
    void this.run();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const batch = await this.claim();
      if (batch.length === 0) {
        await Bun.sleep(250);
        continue;
      }
      await Promise.all(batch.map(async (message) => this.publish(message)));
    }
  }

  private async claim(): Promise<ClaimedOutbox[]> {
    const em = this.orm.em.fork();
    return em.transactional(async (transaction) =>
      transaction.getConnection().execute<ClaimedOutbox[]>(`
        with candidates as (
          select id from outbox_messages
          where published_at is null
            and coalesce(next_attempt_at, occurred_at) <= now()
            and (claimed_until is null or claimed_until < now())
          order by occurred_at
          for update skip locked
          limit 25
        )
        update outbox_messages o
        set claimed_until = now() + interval '30 seconds'
        from candidates c
        where o.id = c.id
        returning o.id, o.aggregate_id, o.payload, o.attempts, o.traceparent
      `),
    );
  }

  private async publish(message: ClaimedOutbox): Promise<void> {
    if (!this.queueUrl) return;
    try {
      await this.sqs.send(
        this.queueUrl,
        JSON.stringify(message.payload),
        message.aggregate_id,
        message.id,
        message.traceparent ?? undefined,
      );
      await this.orm.em
        .fork()
        .getConnection()
        .execute(
          `update outbox_messages
         set published_at = now(), claimed_until = null
         where id = ? and published_at is null`,
          [message.id],
        );
    } catch (error) {
      const attempt = message.attempts + 1;
      const delaySeconds = Math.min(300, 2 ** Math.min(attempt, 8));
      await this.orm.em
        .fork()
        .getConnection()
        .execute(
          `update outbox_messages
         set attempts = ?, next_attempt_at = now() + (? * interval '1 second'), claimed_until = null
         where id = ? and published_at is null`,
          [attempt, delaySeconds, message.id],
        );
      this.logger.warn({ error, eventId: message.id, attempt }, "Outbox publication failed");
    }
  }
}

function roles(): Set<string> {
  return new Set((process.env.APP_ROLES ?? "api").split(",").map((role) => role.trim()));
}
