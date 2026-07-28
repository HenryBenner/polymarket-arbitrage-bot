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
    await trader.placeBuy(opportunity(books[0]!, "winner", 0.45, 2));
    await trader.ingestMarketEvent({
      event_type: "market_resolved",
      winning_asset_id: "up-token",
    });

    const settled = trader.snapshot();
    assert.equal(settled.settlements.length, 1);
    assert.equal(settled.settlements[0]?.payout, 2);
    assert.equal(settled.settlements[0]?.realizedPnl, 1.2);
    assert.equal(settled.cash, 101.2);
    await trader.close();

    const restarted = new PaperTrader(config, {
      stream: fakeStream,
      feeLoader: async () => ({ rate: 0, exponent: 1 }),
      settlementLoader: async () => null,
    });
    await restarted.init();
    assert.equal(restarted.snapshot().settlements.length, 1);
    const duplicate = await restarted.placeBuy(
      opportunity(books[0]!, "winner", 0.45, 2),
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
