import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperTrader } from "../src/paper-trader.js";
import type {
  TokenBook,
  TradeOpportunity,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

const fakeStream = {
  subscribe(_ids: string[]): void {},
  close(): void {},
};

function opportunity(
  token: TokenBook,
  tradeKey: string,
  price: number,
  size: number,
): TradeOpportunity {
  return {
    kind: token.outcome === "Up" ? "cheap" : "expensive",
    event: testEvent(),
    token,
    price,
    size,
    tickSize: "0.01",
    negRisk: false,
    tradeKey,
    strategyMode: "odahoa_ladder",
    phaseId: "15-10",
    pairId: "0.45-0.55",
  };
}

function eventFor(asset: string): ReturnType<typeof testEvent> {
  const base = testEvent();
  const slug = `${asset}-updown-15m-1000000000`;
  return {
    ...base,
    title: `${asset.toUpperCase()} Up or Down - Test`,
    slug,
    market: {
      ...base.market,
      id: `${asset}-market`,
      conditionId: `${asset}-condition`,
      slug,
      clobTokenIds: JSON.stringify([
        `${asset}-up-token`,
        `${asset}-down-token`,
      ]),
    },
  };
}

function booksForAsset(asset: string): TokenBook[] {
  return testBooks(0.9, 0.9).map((book) => ({
    ...book,
    tokenId:
      book.outcome === "Up"
        ? `${asset}-up-token`
        : `${asset}-down-token`,
  }));
}

test("paper trading handles immediate partial fills, queue-ahead, resting fills, and deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-fill-"));
  try {
    const trader = new PaperTrader(
      testConfig({ paperStatePath: directory }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0.07, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks();
    books[0]!.bids = [{ price: 0.45, size: 1.5 }];
    books[0]!.asks = [
      { price: 0.44, size: 1 },
      { price: 0.45, size: 1 },
      { price: 0.46, size: 10 },
    ];
    await trader.observeMarket(testEvent(), books);

    const result = await trader.placeBuy(
      opportunity(books[0]!, "paper-up", 0.45, 2.23),
    );
    assert.equal(
      (result.response as { status: string }).status,
      "partial",
    );
    let state = trader.snapshot();
    assert.equal(state.fills.length, 2);
    assert.equal(state.orders[0]?.remainingSize, 0.23);
    assert.ok(state.fills.every((fill) => fill.liquidity === "taker"));
    assert.ok(state.fills.every((fill) => fill.fee > 0));

    await trader.ingestMarketEvent({
      event_type: "last_trade_price",
      asset_id: "up-token",
      side: "SELL",
      price: "0.45",
      size: "1",
      timestamp: "1",
    });
    state = trader.snapshot();
    assert.equal(state.orders[0]?.queueAhead, 0.5);
    assert.equal(state.orders[0]?.remainingSize, 0.23);

    const fillEvent = {
      event_type: "last_trade_price",
      asset_id: "up-token",
      side: "SELL",
      price: "0.45",
      size: "1",
      timestamp: "2",
    };
    await trader.ingestMarketEvent(fillEvent);
    state = trader.snapshot();
    assert.equal(state.orders[0]?.status, "filled");
    assert.equal(state.fills.at(-1)?.liquidity, "maker");
    assert.equal(state.fills.at(-1)?.price, 0.45);
    assert.ok((state.fills.at(-1)?.makerFeeEquivalent ?? 0) > 0);
    assert.ok((state.fills.at(-1)?.estimatedMakerRebate ?? 0) > 0);
    const fillCount = state.fills.length;
    await trader.ingestMarketEvent(fillEvent);
    assert.equal(trader.snapshot().fills.length, fillCount);

    const unfilled = await trader.placeBuy(
      opportunity(books[1]!, "paper-down", 0.2, 5),
    );
    assert.equal((unfilled.response as { status: string }).status, "open");
    const execution = trader.getMarketExecutionSnapshot(testEvent().slug);
    assert.ok(execution);
    assert.equal(execution.orders.length, 2);
    assert.equal(execution.openOrders.length, 1);
    assert.equal(execution.openCommitted, 1);
    assert.ok(execution.capitalUsed > 1);
    assert.equal(
      execution.capitalCommitted,
      execution.capitalUsed + execution.openCommitted,
    );
    assert.equal(execution.books.length, 2);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maker fills execute highest bid first at the resting limit price", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-maker-priority-"));
  try {
    const trader = new PaperTrader(
      testConfig({ paperStatePath: directory }),
      {
        stream: fakeStream,
        feeLoader: async () => ({
          rate: 0.07,
          exponent: 1,
          rebateRate: 0.2,
        }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks(0.6, 0.6);
    books[0]!.bids = [];
    await trader.observeMarket(testEvent(), books);
    await trader.placeBuy(opportunity(books[0]!, "low-bid", 0.4, 1));
    await trader.placeBuy(opportunity(books[0]!, "high-bid", 0.45, 1));

    await trader.ingestMarketEvent({
      event_type: "last_trade_price",
      asset_id: "up-token",
      side: "SELL",
      price: "0.40",
      size: "1",
      timestamp: "maker-priority",
    });

    const state = trader.snapshot();
    const makerFill = state.fills.find((fill) => fill.liquidity === "maker");
    assert.equal(makerFill?.price, 0.45);
    assert.equal(makerFill?.orderId, state.orders[1]?.id);
    assert.equal(makerFill?.makerFeeEquivalent, 0.01733);
    assert.equal(makerFill?.estimatedMakerRebate, 0.00347);
    assert.equal(state.orders[0]?.status, "open");
    assert.equal(state.orders[1]?.status, "filled");
    await trader.ingestMarketEvent({
      event_type: "market_resolved",
      winning_asset_id: "up-token",
    });
    const settlement = trader.snapshot().settlements[0];
    assert.equal(settlement?.estimatedMakerRebate, 0.00347);
    assert.equal(settlement?.realizedPnl, 0.55);
    assert.equal(settlement?.adjustedPnl, 0.55347);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a passively selected GTC order can become a taker after a book move", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-gtc-race-"));
  try {
    const trader = new PaperTrader(
      testConfig({ paperStatePath: directory }),
      {
        stream: fakeStream,
        feeLoader: async () => ({
          rate: 0.07,
          exponent: 1,
          rebateRate: 0.2,
        }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks(0.51, 0.51);
    await trader.observeMarket(testEvent(), books);

    await trader.ingestMarketEvent({
      event_type: "price_change",
      price_changes: [
        {
          asset_id: "up-token",
          side: "SELL",
          price: "0.44",
          size: "90",
        },
      ],
    });
    await trader.placeBuy(opportunity(books[0]!, "moved-book", 0.45, 90));

    const state = trader.snapshot();
    assert.equal(state.fills[0]?.liquidity, "taker");
    assert.equal(state.fills[0]?.price, 0.44);
    assert.ok((state.fills[0]?.fee ?? 0) > 0);
    assert.equal(state.fills[0]?.estimatedMakerRebate, 0);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper executor mirrors live post-only rejection, cancellation, and FAK remainder handling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-live-parity-"));
  try {
    const trader = new PaperTrader(
      testConfig({
        strategyMode: "odahoa_ladder_2",
        paperStatePath: directory,
      }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0.07, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks(0.44, 0.6);
    books[1]!.asks = [
      { price: 0.6, size: 2 },
      { price: 0.62, size: 10 },
    ];
    await trader.observeMarket(testEvent(), books);

    const postOnly = {
      ...opportunity(books[0]!, "post-only", 0.45, 5),
      strategyMode: "odahoa_ladder_2" as const,
      orderPolicy: "post_only" as const,
      pairLockRole: "opening" as const,
    };
    const rejected = await trader.placeBuy(postOnly);
    assert.equal(rejected.accepted, false);
    assert.equal(trader.snapshot().orders.length, 0);

    books[0]!.bestAsk = 0.5;
    books[0]!.asks = [{ price: 0.5, size: 10 }];
    await trader.observeMarket(testEvent(), books);
    const resting = await trader.placeBuy(postOnly);
    assert.equal(resting.accepted, true);
    assert.equal(trader.snapshot().orders[0]?.status, "open");
    await trader.cancelOrders([trader.snapshot().orders[0]!.id]);
    assert.equal(trader.snapshot().orders[0]?.status, "cancelled");

    const fak = await trader.placeBuy({
      ...opportunity(books[1]!, "fak", 0.6, 5),
      strategyMode: "odahoa_ladder_2",
      orderPolicy: "fak",
      pairLockRole: "completion_taker",
      pairLockSourceFillId: "source-fill",
      pairLockEntryPrice: 0.35,
    });
    assert.equal(fak.accepted, true);
    const fakOrder = trader.snapshot().orders[1]!;
    assert.equal(fakOrder.status, "cancelled");
    assert.equal(fakOrder.remainingSize, 3);
    const fakFill = trader.snapshot().fills[0]!;
    assert.equal(fakFill.size, 2);
    assert.equal(fakFill.price, 0.6);
    assert.equal(fakFill.liquidity, "taker");
    assert.ok(fakFill.fee > 0);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper FOK fills the exact size or fills nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-fok-"));
  try {
    const trader = new PaperTrader(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
        paperStartingUsdc: 100,
      }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0.07, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks(0.4, 0.6);
    books[1]!.asks = [
      { price: 0.6, size: 2 },
      { price: 0.62, size: 10 },
    ];
    await trader.observeMarket(testEvent(), books);

    await trader.placeBuy({
      ...opportunity(books[1]!, "fok-insufficient", 0.6, 5),
      strategyMode: "ladder_v6",
      orderPolicy: "fok",
    });
    let state = trader.snapshot();
    assert.equal(state.orders[0]?.status, "cancelled");
    assert.equal(state.orders[0]?.remainingSize, 5);
    assert.equal(state.fills.length, 0);

    await trader.placeBuy({
      ...opportunity(books[1]!, "fok-complete", 0.62, 5),
      strategyMode: "ladder_v6",
      orderPolicy: "fok",
    });
    state = trader.snapshot();
    assert.equal(state.orders[1]?.status, "filled");
    assert.equal(state.orders[1]?.remainingSize, 0);
    assert.equal(
      state.fills.reduce((sum, fill) => sum + fill.size, 0),
      5,
    );
    assert.ok(state.fills.every((fill) => fill.liquidity === "taker"));
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper market events wake V6 immediately after a maker fill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-v6-wake-"));
  try {
    const trader = new PaperTrader(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
      }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0.07, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks(0.5, 0.6);
    books[0]!.bids = [];
    await trader.observeMarket(testEvent(), books);
    await trader.placeBuy({
      ...opportunity(books[0]!, "v6-opening", 0.1, 20),
      strategyMode: "ladder_v6",
      orderPolicy: "post_only",
      pairId: "ladder-v6:opening:0.10",
      pairLockRole: "opening",
    });

    const wakeFillCounts: number[] = [];
    trader.setExecutionWakeHandler((marketSlug) => {
      wakeFillCounts.push(
        trader.getMarketExecutionSnapshot(marketSlug)?.fills.length ?? -1,
      );
    });
    await trader.ingestMarketEvent({
      event_type: "last_trade_price",
      asset_id: "up-token",
      side: "SELL",
      price: "0.1",
      size: "20",
      timestamp: "1767225600",
    });
    assert.deepEqual(wakeFillCounts, [1]);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper Kalshi book batches update both outcomes before one execution wake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-atomic-book-"));
  try {
    const trader = new PaperTrader(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v7",
        paperStatePath: directory,
      }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0.07, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const event = testEvent();
    event.market.externalMarketId = "KXBTC15M-TEST";
    event.market.id = "KXBTC15M-TEST";
    event.market.clobTokenIds = JSON.stringify([
      "KXBTC15M-TEST::yes",
      "KXBTC15M-TEST::no",
    ]);
    const books = testBooks();
    books[0]!.tokenId = "KXBTC15M-TEST::yes";
    books[1]!.tokenId = "KXBTC15M-TEST::no";
    await trader.observeMarket(event, books);
    const observed: Array<Array<number | null>> = [];
    trader.setExecutionWakeHandler((marketSlug) => {
      observed.push(
        trader
          .getMarketExecutionSnapshot(marketSlug)!
          .books.map((book) => book.bestAsk),
      );
    });
    await trader.ingestMarketEvent({
      event_type: "market_books",
      market_ticker: "KXBTC15M-TEST",
      books: [
        {
          event_type: "book",
          asset_id: "KXBTC15M-TEST::yes",
          bids: [{ price: "0.31", size: "10" }],
          asks: [{ price: "0.68", size: "10" }],
        },
        {
          event_type: "book",
          asset_id: "KXBTC15M-TEST::no",
          bids: [{ price: "0.32", size: "10" }],
          asks: [{ price: "0.69", size: "10" }],
        },
      ],
    });
    assert.deepEqual(observed, [[0.68, 0.69]]);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper settlement pays the winning shares and persists across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-settle-"));
  try {
    const config = testConfig({ paperStatePath: directory });
    const trader = new PaperTrader(config, {
      stream: fakeStream,
      feeLoader: async () => ({ rate: 0, exponent: 1 }),
      settlementLoader: async () => null,
    });
    await trader.init();
    const books = testBooks();
    books[0]!.asks = [{ price: 0.4, size: 3 }];
    await trader.observeMarket(testEvent(), books);
    await trader.placeBuy(opportunity(books[0]!, "winner", 0.45, 2.23));
    await trader.ingestMarketEvent({
      event_type: "market_resolved",
      winning_asset_id: "up-token",
    });

    const settled = trader.snapshot();
    assert.equal(settled.settlements.length, 1);
    assert.equal(settled.settlements[0]?.payout, 2.23);
    assert.equal(settled.settlements[0]?.realizedPnl, 1.338);
    assert.equal(settled.cash, 101.338);
    await trader.close();

    const restarted = new PaperTrader(config, {
      stream: fakeStream,
      feeLoader: async () => ({ rate: 0, exponent: 1 }),
      settlementLoader: async () => null,
    });
    await restarted.init();
    assert.equal(restarted.snapshot().settlements.length, 1);
    const duplicate = await restarted.placeBuy(
      opportunity(books[0]!, "winner", 0.45, 2.23),
    );
    assert.equal(
      (duplicate.response as { duplicate: boolean }).duplicate,
      true,
    );
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper settlement also handles the opposite outcome winning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-other-winner-"));
  try {
    const trader = new PaperTrader(
      testConfig({ paperStatePath: directory }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks();
    books[1]!.asks = [{ price: 0.5, size: 2 }];
    await trader.observeMarket(testEvent(), books);
    await trader.placeBuy(opportunity(books[1]!, "down-winner", 0.55, 2));
    await trader.ingestMarketEvent({
      event_type: "market_resolved",
      winning_asset_id: "down-token",
    });
    assert.equal(trader.snapshot().settlements[0]?.winningOutcome, "Down");
    assert.equal(trader.snapshot().settlements[0]?.payout, 2);
    assert.equal(trader.snapshot().settlements[0]?.realizedPnl, 1);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("simultaneous markets cannot overspend the shared paper balance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-shared-cash-"));
  try {
    const trader = new PaperTrader(
      testConfig({
        paperStatePath: directory,
        paperStartingUsdc: 10,
        ladderMaxUsdcPerMarket: 65,
      }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const adaEvent = eventFor("ada");
    const btcEvent = eventFor("btc");
    const adaBooks = booksForAsset("ada");
    const btcBooks = booksForAsset("btc");
    await Promise.all([
      trader.observeMarket(adaEvent, adaBooks),
      trader.observeMarket(btcEvent, btcBooks),
    ]);

    const results = await Promise.allSettled([
      trader.placeBuy({
        ...opportunity(adaBooks[0]!, "ada-opening", 0.4, 15),
        event: adaEvent,
        token: adaBooks[0]!,
        orderPolicy: "post_only",
        capitalEffect: "increase",
      }),
      trader.placeBuy({
        ...opportunity(btcBooks[0]!, "btc-opening", 0.4, 15),
        event: btcEvent,
        token: btcBooks[0]!,
        orderPolicy: "post_only",
        capitalEffect: "increase",
      }),
    ]);

    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.equal(trader.snapshot().orders.length, 1);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("per-market caps are independent and never block a reducing hedge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-market-cap-"));
  try {
    const trader = new PaperTrader(
      testConfig({
        paperStatePath: directory,
        paperStartingUsdc: 100,
        ladderMaxUsdcPerMarket: 5,
      }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const adaEvent = eventFor("ada");
    const btcEvent = eventFor("btc");
    const adaBooks = booksForAsset("ada");
    const btcBooks = booksForAsset("btc");
    await trader.observeMarket(adaEvent, adaBooks);
    await trader.observeMarket(btcEvent, btcBooks);

    const adaOpening = await trader.placeBuy({
      ...opportunity(adaBooks[0]!, "ada-cap-opening", 0.4, 10),
      event: adaEvent,
      token: adaBooks[0]!,
      orderPolicy: "post_only",
      capitalEffect: "increase",
    });
    const btcOpening = await trader.placeBuy({
      ...opportunity(btcBooks[0]!, "btc-cap-opening", 0.4, 10),
      event: btcEvent,
      token: btcBooks[0]!,
      orderPolicy: "post_only",
      capitalEffect: "increase",
    });
    assert.equal(adaOpening.accepted, true);
    assert.equal(btcOpening.accepted, true);

    const blocked = await trader.placeBuy({
      ...opportunity(adaBooks[0]!, "ada-cap-blocked", 0.2, 10),
      event: adaEvent,
      token: adaBooks[0]!,
      orderPolicy: "post_only",
      capitalEffect: "increase",
    });
    assert.equal(blocked.accepted, false);
    assert.equal(
      (blocked.response as { reason: string }).reason,
      "per_market_cap",
    );

    const hedge = await trader.placeBuy({
      ...opportunity(adaBooks[1]!, "ada-cap-hedge", 0.4, 10),
      event: adaEvent,
      token: adaBooks[1]!,
      orderPolicy: "post_only",
      capitalEffect: "reduce",
    });
    assert.equal(hedge.accepted, true);
    assert.equal(
      trader.getMarketExecutionSnapshot(adaEvent.slug)
        ?.capitalCommitted,
      8,
    );
    assert.equal(
      trader.getMarketExecutionSnapshot(btcEvent.slug)
        ?.capitalCommitted,
      4,
    );
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper execution amends rescue orders and can flatten owned inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-v9-lifecycle-"));
  try {
    const trader = new PaperTrader(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v9",
        paperStatePath: directory,
        paperStartingUsdc: 100,
      }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0.07, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks(0.4, 0.6);
    await trader.observeMarket(testEvent(), books);

    await trader.placeBuy({
      ...opportunity(books[0]!, "v9-cheap", 0.1, 40),
      strategyMode: "ladder_v9",
      pairId: "ladder-v9:cheap-entry",
      orderPolicy: "post_only",
    });
    const cheapOrder = trader.snapshot().orders[0]!;
    const amended = await trader.amendOrder(cheapOrder.id, {
      ...opportunity(books[0]!, "v9-amend-12", 0.12, 20),
      strategyMode: "ladder_v9",
      pairId: "ladder-v9:amend-rescue-12",
      orderPolicy: "gtc",
    });
    assert.equal(amended.accepted, true);
    assert.equal(trader.snapshot().orders[0]?.limitPrice, 0.12);
    assert.equal(trader.snapshot().orders[0]?.remainingSize, 20);
    await trader.cancelOrders([cheapOrder.id]);

    const bought = await trader.placeBuy({
      ...opportunity(books[0]!, "v9-owned", 0.4, 5),
      strategyMode: "ladder_v9",
      pairId: "ladder-v9:test-owned",
      orderPolicy: "fak",
    });
    assert.equal((bought.response as { filledSize: number }).filledSize, 5);
    const sold = await trader.placeSell({
      ...opportunity(books[0]!, "v9-flatten", 0.39, 5),
      strategyMode: "ladder_v9",
      pairId: "ladder-v9:flatten-cheap-1",
      orderPolicy: "fak",
    });
    assert.equal((sold.response as { filledSize: number }).filledSize, 5);
    const state = trader.snapshot();
    assert.equal(state.positions.find((item) => item.tokenId === "up-token")?.shares, 0);
    assert.equal(state.fills.at(-1)?.side, "SELL");
    assert.equal(
      trader.getMarketExecutionSnapshot(testEvent().slug)?.openCommitted,
      0,
    );
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unrelated market trades do not rewrite paper execution history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-noop-trade-"));
  try {
    const trader = new PaperTrader(
      testConfig({ paperStatePath: directory }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0.07, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    await trader.observeMarket(testEvent(), testBooks());

    await trader.ingestMarketEvent({
      event_type: "last_trade_price",
      asset_id: "up-token",
      side: "SELL",
      price: "0.4",
      size: "5",
      timestamp: "1000",
      transaction_hash: "unrelated-trade",
    });

    assert.deepEqual(trader.snapshot().seenEventKeys, []);
    assert.deepEqual(trader.snapshot().fills, []);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
