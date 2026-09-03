import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReverseBot, type MarketSource } from "../src/bot.js";
import type {
  MarketExecutionSnapshot,
  OrderExecutor,
  OrderResult,
  PaperFill,
  PaperOrder,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "../src/types.js";
import { testConfig } from "./helpers.js";

function market(series: string, asset: string, start: number): UpDownEvent {
  const slug = `${asset.toLowerCase()}-updown-15m-${start}`;
  return {
    title: `${asset} Up or Down`,
    slug,
    windowStart: start,
    windowEnd: start + 900,
    market: {
      id: `${series}-${start}`,
      externalMarketId: `${series}-${start}`,
      exchange: "kalshi",
      seriesTicker: series,
      question: `${asset} Up or Down?`,
      conditionId: `${series}-${start}`,
      slug,
      clobTokenIds: JSON.stringify([`${series}-yes`, `${series}-no`]),
      outcomes: JSON.stringify(["Up", "Down"]),
      negRisk: false,
      orderPriceMinTickSize: 0.1,
      active: true,
      closed: false,
    },
  };
}

function books(event: UpDownEvent): TokenBook[] {
  const series = event.market.seriesTicker!;
  return [
    {
      tokenId: `${series}-yes`, outcome: "Up", outcomeIndex: 0,
      bestBid: 0.4, bestAsk: 0.5,
      bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.5, size: 100 }],
      minOrderSize: 1,
    },
    {
      tokenId: `${series}-no`, outcome: "Down", outcomeIndex: 1,
      bestBid: 0.4, bestAsk: 0.5,
      bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.5, size: 100 }],
      minOrderSize: 1,
    },
  ];
}

class V14Executor implements OrderExecutor {
  readonly snapshots = new Map<string, MarketExecutionSnapshot>();
  readonly cancelBatches: string[][] = [];
  fillImmediateOrders = true;
  private telemetry?: (event: Record<string, unknown>) => void | Promise<void>;
  private orderNumber = 0;

  async init(): Promise<void> {}

  setMarketTelemetryHandler(
    handler: (event: Record<string, unknown>) => void | Promise<void>,
  ): void {
    this.telemetry = handler;
  }

  async emit(event: Record<string, unknown>): Promise<void> {
    await this.telemetry?.(event);
  }

  async observeMarket(event: UpDownEvent, nextBooks: TokenBook[]): Promise<void> {
    const existing = this.snapshots.get(event.slug);
    if (existing) {
      existing.books = nextBooks;
      return;
    }
    this.snapshots.set(event.slug, {
      marketSlug: event.slug,
      marketDataValid: true,
      executionPending: false,
      capitalConstraint: false,
      orders: [],
      openOrders: [],
      fills: [],
      positions: [],
      books: nextBooks,
      capitalUsed: 0,
      openCommitted: 0,
      capitalCommitted: 0,
      availableCash: Number.MAX_SAFE_INTEGER,
      totalFees: 0,
      estimatedMakerRebate: 0,
      takerFeeRate: 0,
      makerFeeRate: 0,
      takerFeeExponent: 1,
      settledPnl: null,
    });
  }

  getMarketExecutionSnapshot(slug: string): Readonly<MarketExecutionSnapshot> | null {
    return this.snapshots.get(slug) ?? null;
  }

