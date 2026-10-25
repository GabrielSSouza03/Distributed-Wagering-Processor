export class ApplicationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor() {
    super("Wallet was not found", "WALLET_NOT_FOUND");
  }
}

export class WalletContextMismatchError extends ApplicationError {
  constructor() {
    super("Wallet does not belong to the supplied player or currency", "WALLET_CONTEXT_MISMATCH");
  }
}

export class IdempotencyConflictError extends ApplicationError {
  constructor() {
    super("The idempotency key was already used with another payload", "IDEMPOTENCY_CONFLICT");
  }
}
