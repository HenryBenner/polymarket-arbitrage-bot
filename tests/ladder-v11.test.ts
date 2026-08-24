import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderTracker } from "../src/ladder.js";
import {
  LADDER_V11_CHEAP_PRICE,
  LADDER_V11_FAVORITE_MAX_PRICE,
  LADDER_V11_SIZE,
  planLadderV11,
} from "../src/ladder-v11.js";
import {
  LadderV11RegimeEngine,
  type LadderV11DecisionSnapshot,
} from "../src/ladder-v11-regime.js";
import { buildLadderV11Report } from "../src/ladder-v11-report.js";
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

function decision(eligible = true): LadderV11DecisionSnapshot {
  return {
    marketSlug: testEvent().slug,
    decisionTimestamp: "2026-08-24T00:00:00.000Z",
    decisionTimestampMs: Date.parse("2026-08-24T00:00:00.000Z"),
    source: eligible ? "brti" : "none",
    scoreInputsValid: eligible,
    v10Score: 50,
    features: eligible
      ? {
          trendEfficiency: 0,
          reversals: 0,
          rangeDisplacement: 0,
          realizedVolatility: 0,
          volatilityRaw: 0,
          marketGeometry: 0,
          queueDepletion: 0,
          flowAlternation: 0,
          slowPairRegime: 0,
        }
      : null,
    rawFeatures: null,
    brtiTimestamp: eligible ? "2026-08-24T00:00:00.000Z" : null,
    brtiTimestampMs: eligible
      ? Date.parse("2026-08-24T00:00:00.000Z")
      : null,
    brtiAgeMs: eligible ? 0 : null,
    cheapTokenId: "up-token",
    cheapOutcome: "Up",
    cheapPrice: 0.4,
    favoriteTokenId: "down-token",
    favoriteOutcome: "Down",
    favoritePrice: 0.6,
    eligible,
    decision: eligible ? "FULL_TRADE" : "NO_TRADE",
    reason: eligible ? "ELIGIBLE" : "NO_BRTI",
    reversalThresholds: {
      rev05: eligible,
      rev10: eligible,
      rev15: eligible,
      rev20: eligible,
    },
    shadowV7Favorite: { size: 10, cost: 6, fee: 0 },
    shadowV10TargetShares: 20,
    shadowV10Favorite: { size: 10, cost: 6, fee: 0 },
  };
}

function cheapOrder(): PaperOrder {
  return {
    id: "cheap",
    tradeKey: `ladder-v11:${testEvent().slug}:cheap-maker`,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId: "up-token",
    outcome: "Up",
    limitPrice: 0.1,
    originalSize: 40,
    remainingSize: 40,
    queueAhead: 0,
    status: "open",
    phaseId: "5-0",
    pairId: "ladder-v11:cheap-maker",
    orderPolicy: "post_only",
    createdAt: "2026-08-24T00:00:00.000Z",
  };
}