  async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
    const snapshot = this.snapshots.get(opportunity.event.slug)!;
    const orders = snapshot.orders as PaperOrder[];
    const order: PaperOrder = {
      id: `v14-order-${++this.orderNumber}`,
      tradeKey: opportunity.tradeKey,
      marketSlug: opportunity.event.slug,
      marketTitle: opportunity.event.title,
      conditionId: opportunity.event.market.conditionId,
      tokenId: opportunity.token.tokenId,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      originalSize: opportunity.size,
      remainingSize: opportunity.size,
      queueAhead: 10,
      status: "open",
      side: "BUY",
      pairId: opportunity.pairId,
      orderPolicy: opportunity.orderPolicy,
      pairLockRole: opportunity.pairLockRole,
      createdAt: new Date().toISOString(),
    };
    orders.push(order);
    if (opportunity.orderPolicy === "fak") {
      order.status = this.fillImmediateOrders ? "filled" : "cancelled";
      order.remainingSize = 0;
      if (this.fillImmediateOrders) (snapshot.fills as PaperFill[]).push({
        id: `${order.id}-fill`, orderId: order.id, marketSlug: order.marketSlug,
        tokenId: order.tokenId, outcome: order.outcome, price: order.limitPrice,
        size: order.originalSize, fee: 0, liquidity: "taker", side: "BUY",
        timestamp: new Date().toISOString(),
      });
    }
    snapshot.openOrders = orders.filter((candidate) => candidate.status === "open");
    snapshot.openCommitted = orders.reduce(
      (sum, candidate) => sum + candidate.limitPrice * candidate.remainingSize,
      0,
    );
    snapshot.capitalCommitted = snapshot.openCommitted;
    return {
      dryRun: true,
      accepted: true,
      tokenId: order.tokenId,
      side: "BUY",
      price: order.limitPrice,
      size: order.originalSize,
    };
  }

  async cancelOrders(ids: string[]): Promise<void> {
    this.cancelBatches.push([...ids]);
    for (const snapshot of this.snapshots.values()) {
      const orders = snapshot.orders as PaperOrder[];
      for (const order of orders) {
        if (ids.includes(order.id)) order.status = "cancelled";
      }
      snapshot.openOrders = orders.filter((order) => order.status === "open");
    }
  }

  async amendOrder(id: string, opportunity: TradeOpportunity): Promise<OrderResult> {
    const snapshot = this.snapshots.get(opportunity.event.slug)!;
    const order = (snapshot.orders as PaperOrder[]).find((candidate) => candidate.id === id)!;
    order.tradeKey = opportunity.tradeKey;
    order.limitPrice = opportunity.price;
    order.originalSize = opportunity.size;
    order.remainingSize = opportunity.size;
    return {
      dryRun: true,
      accepted: true,
      tokenId: order.tokenId,
      side: "BUY",
      price: order.limitPrice,
      size: order.originalSize,
    };
  }
}

