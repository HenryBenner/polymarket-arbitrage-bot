import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderTracker } from "../src/ladder.js";
import {
  LADDER_V12_CHEAP_PRICE,
  LADDER_V12_MAX_PAIR_COST,
  maximumV12CompletionPrice,
  planLadderV12,
} from "../src/ladder-v12.js";
import {
  LadderV12RegimeEngine,
  type LadderV12DecisionSnapshot,
} from "../src/ladder-v12-regime.js";
import type {
  RegimePricePoint,
  RegimePriceProvider,
} from "../src/regime-price-stream.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  TokenBook,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

class FakeBrtiProvider implements RegimePriceProvider {
  readonly source = "brti" as const;
  callback: ((point: RegimePricePoint) => void) | null = null;
  start(callback: (point: RegimePricePoint) => void): void {
    this.callback = callback;
  }
  close(): void {}
  emit(point: RegimePricePoint): void {
    this.callback?.(point);
  }
}

function snapshot(
  books: TokenBook[] = testBooks(0.4, 0.6),
  orders: PaperOrder[] = [],
  fills: PaperFill[] = [],
): MarketExecutionSnapshot {
  return {
    marketSlug: testEvent().slug,
    orders,
    openOrders: orders.filter(
      (order) => order.status === "open" || order.status === "partial",
    ),
    fills,
    positions: [],
    books,
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 2_000,
    totalFees: 0,
    estimatedMakerRebate: 0,
    takerFeeRate: 0.07,
    makerFeeRate: 0,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

function decision(targetShares: number): LadderV12DecisionSnapshot {
  return {
    marketSlug: testEvent().slug,
    decisionTimestamp: "2026-08-28T00:00:00.000Z",
    decisionTimestampMs: Date.parse("2026-08-28T00:00:00.000Z"),
    source: "brti",
    scoreInputsValid: true,
    v10Score: targetShares === 40 ? 70 : targetShares === 20 ? 50 : 20,
    targetShares,
    features: {
      trendEfficiency: 0.5,
      reversals: 0.5,
      rangeDisplacement: 0.5,
      realizedVolatility: 0.5,
      volatilityRaw: 0.001,
      marketGeometry: 0.5,
      queueDepletion: 0.5,
      flowAlternation: 0.5,
      slowPairRegime: 0.5,
    },
    rawFeatures: null,
    brtiTimestamp: "2026-08-28T00:00:00.000Z",
    brtiTimestampMs: Date.parse("2026-08-28T00:00:00.000Z"),
    brtiAgeMs: 0,
    brtiObservedAtMs: Date.parse("2026-08-28T00:00:00.000Z"),
    brtiObservedAgeMs: 0,
    brtiSequenceValid: true,
    brtiCoverage: 1,
    brtiScoreReason: "ok",
    cheapTokenId: "up-token",
    cheapOutcome: "Up",
    cheapPrice: 0.4,
    favoriteTokenId: "down-token",
    favoriteOutcome: "Down",
    favoritePrice: 0.6,
    entryEligible: targetShares > 0,
    reason: targetShares > 0 ? "ELIGIBLE" : "SCORE_BELOW_ENTRY",
  };
}

function cheapOrder(
  originalSize: number,
  remainingSize = originalSize,
): PaperOrder {
  return {
    id: "cheap-1",
    tradeKey: `ladder-v12:${testEvent().slug}:cheap-maker:1:${originalSize}`,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId: "up-token",
    outcome: "Up",
    limitPrice: LADDER_V12_CHEAP_PRICE,
    originalSize,
    remainingSize,
    queueAhead: 0,
    status:
      remainingSize === 0
        ? "filled"
        : remainingSize === originalSize
          ? "open"
          : "partial",
    phaseId: "5-0",
    pairId: "ladder-v12:cheap-maker-1",
    orderPolicy: "post_only",
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

function fill(order: PaperOrder, size: number, fee = 0): PaperFill {
  return {
    id: `${order.id}-fill-${size}`,
    orderId: order.id,
    marketSlug: order.marketSlug,
    tokenId: order.tokenId,
    outcome: order.outcome,
    price: order.limitPrice,
    size,
    fee,
    liquidity: order.orderPolicy === "post_only" ? "maker" : "taker",
    side: "BUY",
    timestamp: "2026-08-28T00:00:01.000Z",
  };
}

async function withTracker(
  run: (tracker: LadderTracker) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v12-"));
  try {
    const tracker = new LadderTracker(directory, "ladder-v12-state.json");
    await tracker.init();
    await run(tracker);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("V12 restores the 20-share middle tier and tops up only to 40", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const now = event.windowEnd - 240;
    const initial = await planLadderV12(
      tracker,
      event,
      snapshot(),
      decision(20),
      false,
      now,
    );
    assert.equal(initial.opportunities[0]?.size, 20);
    assert.equal(initial.opportunities[0]?.price, 0.1);
    assert.equal(initial.opportunities[0]?.orderPolicy, "post_only");

    const first = cheapOrder(20, 0);
    const topUp = await planLadderV12(
      tracker,
      event,
      snapshot(testBooks(), [first], [fill(first, 20)]),
      decision(40),
      false,
      now,
    );
    assert.equal(topUp.opportunities[0]?.size, 20);
    assert.equal(topUp.managementStage, "cheap-top-up");
  });
});

test("V12 never submits a favorite order before a cheap fill", async () => {
  await withTracker(async (tracker) => {
    const order = cheapOrder(40);
    const plan = await planLadderV12(
      tracker,
      testEvent(),
      snapshot(testBooks(), [order]),
      decision(40),
      true,
      testEvent().windowEnd - 240,
    );
    assert.deepEqual(plan.opportunities, []);
    assert.equal(plan.favoriteFilledShares, 0);
    assert.equal(plan.unmatchedCheapShares, 0);
  });
});

test("V12 completes exactly the unmatched cheap fill with depth-aware FOK", async () => {
  await withTracker(async (tracker) => {
    const order = cheapOrder(20, 7);
    order.status = "cancelled";
    const books = testBooks(0.4, 0.6);
    books[1]!.asks = [
      { price: 0.8, size: 5 },
      { price: 0.84, size: 8 },
      { price: 0.85, size: 100 },
    ];
    const state = snapshot(books, [order], [fill(order, 13)]);
    const plan = await planLadderV12(
      tracker,
      testEvent(),
      state,
      decision(20),
      true,
      testEvent().windowEnd - 100,
    );
    assert.equal(maximumV12CompletionPrice(0.1, state, 0.01), 0.84);
    assert.equal(plan.maximumCompletionPrice, 0.84);
    assert.equal(plan.availableDepth, 13);
    assert.equal(plan.opportunities[0]?.size, 13);
    assert.equal(plan.opportunities[0]?.price, 0.84);
    assert.equal(plan.opportunities[0]?.orderPolicy, "fok");
    assert.ok((plan.plannedPairCost ?? 1) <= LADDER_V12_MAX_PAIR_COST);
  });
});

test("V12 keeps cheap-only exposure when completion depth is insufficient", async () => {
  await withTracker(async (tracker) => {
    const order = cheapOrder(20, 7);
    order.status = "cancelled";
    const books = testBooks(0.4, 0.6);
    books[1]!.asks = [{ price: 0.8, size: 12 }];
    const plan = await planLadderV12(
      tracker,
      testEvent(),
      snapshot(books, [order], [fill(order, 13)]),
      decision(20),
      true,
      testEvent().windowEnd - 100,
    );
    assert.deepEqual(plan.opportunities, []);
    assert.equal(plan.managementStage, "wait-completion-depth");
    assert.equal(plan.unmatchedCheapShares, 13);
  });
});

test("V12 reserves an acknowledged favorite FOK until its fills arrive", async () => {
  await withTracker(async (tracker) => {
    const cheap = cheapOrder(13, 0);
    const favorite: PaperOrder = {
      ...cheap,
      id: "favorite-1",
      tradeKey: `ladder-v12:${testEvent().slug}:favorite-completion:13:0:first`,
      tokenId: "down-token",
      outcome: "Down",
      limitPrice: 0.84,
      originalSize: 13,
      remainingSize: 0,
      pairId: "ladder-v12:favorite-completion-first",
      orderPolicy: "fok",
      status: "filled",
    };
    const books = testBooks(0.4, 0.6);
    books[1]!.asks = [{ price: 0.8, size: 40 }];
    const plan = await planLadderV12(
      tracker,
      testEvent(),
      snapshot(books, [cheap, favorite], [fill(cheap, 13)]),
      decision(20),
      true,
      testEvent().windowEnd - 100,
    );
    assert.equal(plan.favoritePendingShares, 13);
    assert.equal(plan.managementStage, "wait-favorite-confirmation");
    assert.deepEqual(plan.opportunities, []);
  });
});

test("V12 cancels unfilled excess when score falls and at the two-minute cutoff", async () => {
  await withTracker(async (tracker) => {
    const order = cheapOrder(40);
    const fallen = await planLadderV12(
      tracker,
      testEvent(),
      snapshot(testBooks(), [order]),
      decision(20),
      false,
      testEvent().windowEnd - 240,
    );
    assert.deepEqual(fallen.cancelOrderIds, [order.id]);

    const cutoff = await planLadderV12(
      tracker,
      testEvent(),
      snapshot(testBooks(), [order]),
      decision(40),
      false,
      testEvent().windowEnd - 120,
    );
    assert.deepEqual(cutoff.cancelOrderIds, [order.id]);
    assert.deepEqual(cutoff.opportunities, []);
  });
});

test("V12 uses the V10 score without a reversal cutoff and recalculates it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v12-regime-"));
  const provider = new FakeBrtiProvider();
  let clock = 1_900_000_000_000;
  try {
    const engine = new LadderV12RegimeEngine(
      testConfig({
        strategyMode: "ladder_v12",
        exchange: "kalshi",
        paperStatePath: directory,
      }),
      { providers: [provider], now: () => clock },
    );
    await engine.init();
    for (let index = 0; index <= 120; index += 1) {
      provider.emit({
        source: "brti",
        timestampMs: clock - (120 - index) * 1_000,
        observedAtMs: clock - (120 - index) * 1_000,
        price: 60_000 + (index % 2 === 0 ? 100 : -100),
        sequenceValid: true,
      });
    }
    const event = testEvent();
    event.windowEnd = clock / 1_000 + 240;
    const first = engine.evaluate(event, snapshot(), clock);
    assert.equal(first.source, "brti");
    assert.ok((first.features?.reversals ?? 0) > 0.1);
    assert.notEqual(first.reason, "INVALID_BRTI");
    assert.ok([0, 20, 40].includes(first.targetShares));

    clock += 1_000;
    provider.emit({
      source: "brti",
      timestampMs: clock,
      observedAtMs: clock,
      price: 60_100,
      sequenceValid: true,
    });
    const second = engine.evaluate(event, snapshot(), clock);
    assert.equal(second.decisionTimestampMs, clock);
    assert.notEqual(second.decisionTimestampMs, first.decisionTimestampMs);
    await engine.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
