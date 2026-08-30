import assert from "node:assert/strict";
import {
  constants,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateTradingConfig } from "../src/config.js";
import {
  KalshiClient,
  kalshiAuthHeaders,
  kalshiTokenId,
  parseKalshiTokenId,
} from "../src/kalshi-api.js";
import { KalshiMarketStream } from "../src/kalshi-market-stream.js";
import { KalshiTrader } from "../src/kalshi-trader.js";
import {
  kalshiBooks,
  MarketScanner,
} from "../src/market-scanner.js";
import type { TradeOpportunity } from "../src/types.js";
import { testConfig, testEvent } from "./helpers.js";

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
  const requestUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestUrls.push(String(input));
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
    await client.createOrder({
      ticker: "KXBTC15M-TEST",
      clientOrderId: "flatten-yes",
      outcome: "yes",
      count: 10,
      price: 0.4,
      timeInForce: "fill_or_kill",
      postOnly: false,
      action: "sell",
    });
    await client.amendOrder({
      orderId: "order-1",
      ticker: "KXBTC15M-TEST",
      outcome: "no",
      price: 0.15,
      totalCount: 20,
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
  assert.equal(requests[2]?.side, "ask");
  assert.equal(requests[2]?.price, "0.4000");
  assert.equal(requests[2]?.reduce_only, true);
  assert.match(requestUrls[3]!, /portfolio\/events\/orders\/order-1\/amend$/);
  assert.equal(requests[3]?.side, "ask");
  assert.equal(requests[3]?.price, "0.8500");
  assert.equal(requests[3]?.count, "20.00");
});

test("Kalshi V2 batch entry sends both complementary openings in one request", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ orders: [
      { order_id: "yes-order", fill_count: "0.00", remaining_count: "20.00", ts_ms: Date.now() },
      { order_id: "no-order", fill_count: "0.00", remaining_count: "20.00", ts_ms: Date.now() },
    ] }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new KalshiClient(testConfig({
      exchange: "kalshi", kalshiApiKeyId: "test-key",
      kalshiPrivateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    }));
    await client.init();
    const responses = await client.createOrders([
      { ticker: "KXBTC15M-TEST", clientOrderId: "yes", outcome: "yes", count: 20, price: 0.39, timeInForce: "good_till_canceled", postOnly: true },
      { ticker: "KXBTC15M-TEST", clientOrderId: "no", outcome: "no", count: 20, price: 0.59, timeInForce: "good_till_canceled", postOnly: true },
    ]);
    assert.equal(responses.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(requestedUrl, /portfolio\/events\/orders\/batched$/);
  const orders = body.orders as Array<Record<string, unknown>>;
  assert.equal(orders.length, 2);
  assert.equal(orders[0]?.side, "bid");
  assert.equal(orders[1]?.side, "ask");
  assert.equal(orders[1]?.price, "0.4100");
  assert.ok(orders.every((value) => value.post_only === true));
});

