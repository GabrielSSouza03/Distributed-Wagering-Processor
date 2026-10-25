import { AlreadyPublishedError } from "../../../shared/domain/errors.js";
import type { IntegrationEvent } from "../../../shared/domain/integration-event.js";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(event.toJSON()) as unknown as Readonly<Record<string, unknown>>,
      new Date(event.occurredAt),
      0,
      new Date(event.occurredAt),
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt === undefined ? undefined : new Date(state.nextAttemptAt),
      state.publishedAt === undefined ? undefined : new Date(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt === undefined ? undefined : new Date(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt === undefined ? undefined : new Date(this._publishedAt);
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new AlreadyPublishedError("Outbox message is already published");
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new AlreadyPublishedError("Published message cannot be retried");
    this._attempts += 1;
    const delayMs = Math.min(1_000 * 2 ** (this._attempts - 1), 3_600_000);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
