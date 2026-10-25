import {
  AmountMismatchError,
  CurrencyMismatchError,
  InvalidTransactionReferenceError,
  InvalidTransactionStateError,
} from "../../../shared/domain/errors.js";
import type { Money } from "../../../shared/domain/money.js";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry.js";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  InvalidReference = "INVALID_REFERENCE",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",
  PermanentInfrastructureFailure = "PERMANENT_INFRASTRUCTURE_FAILURE",
}

/** Contract check for decimal-string input: only LOSS may carry 0.00. */
export function hasPositiveAmountUnlessLoss(input: {
  kind: WagerTransactionKind;
  money: { amount: string };
}): boolean {
  return input.kind === WagerTransactionKind.Loss || input.money.amount !== "0.00";
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionReferenceError(`${props.kind} requires a reference`);
    }
    if (
      !requiresReference &&
      props.kind !== WagerTransactionKind.Win &&
      props.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionReferenceError(`${props.kind} cannot have a required reference`);
    }
    if (!props.money.isPositive() && props.kind !== WagerTransactionKind.Loss) {
      throw new TypeError("A balance-affecting transaction must have positive money");
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt ?? new Date()),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt === undefined ? undefined : new Date(state.processedAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionReferenceError(`${this.kind} requires a resolved reference`);
    }
    this._referenceTransactionId = referenceTransactionId;
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = new Date(at);
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    if (!this.canWaitForReference()) {
      throw new InvalidTransactionReferenceError(`${this.kind} cannot wait for a reference`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  canWaitForReference(): boolean {
    return this.requiresReference() || this.kind === WagerTransactionKind.Win;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  validateReference(reference: WagerTransaction): void {
    if (this.kind === WagerTransactionKind.Win) {
      this.validateWinReference(reference);
      return;
    }
    if (!this.requiresReference()) {
      throw new InvalidTransactionReferenceError(`${this.kind} does not accept a reference`);
    }
    this.assertSameContext(reference);
    if (!this.money.equals(reference.money)) {
      throw new AmountMismatchError("Reversal amount must equal the reference amount");
    }
    const validKind =
      this.kind === WagerTransactionKind.Refund
        ? reference.kind === WagerTransactionKind.Bet
        : reference.kind === WagerTransactionKind.Bet ||
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund;
    if (!validKind) {
      throw new InvalidTransactionReferenceError(`${this.kind} cannot reference ${reference.kind}`);
    }
  }

  /** A WIN may point at the BET of its round; the payout amount is free. */
  private validateWinReference(reference: WagerTransaction): void {
    this.assertSameContext(reference);
    if (reference.kind !== WagerTransactionKind.Bet) {
      throw new InvalidTransactionReferenceError(`WIN cannot reference ${reference.kind}`);
    }
  }

  private assertSameContext(reference: WagerTransaction): void {
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidTransactionReferenceError("Reference must be processed");
    }
    if (this.money.currency !== reference.money.currency) {
      throw new CurrencyMismatchError(this.money.currency, reference.money.currency);
    }
    const sameContext =
      this.providerId === reference.providerId &&
      this.playerId === reference.playerId &&
      this.walletId === reference.walletId &&
      this.roundId === reference.roundId;
    if (!sameContext) {
      throw new InvalidTransactionReferenceError("Reference belongs to a different wager context");
    }
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Refund:
        if (reference) this.validateReference(reference);
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionReferenceError("ROLLBACK direction requires its reference");
        }
        this.validateReference(reference);
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionReferenceError("LOSS has no ledger direction");
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition terminal transaction in ${this._status}`,
      );
    }
  }
}