async function withTracker(
  run: (tracker: LadderTracker, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v11-"));
  try {
    const tracker = new LadderTracker(directory, "ladder-v11-state.json");
    await tracker.init();
    await run(tracker, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function emitTrend(
  provider: FakeBrtiProvider,
  startMs: number,
  seconds: number,
): void {
  for (let index = 0; index <= seconds; index += 1) {
    provider.emit({
      source: "brti",
      timestampMs: startMs + index * 1_000,
      price: 60_000 + index,
    });
  }
}

test("V11 has only zero or fixed 40/40 orders at 10c and 80c", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const now = event.windowEnd - 240;
    const rejected = await planLadderV11(
      tracker,
      event,
      snapshot(),
      decision(false),
      false,
      now,
    );
    assert.deepEqual(rejected.opportunities, []);

    const cheap = await planLadderV11(
      tracker,
      event,
      snapshot(),
      decision(true),
      false,
      now,
    );
    assert.equal(cheap.opportunities.length, 1);
    assert.equal(cheap.opportunities[0]?.size, LADDER_V11_SIZE);
    assert.equal(cheap.opportunities[0]?.price, LADDER_V11_CHEAP_PRICE);
    assert.equal(cheap.opportunities[0]?.orderPolicy, "post_only");
    assert.equal(cheap.opportunities[0]?.pairId, "ladder-v11:cheap-maker");

    const favorite = await planLadderV11(
      tracker,
      event,
      snapshot(testBooks(0.4, 0.6), [cheapOrder()]),
      decision(true),
      true,
      now,
    );
    assert.equal(favorite.opportunities.length, 1);
    assert.equal(favorite.opportunities[0]?.size, LADDER_V11_SIZE);
    assert.equal(
      favorite.opportunities[0]?.price,
      LADDER_V11_FAVORITE_MAX_PRICE,
    );
    assert.equal(favorite.opportunities[0]?.orderPolicy, "fak");
    assert.equal(
      favorite.opportunities[0]?.pairId,
      "ladder-v11:favorite-initial",
    );

    const invalidated = await planLadderV11(
      tracker,
      event,
      snapshot(testBooks(0.4, 0.6), [cheapOrder()]),
      decision(false),
      true,
      now,
    );
    assert.deepEqual(invalidated.cancelOrderIds, ["cheap"]);
    assert.deepEqual(invalidated.opportunities, []);
  });
});

test("V11 never creates completion or rescue orders", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const cheap = cheapOrder();
    cheap.status = "filled";
    cheap.remainingSize = 0;
    const favorite: PaperOrder = {
      ...cheap,
      id: "favorite",
      tradeKey: `ladder-v11:${event.slug}:favorite-initial`,
      tokenId: "down-token",
      outcome: "Down",
      limitPrice: 0.8,
      pairId: "ladder-v11:favorite-initial",
      orderPolicy: "fak",
      status: "cancelled",
    };
    const plan = await planLadderV11(
      tracker,
      event,
      snapshot(testBooks(0.1, 0.9), [cheap, favorite]),
      decision(true),
      true,
      event.windowEnd - 100,
    );
    assert.deepEqual(plan.opportunities, []);
    assert.ok(
      !plan.managementStage.includes("completion") &&
        !plan.managementStage.includes("rescue"),
    );
  });
});

