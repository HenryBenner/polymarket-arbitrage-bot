import assert from "node:assert/strict";
import test from "node:test";
import { planLadderV15 } from "../src/ladder-v15.js";
import { v15CycleReports, v15Exposure, v15Inventory } from "../src/ladder-v15-inventory.js";
import { validateTradingConfig } from "../src/config.js";
import type { MarketExecutionSnapshot, PaperFill, PaperOrder } from "../src/types.js";
import { testConfig, testEvent, testBooks } from "./helpers.js";

export function fixture() {
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v15", kalshiApiKeyId: "test", kalshiPrivateKeyPem: "test" });
  const event = testEvent();
  event.market.exchange = "kalshi";
  event.market.seriesTicker = "KXBTC15M";
  const books = testBooks(0.12, 0.88, 0.01);
  books[0]!.bestBid = 0.09; books[0]!.bids = [{ price: 0.09, size: 100 }];
  books[1]!.bestBid = 0.87; books[1]!.bids = [{ price: 0.87, size: 100 }];
  books.forEach(b => b.asks[0]!.size = 100);
  const snapshot: MarketExecutionSnapshot = { marketSlug: event.slug, books, orders: [], openOrders: [], fills: [], positions: [],
    capitalUsed: 0, openCommitted: 0, capitalCommitted: 0, availableCash: 1,
    totalFees: 0, estimatedMakerRebate: 0, takerFeeRate: 0.07, makerFeeRate: 0, takerFeeExponent: 1, settledPnl: null };
  return { config, event, snapshot };
}

function entry(snapshot: MarketExecutionSnapshot, remaining = 700, size = 40) {
  const event = testEvent();
  const at = new Date((event.windowEnd - remaining) * 1000).toISOString();
  const order: PaperOrder = { id: "entry", pairId: "ladder-v15:1:entry:", tradeKey: "entry", marketSlug: event.slug,
    marketTitle: event.title, conditionId: "condition", tokenId: "up-token", outcome: "Up", limitPrice: 0.1,
    originalSize: size, remainingSize: 0, queueAhead: 0, status: "filled", createdAt: at, submittedMinutesLeft: remaining / 60 };
  const fill: PaperFill = { id: "fill", orderId: order.id, marketSlug: event.slug, tokenId: order.tokenId,
    outcome: "Up", price: 0.1, size, fee: 0, liquidity: "maker", timestamp: at };
  snapshot.orders = [order]; snapshot.fills = [fill];
}

test("V15 entry boundaries cover 15-2 and startup mid-window", () => {
  const { config, event, snapshot } = fixture();
  for (const remaining of [900, 899, 650, 300, 121]) {
    const plan = planLadderV15(config, event, snapshot, 0, event.windowEnd - remaining);
    assert.equal(plan.opportunities.length, 1, String(remaining));
    assert.equal(plan.opportunities[0]!.orderPolicy, "post_only");
  }
  for (const remaining of [901, 120, 119, 0]) assert.equal(planLadderV15(config, event, snapshot, 0, event.windowEnd - remaining).opportunities.length, 0);
  assert.equal(planLadderV15(config, event, snapshot, 120, event.windowEnd - 700).opportunities.length, 0);
  assert.equal(planLadderV15(config, event, snapshot, 110, event.windowEnd - 700).opportunities[0]!.size, 10);
  snapshot.books[0]!.bestAsk = 0.1; snapshot.books[0]!.asks = [];
  assert.equal(planLadderV15(config, event, snapshot, 0, event.windowEnd - 700).opportunities.length, 0);
});

test("V15 only completes confirmed inventory and cancels partial entry first", () => {
  const { config, event, snapshot } = fixture(); entry(snapshot, 700, 10);
  const order = snapshot.orders[0]!; order.remainingSize = 30; order.status = "partial";
  snapshot.openOrders = [order];
  assert.equal(v15Exposure(snapshot), 40);
  const plan = planLadderV15(config, event, snapshot, 40, event.windowEnd - 699);
  assert.deepEqual(plan.cancelOrderIds, [order.id]); assert.equal(plan.opportunities.length, 0);
  snapshot.fills = [];
  assert.equal(planLadderV15(config, event, snapshot, 30, event.windowEnd - 699).opportunities.length, 0);
});

