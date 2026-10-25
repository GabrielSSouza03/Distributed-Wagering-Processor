import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("distributed-wagering-processor");

export const transactionsTotal = meter.createCounter("wager_transactions_total", {
  description: "Wager transactions by status and kind",
});

export const duplicatesTotal = meter.createCounter("wager_duplicates_total", {
  description: "Idempotent replays detected",
});

export const lockConflictsTotal = meter.createCounter("wager_lock_conflicts_total", {
  description: "Wallet lock timeouts and serialization failures",
});

export const dlqTotal = meter.createCounter("wager_dlq_messages_total", {
  description: "Messages moved to the dead-letter queue",
});

export const processingDuration = meter.createHistogram("wager_processing_duration_ms", {
  description: "End-to-end wager processing latency",
  unit: "ms",
});