test("Kalshi balance is loaded from the configured subaccount in dollars", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        balance: 12_345,
        portfolio_value: 13_000,
        updated_ts: Date.now(),
      }),
      { status: 200 },
    );
  };
  try {
    const client = new KalshiClient(
      testConfig({
        exchange: "kalshi",
        kalshiSubaccount: 3,
        kalshiApiKeyId: "test-key",
        kalshiPrivateKeyPem: privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
      }),
    );
    await client.init();
    assert.equal(await client.getBalance(), 123.45);
    assert.match(requestedUrl, /portfolio\/balance\?subaccount=3$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("Kalshi scanner discovers multiple crypto series independently of Polymarket prefixes", async () => {
  const originalFetch = globalThis.fetch;
  const closeTime = new Date(Date.now() + 5 * 60_000).toISOString();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const series = url.searchParams.get("series_ticker");
    if (series === "KXETH15M") {
      return new Response(JSON.stringify({ error: "temporary failure" }), {
        status: 503,
      });
    }
    const ticker = `${series}-TEST`;
    return new Response(
      JSON.stringify({
        markets: [
          {
            ticker,
            event_ticker: `${series}-EVENT`,
            market_type: "binary",
            title: `${series} Up or Down`,
            open_time: new Date(Date.now() - 10 * 60_000).toISOString(),
            close_time: closeTime,
            status: "open",
            price_ranges: [{ start: "0", end: "1", step: "0.01" }],
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const scanner = new MarketScanner(
      testConfig({
        exchange: "kalshi",
        executionMode: "dry_run",
        marketSlugPrefixes: ["btc-updown-15m"],
        kalshiSeriesTickers: [
          "KXADA15M",
          "KXBTC15M",
          "KXETH15M",
        ],
        kalshiFeeOverrides: {
          KXADA15M: { takerRate: 0.05, makerRate: 0.01 },
        },
      }),
    );
    const events = await scanner.scan();
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.market.seriesTicker).sort(),
      ["KXADA15M", "KXBTC15M"],
    );
    assert.ok(
      events.some((event) =>
        event.slug.startsWith("ada-updown-15m-"),
      ),
    );
    const ada = events.find(
      (event) => event.market.seriesTicker === "KXADA15M",
    );
    assert.equal(ada?.market.feeSchedule?.rate, 0.05);
    assert.equal(ada?.market.feeSchedule?.makerRate, 0.01);
    const btc = events.find(
      (event) => event.market.seriesTicker === "KXBTC15M",
    );
    assert.equal(btc?.market.feeSchedule?.rate, 0.07);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kalshi stream subscriptions carry all initial and newly added market tickers", () => {
  const messages: Array<Record<string, unknown>> = [];
  const stream = new KalshiMarketStream(
    testConfig({ exchange: "kalshi" }),
    () => undefined,
  );
  const internals = stream as unknown as {
    socket: { readyState: number; send(value: string): void };
    subscriptionIds: Map<string, number>;
    sendSubscriptions(tickers: string[]): void;
    updateSubscriptions(tickers: string[]): void;
  };
  internals.socket = {
    readyState: 1,
    send(value) {
      messages.push(JSON.parse(value) as Record<string, unknown>);
    },
  };
  internals.sendSubscriptions(["KXADA15M-ONE", "KXBTC15M-ONE"]);
  assert.equal(messages.length, 4);
  for (const message of messages) {
    const params = message.params as {
      market_tickers: string[];
    };
    assert.deepEqual(params.market_tickers, [
      "KXADA15M-ONE",
      "KXBTC15M-ONE",
    ]);
  }
  const orderbookSubscription = messages.find(
    (message) =>
      ((message.params as { channels?: string[] }).channels ?? [])[0] ===
      "orderbook_delta",
  );
  assert.equal(
    (orderbookSubscription?.params as { use_yes_price?: boolean })
      .use_yes_price,
    true,
  );

  messages.length = 0;
  internals.subscriptionIds.set("orderbook_delta", 10);
  internals.subscriptionIds.set("trade", 11);
  internals.subscriptionIds.set("fill", 12);
  internals.subscriptionIds.set("user_orders", 13);
  internals.updateSubscriptions(["KXETH15M-ONE", "KXSOL15M-ONE"]);
  assert.equal(messages.length, 4);
  for (const message of messages) {
    const params = message.params as {
      action: string;
      market_tickers: string[];
    };
    assert.equal(params.action, "add_markets");
    assert.deepEqual(params.market_tickers, [
      "KXETH15M-ONE",
      "KXSOL15M-ONE",
    ]);
  }
});

test("Kalshi stream publishes unified two-outcome books atomically", async () => {
  const events: Array<Record<string, unknown>> = [];
  const stream = new KalshiMarketStream(
    testConfig({ exchange: "kalshi" }),
    (event) => events.push(event),
  );
  const internals = stream as unknown as {
    handleMessage(data: unknown): Promise<void>;
  };
  await internals.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "orderbook_snapshot",
        sid: 7,
        seq: 10,
        msg: {
          market_ticker: "KXBTC15M-ONE",
          yes_dollars_fp: [["0.3000", "12.00"]],
          no_dollars_fp: [["0.6000", "9.00"]],
        },
      }),
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_type, "market_books");
  const books = events[0]?.books as Array<Record<string, unknown>>;
  assert.equal(books.length, 2);
  assert.deepEqual(books[0]?.bids, [{ price: "0.3", size: "12" }]);
  assert.deepEqual(books[0]?.asks, [{ price: "0.6", size: "9" }]);
  assert.deepEqual(books[1]?.bids, [{ price: "0.4", size: "9" }]);
  assert.deepEqual(books[1]?.asks, [{ price: "0.7", size: "12" }]);

  await internals.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "orderbook_delta",
        sid: 7,
        seq: 11,
        msg: {
          market_ticker: "KXBTC15M-ONE",
          side: "no",
          price_dollars: "0.5500",
          delta_fp: "4.00",
        },
      }),
    ),
  );
  const changed = events[1]?.books as Array<Record<string, unknown>>;
  assert.deepEqual(changed[0]?.asks, [
    { price: "0.55", size: "4" },
    { price: "0.6", size: "9" },
  ]);
  assert.deepEqual(changed[1]?.bids, [
    { price: "0.45", size: "4" },
    { price: "0.4", size: "9" },
  ]);
});

