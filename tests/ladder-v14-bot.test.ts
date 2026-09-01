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

test("V14 global queue allocates positive-EV orders across configured series", async () => {
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
