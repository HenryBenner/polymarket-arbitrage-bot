import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderV14ConditionalModel, ladderV14Parameters, type LadderV14ConditionalContext } from "../src/ladder-v14-model.js";
import { ladderV14Inventory, ladderV14SellGuard } from "../src/ladder-v14-inventory.js";
import { planLadderV14, type LadderV14MarketFeatures } from "../src/ladder-v14.js";
import { PaperTrader } from "../src/paper-trader.js";
import type { MarketExecutionSnapshot, PaperFill, PaperOrder, TokenBook, TradeOpportunity } from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

const event = {
  ...testEvent(),
  market: { ...testEvent().market, seriesTicker: "KXBTC15M" },
};

function features(books: readonly TokenBook[]): LadderV14MarketFeatures {
  return {
    eligibleVolumePerSecondByToken: Object.fromEntries(books.map((book) => [book.tokenId, 0])),
    volatilityByToken: Object.fromEntries(books.map((book) => [book.tokenId, 0.01])),
    midpointByToken: Object.fromEntries(books.map((book) => [
      book.tokenId,
      book.bestBid === null || book.bestAsk === null ? null : (book.bestBid + book.bestAsk) / 2,
    ])),
  };
}

function snapshot(
  books: TokenBook[],
  orders: PaperOrder[] = [],
  fills: PaperFill[] = [],
): MarketExecutionSnapshot {
  return {
    marketSlug: event.slug,
    marketDataValid: true,
    executionPending: false,
    capitalConstraint: false,
    orders,
    openOrders: orders.filter((order) => order.status === "open" || order.status === "partial"),
    fills,
    positions: [],
    books,
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: Number.MAX_SAFE_INTEGER,
    totalFees: fills.reduce((sum, fill) => sum + fill.fee, 0),
    estimatedMakerRebate: 0,
    takerFeeRate: 0,
    makerFeeRate: 0,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

function v14Order(
  id: string,
  tokenId: string,
  price: number,
  size: number,
  status: PaperOrder["status"] = "filled",
): PaperOrder {
  return {
    id,
    tradeKey: `ladder-v14:${event.slug}:opening:${id}`,
    marketSlug: event.slug,
    marketTitle: event.title,
    conditionId: event.market.conditionId,
    tokenId,
    outcome: tokenId === "up-token" ? "Up" : "Down",
    limitPrice: price,
    originalSize: size,
    remainingSize: status === "filled" ? 0 : size,
    queueAhead: 0,
    status,
    side: "BUY",
    pairId: "ladder-v14:opening",
    orderPolicy: "post_only",
    pairLockRole: "opening",
    createdAt: new Date((event.windowEnd - 600) * 1_000).toISOString(),
  };
}

function v14Fill(order: PaperOrder, size = order.originalSize): PaperFill {
  return {
    id: `${order.id}-fill`,
    orderId: order.id,
    marketSlug: order.marketSlug,
    tokenId: order.tokenId,
    outcome: order.outcome,
    price: order.limitPrice,
    size,
    fee: 0,
    liquidity: "maker",
    side: "BUY",
    timestamp: new Date((event.windowEnd - 590) * 1_000).toISOString(),
  };
}

const parameters = ladderV14Parameters({
  priorStrength: 5,
  flowWindowSeconds: 60,
  volatilityWindowSeconds: 60,
  finalCleanupSeconds: 30,
});

const baseContext: LadderV14ConditionalContext = {
  series: "KXBTC15M",
  executionMode: "paper",
  side: "Up",
  entryPrice: 0.5,
  currentBid: 0.4,
  currentMid: 0.45,
  priceMoveSinceFill: -0.05,
  volatility: 0.01,
  queueAhead: 10,
  flowPerSecond: 1,
  distanceTicks: 0,
  quantity: 10,
  depth: 20,
  residualAgeSeconds: 60,
  secondsRemaining: 300,
};

test("V14 learns completion cost and failed-completion recovery separately by series", () => {
  const model = new LadderV14ConditionalModel(parameters);
  for (let index = 0; index < 5; index += 1) {
    model.observeHazard("completion", baseContext, 20, true);
    model.observeCompletionCost(baseContext, 0.25);
    model.observeFailedExit(baseContext, 0.1);
  }
  assert.ok(model.expectedCompletionCost(baseContext, 0.8) < 0.6);
  assert.ok(model.expectedFailedExit(baseContext) < 0.3);
  assert.ok(model.estimateCompletion(baseContext, 60).observations > 0);
  assert.equal(
    model.estimateCompletion({ ...baseContext, series: "KXSOL15M" }, 60).observations,
    0,
  );
});

test("V14 conditions deeper maker layers on all more-aggressive fills", () => {
  const books = testBooks(0.45, 0.55);
  books[0]!.bids = [{ price: 0.4, size: 40 }];
  books[1]!.bids = [{ price: 0.5, size: 40 }];
  books[0]!.asks = [{ price: 0.45, size: 100 }];
  books[1]!.asks = [{ price: 0.55, size: 100 }];
  const alwaysPairs = {
    estimateFill: () => ({ probability: 1 }),
    estimateCompletion: () => ({ probability: 1 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: (context: LadderV14ConditionalContext) => context.currentBid ?? 0,
  } as unknown as LadderV14ConditionalModel;
  const plan = planLadderV14(
    testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" }),
    event,
    snapshot(books),
    alwaysPairs,
    features(books),
    event.windowEnd - 600,
  );
  assert.ok(plan.candidates.length > 2);
  assert.equal(plan.candidates[0]!.sweepPrefixShares, 0);
  assert.ok(plan.candidates.some((candidate) => candidate.sweepPrefixShares > 0));
  assert.ok(plan.candidates.every((candidate) => candidate.expectedValue > 0));
});

test("V14 prices conditional passive completion at its maker quote", () => {
  const books = testBooks(0.5, 0.52);
  books[0]!.bids = [{ price: 0.48, size: 100 }];
  books[1]!.bids = [{ price: 0.49, size: 100 }];
  books[0]!.asks = [{ price: 0.5, size: 100 }];
  books[1]!.asks = [{ price: 0.52, size: 100 }];
  const alwaysPairs = {
    estimateFill: () => ({ probability: 1 }),
    estimateCompletion: () => ({ probability: 1 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: (context: LadderV14ConditionalContext) => context.currentBid ?? 0,
  } as unknown as LadderV14ConditionalModel;
  const plan = planLadderV14(
    testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" }),
    event,
    snapshot(books),
    alwaysPairs,
    features(books),
    event.windowEnd - 600,
  );
  const yesAt48 = plan.candidates.find(
    (candidate) => candidate.tokenId === "up-token" && candidate.price === 0.48,
  );
  assert.ok(yesAt48);
  assert.equal(yesAt48.expectedCompletionCost, 0.51);
  assert.ok(yesAt48.expectedValue > 0);
});

test("V14 keeps one aggregate maker order per outcome and price", () => {
  const books = testBooks(0.45, 0.55);
  books[0]!.bids = [{ price: 0.4, size: 40 }];
  books[1]!.bids = [{ price: 0.5, size: 40 }];
  const alwaysPairs = {
    estimateFill: () => ({ probability: 1 }),
    estimateCompletion: () => ({ probability: 1 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: (context: LadderV14ConditionalContext) => context.currentBid ?? 0,
  } as unknown as LadderV14ConditionalModel;
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" });
  const initial = planLadderV14(
    config, event, snapshot(books), alwaysPairs, features(books), event.windowEnd - 600,
  );
  const target = initial.opportunities[0]!;
  const first = v14Order("duplicate-a", target.token.tokenId, target.price, target.size, "open");
  const second = v14Order("duplicate-b", target.token.tokenId, target.price, target.size, "open");
  const reconciled = planLadderV14(
    config,
    event,
    snapshot(books, [first, second]),
    alwaysPairs,
    features(books),
    event.windowEnd - 600,
  );
  assert.deepEqual(reconciled.cancelOrderIds, [second.id]);
  assert.equal(reconciled.managementStage, "reconcile-target-grid-cancellations");
});

test("V14 economically locks a small loss when it beats selling or waiting", () => {
  const books = testBooks(0.3, 0.43);
  books[0]!.bestBid = 0.25;
  books[0]!.bids = [{ price: 0.25, size: 100 }];
  books[1]!.bestBid = 0.4;
  books[1]!.bids = [{ price: 0.4, size: 100 }];
  books[1]!.asks = [{ price: 0.43, size: 100 }];
  const yes = v14Order("yes", "up-token", 0.6, 10);
  const state = snapshot(books, [yes], [v14Fill(yes)]);
  const plan = planLadderV14(
    testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" }),
    event,
    state,
    new LadderV14ConditionalModel(parameters),
    features(books),
    event.windowEnd - 300,
  );
  assert.equal(plan.managementStage, "economic-loss-locking-hedge");
  assert.equal(plan.opportunities[0]?.token.tokenId, "down-token");
  assert.equal(plan.opportunities[0]?.price, 0.43);
  assert.ok((yes.limitPrice + (plan.opportunities[0]?.price ?? 0)) > 1);
});

test("V14 permits waiting before cleanup but removes wait at thirty seconds", () => {
  const books = testBooks(0.3, 0.6);
  books[0]!.bestBid = 0.25;
  books[0]!.bids = [{ price: 0.25, size: 100 }];
  books[1]!.bestAsk = null;
  books[1]!.asks = [];
  books[1]!.bestBid = 0.4;
  const yes = v14Order("cleanup-yes", "up-token", 0.6, 10);
  const state = snapshot(books, [yes], [v14Fill(yes)]);
  const optimisticWait = {
    estimateCompletion: () => ({ probability: 1 }),
    expectedCompletionCost: () => 0.4,
    expectedFailedExit: () => 0.1,
  } as unknown as LadderV14ConditionalModel;
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" });
  const beforeCleanup = planLadderV14(
    config, event, state, optimisticWait, features(books), event.windowEnd - 60,
  );
  assert.equal(beforeCleanup.managementStage, "post-positive-ev-completion");
  const cleanup = planLadderV14(
    config, event, state, optimisticWait, features(books), event.windowEnd - 20,
  );
  assert.equal(cleanup.managementStage, "marginal-residual-sale");
  assert.equal(cleanup.flattenOpportunities[0]?.size, 10);
});

test("V14 inventory sells highest-cost residual lots first and guards IOC sales", () => {
  const books = testBooks(0.5, 0.5);
  const cheap = v14Order("cheap", "up-token", 0.18, 10);
  const risky = v14Order("risky", "up-token", 0.52, 10);
  const state = snapshot(books, [cheap, risky], [v14Fill(cheap), v14Fill(risky)]);
  const inventory = ladderV14Inventory(state, event.windowEnd - 300);
  assert.equal(inventory.residualLots[0]?.entryPrice, 0.52);
  assert.equal(ladderV14SellGuard(state, "up-token", 10), null);
  assert.equal(ladderV14SellGuard(state, "up-token", 21), "sale_exceeds_v14_residual");
});

test("V14 paper mode removes cash and per-market caps without changing bank cash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-v14-unlimited-"));
  try {
    const stream = { subscribe: async () => undefined, close: () => undefined };
    const trader = new PaperTrader(testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v14",
      paperStatePath: directory,
      paperStartingUsdc: 1,
      ladderMaxUsdcPerMarket: 0.1,
    }), { stream, settlementLoader: async () => null });
    await trader.init();
    const books = testBooks(0.5, 0.5);
    await trader.observeMarket(event, books);
    const opportunity: TradeOpportunity = {
      kind: "maker",
      event,
      token: books[0]!,
      price: 0.39,
      size: 100,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: "ladder-v14:unlimited-test",
      strategyMode: "ladder_v14",
      pairId: "ladder-v14:opening",
      orderPolicy: "post_only",
      pairLockRole: "opening",
      capitalEffect: "increase",
    };
    assert.equal((await trader.placeBuy(opportunity)).accepted, true);
    const createdAt = Date.parse(trader.snapshot().orders[0]!.createdAt);
    await trader.ingestMarketEvent({
      event_type: "last_trade_price",
      asset_id: "up-token",
      side: "SELL",
      price: "0.39",
      size: "200",
      timestamp: createdAt + 1_000,
    });
    const account = trader.snapshot();
    const execution = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(account.cash, 1);
    assert.ok((account.theoreticalCash ?? 0) < 0);
    assert.ok((account.grossCapitalDeployed ?? 0) >= 39);
    assert.equal(execution.capitalConstraint, false);
    assert.equal(execution.availableCash, Number.MAX_SAFE_INTEGER);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
