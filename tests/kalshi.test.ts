import assert from "node:assert/strict";
import {
  constants,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import test from "node:test";
import { validateTradingConfig } from "../src/config.js";
import {
  KalshiClient,
  kalshiAuthHeaders,
  kalshiTokenId,
  parseKalshiTokenId,
} from "../src/kalshi-api.js";
import { kalshiBooks } from "../src/market-scanner.js";
import { testConfig } from "./helpers.js";

test("Kalshi YES/NO bids normalize into complementary Up/Down books", () => {
  const books = kalshiBooks("KXBTC15M-TEST", {
    orderbook_fp: {
      yes_dollars: [
        ["0.3000", "12.00"],
        ["0.4200", "7.50"],
      ],
      no_dollars: [
        ["0.5300", "9.00"],
        ["0.5500", "4.00"],
      ],
    },
  });
  assert.deepEqual(
    books.map((book) => ({
      token: book.tokenId,
      outcome: book.outcome,
      bid: book.bestBid,
      ask: book.bestAsk,
    })),
    [
      {
        token: "KXBTC15M-TEST::yes",
        outcome: "Up",
        bid: 0.42,
        ask: 0.45,
      },
      {
        token: "KXBTC15M-TEST::no",
        outcome: "Down",
        bid: 0.55,
        ask: 0.58,
      },
    ],
  );
});

test("Kalshi token IDs round-trip without confusing market tickers and outcomes", () => {
  const tokenId = kalshiTokenId("KXBTC15M-26JUL291500", "no");
  assert.deepEqual(parseKalshiTokenId(tokenId), {
    ticker: "KXBTC15M-26JUL291500",
    outcome: "no",
  });
  assert.equal(parseKalshiTokenId("not-a-kalshi-token"), null);
});

test("Kalshi REST authentication signs timestamp, method, and path without query", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const headers = kalshiAuthHeaders(
    "test-key",
    privateKey,
    "GET",
    "/portfolio/fills?ticker=TEST",
    "https://external-api.kalshi.com/trade-api/v2",
  );
  const message = Buffer.from(
    `${headers["KALSHI-ACCESS-TIMESTAMP"]}GET/trade-api/v2/portfolio/fills`,
  );
  assert.equal(headers["KALSHI-ACCESS-KEY"], "test-key");
  assert.equal(
    verify(
      "sha256",
      message,
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"]!, "base64"),
    ),
    true,
  );
});

test("Kalshi order entry maps Up to a YES bid and Down to a complementary YES ask", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        order_id: `order-${requests.length}`,
        fill_count: "0.00",
        remaining_count: "10.00",
        ts_ms: Date.now(),
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const client = new KalshiClient(
      testConfig({
        exchange: "kalshi",
        kalshiApiKeyId: "test-key",
        kalshiPrivateKeyPem: privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
      }),
    );
    await client.init();
    await client.createOrder({
      ticker: "KXBTC15M-TEST",
      clientOrderId: "up-order",
      outcome: "yes",
      count: 10,
      price: 0.42,
      timeInForce: "good_till_canceled",
      postOnly: true,
    });
    await client.createOrder({
      ticker: "KXBTC15M-TEST",
      clientOrderId: "down-order",
      outcome: "no",
      count: 10,
      price: 0.35,
      timeInForce: "fill_or_kill",
      postOnly: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[0]?.side, "bid");
  assert.equal(requests[0]?.price, "0.4200");
  assert.equal(requests[0]?.post_only, true);
  assert.equal(requests[1]?.side, "ask");
  assert.equal(requests[1]?.price, "0.6500");
  assert.equal(requests[1]?.time_in_force, "fill_or_kill");
});

test("Kalshi paper mode requires WebSocket credentials and official endpoints", () => {
  const base = testConfig({
    exchange: "kalshi",
    strategyMode: "ladder_v6",
    executionMode: "paper",
  });
  assert.throws(
    () => validateTradingConfig(base),
    /Kalshi paper\/live mode requires/,
  );
  assert.doesNotThrow(() =>
    validateTradingConfig({
      ...base,
      kalshiApiKeyId: "key-id",
      kalshiPrivateKeyPem:
        "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
    }),
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...base,
        executionMode: "dry_run",
        strategyMode: "reverse",
        kalshiApiHost: "https://example.com/trade-api/v2",
      }),
    /official production or demo/,
  );
});