test("V15 fee-safe makers converge; FOK uses full executable depth", () => {
  const { config, event, snapshot } = fixture(); entry(snapshot);
  const plan = planLadderV15(config, event, snapshot, 40, event.windowEnd - 699);
  const maker = plan.opportunities[0]!;
  assert.equal(maker.orderPolicy, "post_only"); assert.equal(maker.price, 0.8);
  const resting = { ...snapshot.orders[0]!, id: "maker", tokenId: "down-token", pairId: maker.pairId,
    limitPrice: maker.price, originalSize: 40, remainingSize: 40, status: "open" as const };
  snapshot.orders = [...snapshot.orders, resting]; snapshot.openOrders = [resting];
  assert.equal(planLadderV15(config, event, snapshot, 40, event.windowEnd - 698).cancelOrderIds.length, 0);
  snapshot.books[1]!.asks = [{ price: 0.84, size: 20 }, { price: 0.85, size: 20 }];
  snapshot.books[1]!.bestAsk = 0.84;
  assert.deepEqual(planLadderV15(config, event, snapshot, 40, event.windowEnd - 698).cancelOrderIds, ["maker"]);
  snapshot.openOrders = [];
  const fok = planLadderV15(config, event, snapshot, 40, event.windowEnd - 698).opportunities[0]!;
  assert.equal(fok.orderPolicy, "fok"); assert.equal(fok.price, 0.85);
  snapshot.books[1]!.asks = [{ price: 0.84, size: 1 }];
  assert.equal(planLadderV15(config, event, snapshot, 40, event.windowEnd - 698).opportunities[0]!.orderPolicy, "post_only");
});

test("V15 cleanup takes better partial sale; deadlines cancel even on invalid books", () => {
  const { config, event, snapshot } = fixture(); entry(snapshot);
  snapshot.books[0]!.bids = [{ price: 0.3, size: 7 }];
  snapshot.books[1]!.asks = [{ price: 0.95, size: 100 }];
  const plan = planLadderV15(config, event, snapshot, 40, event.windowEnd - 30);
  assert.equal(plan.flattenOpportunities[0]!.size, 7);
  assert.equal(plan.flattenOpportunities[0]!.orderPolicy, "fak");
  snapshot.openOrders = [{ ...snapshot.orders[0]!, remainingSize: 5, status: "partial" }];
  snapshot.marketDataValid = false;
  assert.deepEqual(planLadderV15(config, event, snapshot, 45, event.windowEnd - 120).cancelOrderIds, ["entry"]);
});

test("V15 retry exhaustion rests maker and resets on depth change; state survives JSON restart", () => {
  const { config, event, snapshot } = fixture(); entry(snapshot);
  snapshot.books[1]!.asks = [{ price: 0.8, size: 40 }]; snapshot.books[1]!.bestAsk = 0.8;
  const now = event.windowEnd - 600;
  const first = planLadderV15(config, event, snapshot, 40, now).opportunities[0]!;
  snapshot.orders = [...snapshot.orders, ...Array.from({ length: 4 }, (_, i) => ({ ...snapshot.orders[0]!,
    id: `attempt-${i}`, pairId: first.pairId, tokenId: "down-token", status: "cancelled" as const,
    createdAt: new Date((now - 1) * 1000).toISOString() }))];
  assert.equal(planLadderV15(config, event, snapshot, 40, now).opportunities[0]!.orderPolicy, "post_only");
  snapshot.books[1]!.asks[0]!.size = 50;
  const restored = JSON.parse(JSON.stringify(snapshot));
  assert.equal(planLadderV15(config, event, restored, 40, now).opportunities[0]!.orderPolicy, "fok");
});

test("V15 cycle timing follows first fill through sales, completion, settlement and deduplication", () => {
  const { event, snapshot } = fixture(); entry(snapshot, 660, 40);
  const fill = snapshot.fills[0]!;
  snapshot.fills = [fill, { ...fill }];
  const buy = { ...snapshot.orders[0]!, id: "complete", pairId: "ladder-v15:1:completion-taker:", tokenId: "down-token" };
  const sell = { ...snapshot.orders[0]!, id: "sell", pairId: "ladder-v15:1:cleanup-sale:", side: "SELL" as const };
  snapshot.orders = [...snapshot.orders, buy, sell];
  snapshot.fills = [...snapshot.fills,
    { ...fill, id: "completion", orderId: buy.id, tokenId: "down-token", size: 20, price: 0.8 },
    { ...fill, id: "sale", orderId: sell.id, side: "SELL", size: 10, price: 0.2 }];
  const report = v15CycleReports(snapshot, event.slug, "KXBTC15M", { marketSlug: event.slug,
    winningTokenId: "up-token", winningOutcome: "Up", payout: 30, totalCost: 18, totalFees: 0,
    realizedPnl: 12, settledAt: new Date(event.windowEnd * 1000).toISOString() })[0]!;
  assert.equal(report.bucket, "15-10"); assert.equal(report.entryShares, 40);
  assert.equal(report.pairedShares, 20); assert.equal(report.soldShares, 10);
  assert.equal(report.realizedPnl, 12); assert.equal(report.holdingSeconds, 660);
  assert.equal(v15Inventory(JSON.parse(JSON.stringify(snapshot)))[0]!.firstFillAt, fill.timestamp);
});

test("V15 config rejects live mode, invalid windows and nonfinite limits", () => {
  const { config } = fixture(); validateTradingConfig(config);
  for (const overrides of [{ executionMode: "live" as const }, { ladderV15EntryMinutesMin: 15 },
    { ladderV15MaxUnmatchedPortfolio: Infinity }, { minutesBeforeCloseMin: 2 }]) {
    assert.throws(() => validateTradingConfig({ ...config, ...overrides }), /V15|v15/);
  }
});
