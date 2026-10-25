import type { IntegrationEvent } from "../../../shared/domain/integration-event.js";
import {
  AmountMismatchError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidTransactionReferenceError,
} from "../../../shared/domain/errors.js";
import { Money, type MoneyProps } from "../../../shared/domain/money.js";
import type { Clock, IdGenerator } from "../../../shared/application/system.port.js";
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from "../../wallet/domain/wallet-ledger-entry.js";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/integration-events.js";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction.js";
import { canonicalSha256 } from "../../../shared/domain/canonical-hash.js";
import type { FinancialStore } from "./financial-store.port.js";
import {
  IdempotencyConflictError,
  WalletContextMismatchError,
  WalletNotFoundError,
} from "./errors.js";

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
  traceparent?: string;
  inbox?: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
  };
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export class ProcessWagerTransaction {
  constructor(
    private readonly store: FinancialStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const money = Money.from(command.money);
    const payloadHash = canonicalSha256({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    try {
      return await this.store.transaction(async (tx) => {
        if (command.inbox) {
          const inboxResult = await tx.recordInbox(command.inbox);
          if (inboxResult === "duplicate") {
            const duplicate = await tx.findByIdempotency(
              command.providerId,
              command.idempotencyKey,
            );
            if (!duplicate) {
              throw new Error("Inbox duplicate has no corresponding wager transaction");
            }
            return {
              transactionId: duplicate.transaction.id,
              status: duplicate.transaction.status,
              balance: Money.from({
                amount: duplicate.resultingBalance ?? "0.00",
                currency: duplicate.transaction.money.currency,
              }).toJSON(),
              ...(duplicate.transaction.failureCode
                ? { failureCode: duplicate.transaction.failureCode }
                : {}),
              idempotentReplay: true,
            };
          }
        }
        const wallet = await tx.findWalletForUpdate(command.walletId);
        if (!wallet) throw new WalletNotFoundError();

        const existing = await tx.findByIdempotency(command.providerId, command.idempotencyKey);
        if (existing) {
          if (!existing.transaction.matchesPayload(payloadHash)) {
            throw new IdempotencyConflictError();
          }
          if (command.inbox) {
            await tx.markInboxProcessed(
              command.inbox.consumerName,
              command.inbox.messageId,
              this.clock.now(),
            );
          }
          return {
            transactionId: existing.transaction.id,
            status: existing.transaction.status,
            balance: Money.from({
              amount: existing.resultingBalance ?? wallet.balance.toJSON().amount,
              currency: wallet.currency,
            }).toJSON(),
            ...(existing.transaction.failureCode
              ? { failureCode: existing.transaction.failureCode }
              : {}),
            idempotentReplay: true,
          };
        }

        if (wallet.playerId !== command.playerId || wallet.currency !== money.currency) {
          throw new WalletContextMismatchError();
        }

        const now = this.clock.now();
        const transaction = WagerTransaction.create({
          id: this.ids.next(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money,
          ...(command.referenceExternalTransactionId
            ? { referenceExternalTransactionId: command.referenceExternalTransactionId }
            : {}),
          createdAt: now,
        });

        const context = {
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          ...(command.causationId ? { causationId: command.causationId } : {}),
          occurredAt: now,
        };
        let reference: WagerTransaction | undefined;
        if (transaction.referenceExternalTransactionId) {
          reference = await tx.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          );
          if (!reference) {
            transaction.markPendingReference();
            await tx.insertTransaction(transaction, wallet.balance.toJSON().amount);
            await tx.enqueue(
              [WagerTransactionPendingReference.from(transaction, context)],
              command.traceparent,
            );
            if (command.inbox) {
              await tx.markInboxProcessed(command.inbox.consumerName, command.inbox.messageId, now);
            }
            return this.result(transaction, wallet.balance, false);
          }
          const existingReversal = await tx.findProcessedReversal(reference.id);
          if (existingReversal && transaction.requiresReference()) {
            transaction.reject(FailureCode.ReferenceAlreadyReversed);
            await tx.insertTransaction(transaction, wallet.balance.toJSON().amount);
            await tx.enqueue(
              [WagerTransactionRejected.from(transaction, context)],
              command.traceparent,
            );
            if (command.inbox) {
              await tx.markInboxProcessed(command.inbox.consumerName, command.inbox.messageId, now);
            }
            return this.result(transaction, wallet.balance, false);
          }
        }

        const events: IntegrationEvent<unknown>[] = [];
        let ledgerEntry: WalletLedgerEntry | undefined;
        try {
          if (reference) transaction.validateReference(reference);
          if (transaction.kind === WagerTransactionKind.Loss) {
            transaction.markProcessed(undefined, now);
          } else {
            const direction = transaction.ledgerDirectionFor(reference);
            const movement = {
              entryId: this.ids.next(),
              transactionId: transaction.id,
              money,
              at: now,
            };
            const entry =
              direction === LedgerDirection.Debit
                ? wallet.debit(movement)
                : wallet.credit(movement);
            ledgerEntry = entry;
            transaction.markProcessed(reference?.id, now);
            await tx.saveWallet(wallet);
            events.push(
              WalletBalanceChanged.from(wallet, entry, { ...context, eventId: this.ids.next() }),
            );
          }
          events.push(WagerTransactionProcessed.from(transaction, context));
        } catch (error) {
          transaction.reject(failureCodeFor(error, transaction));
          events.push(WagerTransactionRejected.from(transaction, context));
        }

        await tx.insertTransaction(transaction, wallet.balance.toJSON().amount);
        await tx.flush();
        if (ledgerEntry) await tx.insertLedger(ledgerEntry);
        await tx.enqueue(events, command.traceparent);
        if (command.inbox) {
          await tx.markInboxProcessed(command.inbox.consumerName, command.inbox.messageId, now);
        }
        return this.result(transaction, wallet.balance, false);
      });
    } catch (error) {
      if (
        isUniqueConstraint(error, "wager_provider_idempotency_unique") ||
        isUniqueConstraint(error, "wager_provider_external_unique")
      ) {
        return this.execute(command);
      }
      throw error;
    }
  }

  private result(
    transaction: WagerTransaction,
    balance: Money,
    idempotentReplay: boolean,
  ): ProcessWagerResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: balance.toJSON(),
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      idempotentReplay,
    };
  }
}

/** Maps a domain rejection to its stable failure code; anything else is not a business rejection. */
export function failureCodeFor(error: unknown, transaction: WagerTransaction): FailureCode {
  if (error instanceof InsufficientFundsError) {
    return transaction.kind === WagerTransactionKind.Rollback
      ? FailureCode.ReversalInsufficientFunds
      : FailureCode.InsufficientFunds;
  }
  if (error instanceof CurrencyMismatchError) return FailureCode.CurrencyMismatch;
  if (error instanceof AmountMismatchError) return FailureCode.AmountMismatch;
  if (error instanceof InvalidTransactionReferenceError) return FailureCode.InvalidReference;
  throw error;
}

function isUniqueConstraint(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}
