import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    hot_wallet: {
      executor: "constant-arrival-rate",
      rate: 20,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 20,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2000"],
  },
};

const baseUrl = __ENV.BASE_URL ?? "http://localhost:3000";
const jsonHeaders = { headers: { "Content-Type": "application/json" } };

http.setResponseCallback(http.expectedStatuses(200, 201, 202, 422));

export function setup() {
  const wallets = Array.from({ length: 5 }, () => {
    const playerId = uuid();
    const response = http.post(
      `${baseUrl}/wallets`,
      JSON.stringify({
        playerId,
        initialBalance: { amount: "10000.00", currency: "BRL" },
      }),
      jsonHeaders,
    );
    if (response.status !== 201) {
      throw new Error(`wallet setup failed: ${response.status} ${response.body}`);
    }
    const created = response.json();
    return { id: created.id, playerId: created.playerId };
  });
  return { wallets };
}

export default function (data) {
  const wallet = data.wallets[Math.floor(Math.random() * data.wallets.length)];
  const externalTransactionId = `${__VU}-${__ITER}-${Date.now()}`;
  const response = http.post(
    `${baseUrl}/wagering/transactions`,
    JSON.stringify({
      providerId: "load",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId}`,
      gameId: "load-game",
      kind: "BET",
      money: { amount: "1.00", currency: "BRL" },
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `load:${externalTransactionId}`,
      },
    },
  );
  check(response, {
    processed: (res) => res.status === 200 || res.status === 202 || res.status === 422,
  });
  sleep(0.05);
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