test("V14 global queue allocates volume-first pair grids across configured series", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v14-global-"));
  try {
    const start = Math.floor(Date.now() / 1_000) - 300;
    const events = [market("KXBTC15M", "BTC", start), market("KXSOL15M", "SOL", start)];
    const bySlug = new Map(events.map((event) => [event.slug, books(event)]));
    const scanner: MarketSource = {
      scan: async () => events,
      getTokenBooks: async (event) => bySlug.get(event.slug)!,
    };
    const executor = new V14Executor();
    const bot = new ReverseBot(testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v14",
      ladderV14VolumeFirstMode: true,
      executionMode: "paper",
      paperStatePath: directory,
      kalshiSeriesTickers: ["KXBTC15M", "KXSOL15M"],
    }), executor, scanner);
    await bot.init();
    const timestamp = Date.now();
    for (const event of events) {
      for (const book of bySlug.get(event.slug)!) {
        await executor.emit({
          event_type: "last_trade_price",
          asset_id: book.tokenId,
          side: "SELL",
          price: "0.4",
          size: "100",
          timestamp,
        });
      }
    }
    await bot.runOnce();
    for (const event of events) {
      const orders = executor.snapshots.get(event.slug)?.openOrders ?? [];
      assert.ok(orders.length > 0, `${event.market.seriesTicker} received no V14 orders`);
      const keys = orders.map((order) => `${order.tokenId}|${order.limitPrice}`);
      assert.equal(new Set(keys).size, keys.length);
      assert.ok(orders.every((order) => order.pairId?.startsWith("ladder-v14:")));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V14 final cleanup wakes a quiet book, cancels maker, hedges, and stays balanced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v14-deadline-"));
  const event = market("KXETH15M", "ETH", Math.floor(Date.now() / 1000) - 300);
  event.windowEnd = Date.now() / 1000 + 31.5;
  const executor = new V14Executor();
  let bookReads = 0;
  const bot = new ReverseBot(testConfig({
    exchange: "kalshi", strategyMode: "ladder_v14", ladderV14VolumeFirstMode: true,
    executionMode: "paper", paperStatePath: directory, ladderV14QuoteLifetimeSeconds: 1,
  }), executor, {
    scan: async () => [event],
    getTokenBooks: async () => { bookReads += 1; return books(event); },
  });
  try {
    await bot.init();
    await bot.runOnce();
    const state = executor.snapshots.get(event.slug)!;
    const opening = state.openOrders.find((order) => order.outcome === "Up")!;
    opening.status = "filled";
    opening.remainingSize = 0;
    state.openOrders = state.openOrders.filter((order) => order.id !== opening.id);
    state.fills = [{
      id: "initial-fill", orderId: opening.id, marketSlug: event.slug,
      tokenId: opening.tokenId, outcome: "Up", price: 0.6, size: opening.originalSize,
      fee: 0, liquidity: "maker", side: "BUY", timestamp: new Date().toISOString(),
    }];
    const oldGridIds = state.openOrders.map((order) => order.id);
    await bot.runOnce();
    assert.deepEqual(executor.cancelBatches[0], oldGridIds);
    assert.equal(state.openOrders.length, 1);
    const maker = state.openOrders[0]!;
    assert.ok(maker.pairId?.startsWith("ladder-v14:repair-maker:"));
    assert.equal(maker.outcome, "Down");
    assert.equal(maker.remainingSize, opening.originalSize);
    const readsBeforeDeadline = bookReads;
    // No book event or runOnce call: the bounded repair timer drives this.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(bookReads, readsBeforeDeadline);
    assert.equal(maker.status, "cancelled");
    const hedges = state.orders.filter((order) => order.pairId === "ladder-v14:repair-taker");
    assert.ok(hedges.length > 0);
    assert.ok(hedges.every((order) => order.status === "filled"));
    assert.equal(hedges.reduce((sum, order) => sum + order.originalSize, 0), opening.originalSize);
    assert.equal(state.openOrders.length, 0, "no new grid during final cleanup");
  } finally {
    // Cancel a pending timer even if an assertion fails before the deadline.
    (bot as unknown as { scheduleLadderV14RepairWake(deadline: undefined): void })
      .scheduleLadderV14RepairWake(undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await rm(directory, { recursive: true, force: true });
  }
});

test("V14 zero-fill immediate repair waits for fresh input instead of busy-looping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v14-empty-ioc-"));
  const event = market("KXBTC15M", "BTC", Math.floor(Date.now() / 1000) - 300);
  const executor = new V14Executor();
  executor.fillImmediateOrders = false;
  const bot = new ReverseBot(testConfig({
    exchange: "kalshi", strategyMode: "ladder_v14", ladderV14VolumeFirstMode: true,
    executionMode: "paper", paperStatePath: directory,
  }), executor, { scan: async () => [event], getTokenBooks: async () => books(event) });
  try {
    await bot.init();
    await bot.runOnce();
    const state = executor.snapshots.get(event.slug)!;
    const opening = state.openOrders[0]!;
    opening.status = "filled";
    opening.remainingSize = 0;
    state.openOrders = state.openOrders.filter((order) => order.id !== opening.id);
    state.fills = [{ id: "old-fill", orderId: opening.id, marketSlug: event.slug,
      tokenId: opening.tokenId, outcome: opening.outcome, price: 0.4,
      size: opening.originalSize, fee: 0, liquidity: "maker", side: "BUY",
      timestamp: new Date(Date.now() - 10_000).toISOString() }];
    const timeout = setTimeout(() => { executor.fillImmediateOrders = true; }, 1000);
    try { await bot.runOnce(); } finally { clearTimeout(timeout); }
    const repair = state.orders.filter((order) => order.pairId === "ladder-v14:repair-taker");
    assert.equal(repair.length, 1);
    assert.equal(repair[0]!.status, "cancelled");
    assert.equal(state.fills.length, 1);
  } finally {
    await bot.stop();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await rm(directory, { recursive: true, force: true });
  }
});