test("Kalshi stream invalidates books and requests snapshots on a sequence gap", async () => {
  const events: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, unknown>> = [];
  const stream = new KalshiMarketStream(
    testConfig({ exchange: "kalshi" }),
    (event) => events.push(event),
  );
  const internals = stream as unknown as {
    tickers: Set<string>;
    socket: { readyState: number; send(value: string): void };
    subscriptionIds: Map<string, number>;
    handleMessage(data: unknown): Promise<void>;
  };
  internals.tickers.add("KXBTC15M-ONE");
  internals.subscriptionIds.set("orderbook_delta", 7);
  internals.socket = {
    readyState: 1,
    send(value) {
      commands.push(JSON.parse(value) as Record<string, unknown>);
    },
  };
  await internals.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "orderbook_snapshot",
        sid: 7,
        seq: 20,
        msg: {
          market_ticker: "KXBTC15M-ONE",
          yes_dollars_fp: [["0.3", "10"]],
          no_dollars_fp: [["0.6", "10"]],
        },
      }),
    ),
  );
  events.length = 0;
  await internals.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "orderbook_delta",
        sid: 7,
        seq: 22,
        msg: {
          market_ticker: "KXBTC15M-ONE",
          side: "yes",
          price_dollars: "0.31",
          delta_fp: "2",
        },
      }),
    ),
  );
  assert.deepEqual(events.map((event) => event.event_type), [
    "market_books_invalid",
  ]);
  assert.equal(
    (commands[0]?.params as { action?: string }).action,
    "get_snapshot",
  );
  assert.deepEqual(
    (commands[0]?.params as { market_tickers?: string[] }).market_tickers,
    ["KXBTC15M-ONE"],
  );
});

test("Kalshi stream serializes asynchronous message callbacks", async () => {
  let active = 0;
  let maxActive = 0;
  const stream = new KalshiMarketStream(
    testConfig({ exchange: "kalshi" }),
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    },
  );
  const internals = stream as unknown as {
    enqueueMessage(data: unknown): void;
    processingQueue: Promise<void>;
  };
  internals.enqueueMessage(
    Buffer.from(
      JSON.stringify({
        type: "orderbook_snapshot",
        sid: 2,
        seq: 1,
        msg: {
          market_ticker: "KXBTC15M-ONE",
          yes_dollars_fp: [["0.3", "10"]],
          no_dollars_fp: [["0.6", "10"]],
        },
      }),
    ),
  );
  internals.enqueueMessage(
    Buffer.from(
      JSON.stringify({
        type: "orderbook_delta",
        sid: 2,
        seq: 2,
        msg: {
          market_ticker: "KXBTC15M-ONE",
          side: "yes",
          price_dollars: "0.31",
          delta_fp: "2",
        },
      }),
    ),
  );
  await internals.processingQueue;
  assert.equal(maxActive, 1);
});

