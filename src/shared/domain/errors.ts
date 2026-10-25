export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} and ${right}`);
  }
}

export class InsufficientFundsError extends DomainError {}

export class InvalidLedgerEntryError extends DomainError {}

export class InvalidTransactionStateError extends DomainError {}

export class InvalidTransactionReferenceError extends DomainError {}

export class AmountMismatchError extends InvalidTransactionReferenceError {}

export class AlreadyProcessedError extends DomainError {}

export class AlreadyPublishedError extends DomainError {}

export class IdempotencyConflictError extends DomainError {}
