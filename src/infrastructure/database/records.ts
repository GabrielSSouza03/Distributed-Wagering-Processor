import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "wallets" })
@Unique({ properties: ["playerId", "currency"] })
export class WalletRecord {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "uuid", fieldName: "player_id" })
  playerId!: string;

  @Property({ type: "string", length: 3 })
  currency!: string;

  @Property({ type: "string", columnType: "numeric(19,2)" })
  balance!: string;

  @Property({ type: "integer" })
  version!: number;

  @Property({ type: "datetime", fieldName: "created_at" })
  createdAt!: Date;

  @Property({ type: "datetime", fieldName: "updated_at", onUpdate: () => new Date() })
  updatedAt!: Date;
}

@Entity({ tableName: "wager_transactions" })
@Unique({ properties: ["providerId", "idempotencyKey"] })
@Unique({ properties: ["providerId", "externalTransactionId"] })
@Index({ properties: ["walletId", "createdAt"] })
export class WagerTransactionRecord {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "string", fieldName: "provider_id" })
  providerId!: string;

  @Property({ type: "string", fieldName: "external_transaction_id" })
  externalTransactionId!: string;

  @Property({ type: "string", fieldName: "idempotency_key" })
  idempotencyKey!: string;

  @Property({ type: "string", fieldName: "payload_hash", length: 64 })
  payloadHash!: string;

  @Property({ type: "uuid", fieldName: "wallet_id" })
  walletId!: string;

  @Property({ type: "uuid", fieldName: "player_id" })
  playerId!: string;

  @Property({ type: "string", fieldName: "round_id" })
  roundId!: string;

  @Property({ type: "string", fieldName: "game_id" })
  gameId!: string;

  @Property({ type: "string" })
  kind!: string;

  @Property({ type: "string", columnType: "numeric(19,2)" })
  amount!: string;

  @Property({ type: "string", length: 3 })
  currency!: string;

  @Property({ type: "string", fieldName: "reference_external_transaction_id", nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: "uuid", fieldName: "reference_transaction_id", nullable: true })
  referenceTransactionId?: string;

  @Property({ type: "string" })
  status!: string;

  @Property({ type: "string", fieldName: "failure_code", nullable: true })
  failureCode?: string;

  @Property({
    type: "string",
    columnType: "numeric(19,2)",
    fieldName: "resulting_balance",
    nullable: true,
  })
  resultingBalance?: string;

  @Property({ fieldName: "attempts", type: "integer", default: 0 })
  attempts = 0;

  @Property({ type: "datetime", fieldName: "next_attempt_at", nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: "datetime", fieldName: "created_at" })
  createdAt!: Date;

  @Property({ type: "datetime", fieldName: "processed_at", nullable: true })
  processedAt?: Date;
}

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({ properties: ["walletId", "transactionId"] })
export class WalletLedgerEntryRecord {
  @PrimaryKey({ type: "bigint", autoincrement: true })
  seq!: string;

  @Property({ type: "uuid", unique: true })
  id!: string;

  @Property({ type: "uuid", fieldName: "wallet_id" })
  walletId!: string;

  @Property({ type: "uuid", fieldName: "transaction_id" })
  transactionId!: string;

  @Property({ type: "string" })
  direction!: string;

  @Property({ type: "string", columnType: "numeric(19,2)" })
  amount!: string;

  @Property({ type: "string", length: 3 })
  currency!: string;

  @Property({ type: "string", columnType: "numeric(19,2)", fieldName: "balance_before" })
  balanceBefore!: string;

  @Property({ type: "string", columnType: "numeric(19,2)", fieldName: "balance_after" })
  balanceAfter!: string;

  @Property({ type: "datetime", fieldName: "created_at" })
  createdAt!: Date;
}

@Entity({ tableName: "inbox_messages" })
@Unique({ properties: ["consumerName", "messageId"] })
export class InboxMessageRecord {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "string", fieldName: "message_id" })
  messageId!: string;

  @Property({ type: "string", fieldName: "consumer_name" })
  consumerName!: string;

  @Property({ type: "string", fieldName: "payload_hash", length: 64 })
  payloadHash!: string;

  @Property({ type: "datetime", fieldName: "received_at" })
  receivedAt!: Date;

  @Property({ type: "datetime", fieldName: "processed_at", nullable: true })
  processedAt?: Date;
}

@Entity({ tableName: "outbox_messages" })
@Index({ properties: ["publishedAt", "nextAttemptAt"] })
export class OutboxMessageRecord {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "uuid", fieldName: "aggregate_id" })
  aggregateId!: string;

  @Property({ type: "string", fieldName: "event_type" })
  eventType!: string;

  @Property({ type: "json" })
  payload!: Record<string, unknown>;

  @Property({ type: "string", fieldName: "traceparent", nullable: true })
  traceparent?: string;

  @Property({ type: "datetime", fieldName: "occurred_at" })
  occurredAt!: Date;

  @Property({ type: "integer", default: 0 })
  attempts = 0;

  @Property({ type: "datetime", fieldName: "next_attempt_at", nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: "datetime", fieldName: "published_at", nullable: true })
  publishedAt?: Date;

  @Property({ type: "datetime", fieldName: "claimed_until", nullable: true })
  claimedUntil?: Date;
}