test("V11 trades a complete low-reversal BRTI path without using score as a gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v11-regime-"));
  let clock = 1_800_000_000_000;
  const provider = new FakeBrtiProvider();
  try {
    const config = testConfig({
      strategyMode: "ladder_v11",
      exchange: "kalshi",
      paperStatePath: directory,
    });
    const event = testEvent();
    event.windowEnd = clock / 1_000 + 300;
    const engine = new LadderV11RegimeEngine(config, {
      providers: [provider],
      now: () => clock,
    });
    await engine.init();

    emitTrend(provider, clock - 120_000, 120);
    const eligible = await engine.evaluate(event, snapshot(), false, clock);
    assert.equal(eligible.source, "brti");
    assert.equal(eligible.scoreInputsValid, true);
    assert.equal(eligible.features?.reversals, 0);
    assert.equal(eligible.eligible, true);
    assert.equal(eligible.decision, "FULL_TRADE");
    assert.equal(eligible.reversalThresholds.rev05, true);
    await engine.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V11 freezes NO_TRADE when BRTI is unavailable at the entry decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v11-no-brti-"));
  const clock = 1_800_000_000_000;
  const provider = new FakeBrtiProvider();
  try {
    const event = testEvent();
    event.windowEnd = clock / 1_000 + 300;
    const engine = new LadderV11RegimeEngine(
      testConfig({
        strategyMode: "ladder_v11",
        exchange: "kalshi",
        paperStatePath: directory,
      }),
      { providers: [provider], now: () => clock },
    );
    await engine.init();
    const missing = await engine.evaluate(event, snapshot(), false, clock);
    assert.equal(missing.source, "none");
    assert.equal(missing.eligible, false);
    assert.equal(missing.reason, "NO_BRTI");
    await engine.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V11 recomputes aged decisions and rejects execution after reversals rise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v11-stale-"));
  let clock = 1_800_000_000_000;
  const provider = new FakeBrtiProvider();
  try {
    const config = testConfig({
      strategyMode: "ladder_v11",
      exchange: "kalshi",
      paperStatePath: directory,
    });
    const event = testEvent();
    event.windowEnd = clock / 1_000 + 300;
    const engine = new LadderV11RegimeEngine(config, {
      providers: [provider],
      now: () => clock,
    });
    await engine.init();
    emitTrend(provider, clock - 120_000, 120);
    const initial = await engine.evaluate(event, snapshot(), false, clock);
    assert.equal(initial.eligible, true);

    for (let index = 1; index <= 100; index += 1) {
      provider.emit({
        source: "brti",
        timestampMs: clock + index * 1_000,
        price: 60_120 + (index % 2 === 0 ? 20 : -20),
      });
    }
    clock += 100_000;
    const final = await engine.evaluate(event, snapshot(), true, clock);
    assert.equal(final.source, "brti");
    assert.ok((final.features?.reversals ?? 0) > 0.1);
    assert.equal(final.eligible, false);
    assert.equal(final.reason, "REVERSALS_TOO_HIGH");
    const record = engine.snapshotState().decisions[event.slug];
    assert.equal(record?.staleDecisionRecalculated, true);
    assert.equal(record?.initialDecisionAgeMs, 100_000);
    await engine.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V11 aborts a fresh decision when the favorite identity flips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v11-flip-"));
  let clock = 1_800_000_000_000;
  const provider = new FakeBrtiProvider();
  try {
    const event = testEvent();
    event.windowEnd = clock / 1_000 + 300;
    const engine = new LadderV11RegimeEngine(
      testConfig({
        strategyMode: "ladder_v11",
        exchange: "kalshi",
        paperStatePath: directory,
      }),
      { providers: [provider], now: () => clock },
    );
    await engine.init();
    emitTrend(provider, clock - 120_000, 120);
    const initial = await engine.evaluate(event, snapshot(), false, clock);
    assert.equal(initial.favoriteTokenId, "down-token");
    clock += 500;
    provider.emit({ source: "brti", timestampMs: clock, price: 60_121 });
    const final = await engine.evaluate(
      event,
      snapshot(testBooks(0.61, 0.39)),
      true,
      clock,
    );
    assert.equal(final.favoriteTokenId, "up-token");
    assert.equal(final.eligible, false);
    assert.equal(final.reason, "FAVORITE_CHANGED");
    await engine.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V11 report exposes the three hard execution diagnostics", () => {
  const base = decision(true);
  const report = buildLadderV11Report([
    {
      marketSlug: base.marketSlug,
      initialDecision: base,
      finalDecision: base,
      initialDecisionAt: base.decisionTimestamp,
      finalDecisionAt: base.decisionTimestamp,
      orderSubmittedAt: new Date(base.decisionTimestampMs + 100).toISOString(),
      initialDecisionAgeMs: 1_500,
      decisionAgeMs: 100,
      staleDecisionRecalculated: true,
      initialFavorite: "Down",
      finalFavorite: "Down",
      initialFavoritePrice: 0.6,
      finalFavoritePrice: 0.6,
      reversalsAtInitial: 0.05,
      reversalsAtExecution: 0.05,
      qualified: true,
      observedFills: [],
      favoriteFillBelow50Count: 0,
      nonBrtiExecutionCount: 0,
      cheapShadow: {
        eligible: true,
        crossed: false,
        queueCleared: false,
        touched: false,
        queueAhead: 0,
        volumeAtRung: 0,
        tradeKeys: [],
        makerFeeRate: 0,
        feeExponent: 1,
      },
      actualPnl: 2,
      counterfactualV7Pnl: 1,
      counterfactualV10Pnl: 0.5,
      settledAt: "2026-08-24T00:15:00.000Z",
    },
  ]);
  assert.equal(report.diagnostics.decisionsOverOneSecondBeforeRecalculation, 1);
  assert.equal(report.diagnostics.staleExecutions, 0);
  assert.equal(report.diagnostics.favoriteFillsBelow50, 0);
  assert.equal(report.diagnostics.nonBrtiTrades, 0);
});