test("Kalshi live executor persists and cancels Ladder V5 GTC orders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kalshi-v5-live-"));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const originalFetch = globalThis.fetch;
  let resting = false;
  let cancelled = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/portfolio/balance")) {
      return new Response(
        JSON.stringify({
          balance: 100_000,
          portfolio_value: 100_000,
          updated_ts: Date.now(),
        }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/portfolio/events/orders")) {
      resting = true;
      return new Response(
        JSON.stringify({
          order_id: "v5-live-order",
          fill_count: "0.00",
          remaining_count: "10.00",
          ts_ms: Date.now(),
        }),
        { status: 201 },
      );
    }
    if (
      method === "DELETE" &&
      url.pathname.endsWith("/portfolio/orders/v5-live-order")
    ) {
      resting = false;
      cancelled = true;
      return new Response("{}", { status: 200 });
    }
    if (url.pathname.endsWith("/portfolio/orders")) {
      return new Response(
        JSON.stringify({
          orders: resting
            ? [
                {
                  order_id: "v5-live-order",
                  ticker: "KXBTC15M-TEST",
                  status: "resting",
                  remaining_count_fp: "10.00",
                },
              ]
            : [],
        }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/portfolio/fills")) {
      return new Response(JSON.stringify({ fills: [] }), {
        status: 200,
      });
    }
    throw new Error(`Unexpected test request: ${method} ${url}`);
  };
  try {
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v5",
      executionMode: "live",
      dryRun: false,
      paperStatePath: directory,
      kalshiApiKeyId: "test-key",
      kalshiPrivateKeyPem: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    });
    const eventBase = testEvent();
    const event = {
      ...eventBase,
      market: {
        ...eventBase.market,
        exchange: "kalshi" as const,
        externalMarketId: "KXBTC15M-TEST",
        seriesTicker: "KXBTC15M",
        id: "KXBTC15M-TEST",
        conditionId: "KXBTC15M-TEST",
        clobTokenIds: JSON.stringify([
          "KXBTC15M-TEST::yes",
          "KXBTC15M-TEST::no",
        ]),
        feeSchedule: { rate: 0.07, makerRate: 0, exponent: 1 },
      },
    };
    const books = kalshiBooks("KXBTC15M-TEST", {
      orderbook_fp: {
        yes_dollars: [["0.4000", "100.00"]],
        no_dollars: [["0.5000", "100.00"]],
      },
    });
    const subscriptions: string[][] = [];
    const trader = new KalshiTrader(config, {
      stream: {
        subscribe(tokenIds) {
          subscriptions.push(tokenIds);
        },
        close() {},
      },
    });
    await trader.init();
    await trader.observeMarket(event, books);
    assert.deepEqual(subscriptions, [[
      "KXBTC15M-TEST::yes",
      "KXBTC15M-TEST::no",
    ]]);
    const opportunity: TradeOpportunity = {
      kind: "cheap",
      event,
      token: books[0]!,
      price: 0.15,
      size: 10,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: "v5-live-test",
      strategyMode: "ladder_v5",
      phaseId: "5-2",
      pairId: "ladder-v5:0.15-0.85",
      orderPolicy: "gtc",
      capitalEffect: "increase",
    };
    const result = await trader.placeBuy(opportunity);
    assert.equal(result.accepted, true);
    const snapshot = trader.getMarketExecutionSnapshot(event.slug);
    assert.equal(snapshot?.openOrders.length, 1);
    assert.equal(snapshot?.capitalCommitted, 1.5);
    const wakes: string[] = [];
    trader.setExecutionWakeHandler((marketSlug) => wakes.push(marketSlug));
    await trader.ingestMarketEvent({
      event_type: "market_books",
      market_ticker: "KXBTC15M-TEST",
      books: [
        {
          event_type: "book",
          asset_id: "KXBTC15M-TEST::yes",
          bids: [{ price: "0.42", size: "12" }],
          asks: [{ price: "0.58", size: "12" }],
        },
        {
          event_type: "book",
          asset_id: "KXBTC15M-TEST::no",
          bids: [{ price: "0.41", size: "9" }],
          asks: [{ price: "0.59", size: "9" }],
        },
      ],
    });
    assert.deepEqual(
      trader
        .getMarketExecutionSnapshot(event.slug)
        ?.books.map((book) => book.bestAsk),
      [0.58, 0.59],
    );
    await trader.ingestMarketEvent({
      event_type: "fill",
      order_id: "v5-live-order",
      trade_id: "trade-1",
      market_ticker: "KXBTC15M-TEST",
      is_taker: false,
      yes_price_dollars: "0.1500",
      count_fp: "4.00",
      fee_cost: "0.0100",
      ts_ms: Date.now(),
    });
    assert.equal(
      trader.getMarketExecutionSnapshot(event.slug)?.fills[0]?.size,
      4,
    );
    await trader.ingestMarketEvent({
      event_type: "user_order",
      order_id: "v5-live-order",
      ticker: "KXBTC15M-TEST",
      status: "canceled",
      fill_count_fp: "4.00",
      remaining_count_fp: "6.00",
    });
    assert.equal(
      trader.getMarketExecutionSnapshot(event.slug)?.openOrders.length,
      0,
    );
    assert.equal(wakes.length, 3);
    await trader.cancelOrders(["v5-live-order"]);
    assert.equal(cancelled, true);
    assert.equal(
      trader.getMarketExecutionSnapshot(event.slug)?.openOrders.length,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
