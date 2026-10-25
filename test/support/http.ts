import { expect } from "bun:test";

export interface WalletRef {
  id: string;
  playerId: string;
}

export interface WagerResult {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export async function createWallet(baseUrl: string, amount: string): Promise<WalletRef> {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: "BRL" } }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

export function wager(
  wallet: WalletRef,
  overrides: Partial<WagerBody> & Pick<WagerBody, "kind">,
): WagerBody {
  return {
    providerId: "test-provider",
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "test-game",
    money: { amount: "10.00", currency: "BRL" },
    ...overrides,
  };
}

export async function postWager(
  baseUrl: string,
  body: WagerBody,
  idempotencyKey = `${body.providerId}:${body.externalTransactionId}`,
): Promise<{ status: number; body: WagerResult }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as WagerResult };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(intervalMs);
  }
}
