import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LadderV10Decision } from "../src/ladder-v10-regime.js";
import {
  binaryFavoriteTarget,
  classifyShadowCheapFill,
  favoriteTierForScore,
  LadderV10RegimeEngine,
  scoreOscillation,
  shadowDynamicCheapTarget,
} from "../src/ladder-v10-regime.js";
import { buildLadderV10Report } from "../src/ladder-v10-report.js";
import { planLadderV10 } from "../src/ladder-v10.js";
import { LadderTracker } from "../src/ladder.js";
import {
  parseBrtiMessage,
  parseBrtiProtocolMessage,
  parseCoinbaseMessage,
  type RegimePriceProvider,
  type RegimePricePoint,
} from "../src/regime-price-stream.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  TokenBook,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function decision(target: number): LadderV10Decision {
  return {
    marketSlug: testEvent().slug,
    createdAt: "2026-08-12T00:00:00.000Z",
    scoreVersion: "v10-heuristic-1",
    score: target === 0 ? 20 : target === 20 ? 55 : 80,
    scoreValid: true,
    source: "brti",
    decisionReason: "adaptive",
    favoriteTargetShares: target,
    cheapTokenId: "up-token",
    favoriteTokenId: "down-token",
    features: null,
    counterfactualFavorite: { size: 40, cost: 32, fee: 0.4 },
    observedFills: [],
  };
}

function order(
  role: string,
  tokenId: string,
  size = 40,
  status: PaperOrder["status"] = "open",
): PaperOrder {
  return {
    id: `v10-${role}`,
    tradeKey: `ladder-v10:${testEvent().slug}:${role}`,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId,
    outcome: tokenId === "up-token" ? "Up" : "Down",
    limitPrice: role === "cheap-maker" ? 0.1 : 0.8,
    originalSize: size,
    remainingSize: status === "filled" ? 0 : size,
    queueAhead: 0,
    status,
    phaseId: "5-0",
    pairId: `ladder-v10:${role}`,
    orderPolicy: role === "cheap-maker" ? "post_only" : "fak",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}

function fill(value: PaperOrder, size: number, price = value.limitPrice): PaperFill {
  return {
    id: `fill-${value.id}`,
    orderId: value.id,
    marketSlug: value.marketSlug,
    tokenId: value.tokenId,
    outcome: value.outcome,
    price,
    size,
    fee: value.orderPolicy === "post_only" ? 0 : 0.01 * size,
    liquidity: value.orderPolicy === "post_only" ? "maker" : "taker",
    timestamp: "2026-08-12T00:00:00.000Z",
  };
}

function snapshot(
  orders: PaperOrder[] = [],
  fills: PaperFill[] = [],
  books: TokenBook[] = testBooks(0.4, 0.6),
): MarketExecutionSnapshot {
  return {
    marketSlug: testEvent().slug,
    orders,
    openOrders: orders.filter(
      (candidate) => candidate.status === "open" || candidate.status === "partial",
    ),
    fills,
    positions: [],
    books,
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 2_000,
    totalFees: fills.reduce((sum, item) => sum + item.fee, 0),
    estimatedMakerRebate: 0,
    takerFeeRate: 0.07,
    makerFeeRate: 0,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

async function withTracker(
  run: (tracker: LadderTracker, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v10-"));
  try {
    const tracker = new LadderTracker(directory, "ladder-v10-state.json");
    await tracker.init();
    await run(tracker, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("V10 posts the fixed cheap maker before its frozen favorite tier", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const config = testConfig({
      strategyMode: "ladder_v10",
      exchange: "kalshi",
      paperStatePath: directory,
    });
    const first = await planLadderV10(
      config,
      tracker,
      event,
      snapshot(),
      decision(20),
      event.windowEnd - 240,
    );
    assert.equal(first.opportunities[0]?.pairId, "ladder-v10:cheap-maker");
    assert.equal(first.opportunities[0]?.size, 40);
    assert.equal(first.opportunities[0]?.orderPolicy, "post_only");

    const cheap = order("cheap-maker", "up-token");
    const second = await planLadderV10(
      config,
      tracker,
      event,
      snapshot([cheap]),
      decision(20),
      event.windowEnd - 240,
    );
    assert.equal(second.opportunities[0]?.pairId, "ladder-v10:favorite-initial");
    assert.equal(second.opportunities[0]?.size, 40);
    assert.equal(second.opportunities[0]?.orderPolicy, "fak");
  });
});

test("V10 zero tier never creates an initial favorite order", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = order("cheap-maker", "up-token");
    const plan = await planLadderV10(
      testConfig({ strategyMode: "ladder_v10", exchange: "kalshi", paperStatePath: directory }),
      tracker,
      event,
      snapshot([cheap]),
      decision(0),
      event.windowEnd - 240,
    );
    assert.deepEqual(plan.opportunities, []);
    assert.equal(plan.managementStage, "balanced");
  });
});

test("V10 completes only exact confirmed cheap residual within the 0.97 cap", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = order("cheap-maker", "up-token", 40, "filled");
    const favorite = order("favorite-initial", "down-token", 20, "filled");
    const books = testBooks(0.4, 0.6);
    books[1]!.asks = [{ price: 0.82, size: 20 }];
    books[1]!.bestAsk = 0.82;
    const plan = await planLadderV10(
      testConfig({ strategyMode: "ladder_v10", exchange: "kalshi", paperStatePath: directory }),
      tracker,
      event,
      snapshot([cheap, favorite], [fill(cheap, 40, 0.1), fill(favorite, 20, 0.79)], books),
      decision(20),
      event.windowEnd - 100,
    );
    assert.equal(plan.unmatchedCheapShares, 20);
    assert.equal(plan.opportunities[0]?.orderPolicy, "fok");
    assert.equal(plan.opportunities[0]?.size, 20);
    assert.match(plan.opportunities[0]?.pairId ?? "", /^ladder-v10:favorite-completion-/);

    books[1]!.asks = [{ price: 0.9, size: 40 }];
    books[1]!.bestAsk = 0.9;
    const blocked = await planLadderV10(
      testConfig({ strategyMode: "ladder_v10", exchange: "kalshi", paperStatePath: directory }),
      tracker,
      event,
      snapshot([cheap, favorite], [fill(cheap, 40, 0.1), fill(favorite, 20, 0.79)], books),
      decision(20),
      event.windowEnd - 100,
    );
    assert.deepEqual(blocked.opportunities, []);
    assert.equal(blocked.managementStage, "wait-completion");
  });
});

test("V10 cancels only the resting cheap maker at two minutes", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = order("cheap-maker", "up-token");
    const favorite = order("favorite-initial", "down-token", 20, "cancelled");
    const plan = await planLadderV10(
      testConfig({ strategyMode: "ladder_v10", exchange: "kalshi", paperStatePath: directory }),
      tracker,
      event,
      snapshot([cheap, favorite]),
      decision(20),
      event.windowEnd - 120,
    );
    assert.deepEqual(plan.cancelOrderIds, [cheap.id]);
  });
});

function pricePath(kind: "trend" | "oscillate", nowMs: number): RegimePricePoint[] {
  const points: RegimePricePoint[] = [];
  for (let index = 0; index <= 120; index += 1) {
    const price =
      kind === "trend"
        ? 60_000 + index * 5
        : 60_000 + (index % 10 < 5 ? index % 5 : 5 - (index % 5)) * 20;
    points.push({ source: "brti", timestampMs: nowMs - (120 - index) * 1_000, price });
  }
  return points;
}

test("oscillation score separates alternating and one-way paths", () => {
  const nowMs = 1_800_000_000_000;
  const books = testBooks(0.2, 0.8);
  const bookSamples = Array.from({ length: 16 }, (_, index) => ({
    timestampMs: nowMs - (15 - index) * 1_000,
    upMid: 0.5,
    cheapQueue: 100 - index * 4,
    yesBidDepth: 100 + (index % 2) * 20,
    yesAskDepth: 100 + ((index + 1) % 2) * 20,
    ofi: index % 2 === 0 ? 20 : -20,
    tradeFlow: 0,
  }));
  const base = {
    bookSamples,
    books,
    cheap: books[0]!,
    favorite: books[1]!,
    nowMs,
    source: "brti" as const,
    volatilityP10: 0,
    volatilityP90: 0.01,
    pairHistory: Array(32).fill(false) as boolean[],
    staleMs: 2_000,
  };
  const trending = scoreOscillation({ ...base, points: pricePath("trend", nowMs) });
  const oscillating = scoreOscillation({ ...base, points: pricePath("oscillate", nowMs) });
  assert.equal(trending.valid, true);
  assert.equal(oscillating.valid, true);
  assert.ok(oscillating.score > trending.score);
  assert.ok(oscillating.features.reversals > trending.features.reversals);
});

test("favorite sizing uses frozen 0/20/40 boundary semantics", () => {
  assert.equal(favoriteTierForScore(39), 0);
  assert.equal(favoriteTierForScore(40), 20);
  assert.equal(favoriteTierForScore(69), 20);
  assert.equal(favoriteTierForScore(70), 40);
  assert.equal(binaryFavoriteTarget(0), 0);
  assert.equal(binaryFavoriteTarget(20), 40);
  assert.equal(binaryFavoriteTarget(40), 40);
});

test("dynamic cheap shadow uses the fixed 90-cent pair target and conservative fills", () => {
  assert.equal(shadowDynamicCheapTarget(0.8), 0.1);
  assert.equal(shadowDynamicCheapTarget(0.78), 0.12);
  assert.equal(shadowDynamicCheapTarget(0.75), 0.15);
  assert.equal(shadowDynamicCheapTarget(0.7), 0.2);
  assert.equal(shadowDynamicCheapTarget(0.65), 0.25);
  assert.equal(shadowDynamicCheapTarget(0.6), 0.25);
  const bit25 = 1 << 17;
  assert.equal(
    classifyShadowCheapFill(0.25, {
      eligible: bit25,
      crossed: bit25,
      queueCleared: 0,
      touched: bit25,
    }),
    "DEFINITE_FILL",
  );
  assert.equal(
    classifyShadowCheapFill(0.25, {
      eligible: bit25,
      crossed: 0,
      queueCleared: bit25,
      touched: bit25,
    }),
    "QUEUE_FILL",
  );
  assert.equal(
    classifyShadowCheapFill(0.25, {
      eligible: bit25,
      crossed: 0,
      queueCleared: 0,
      touched: bit25,
    }),
    "UNCERTAIN",
  );
  assert.equal(
    classifyShadowCheapFill(0.25, {
      eligible: bit25,
      crossed: 0,
      queueCleared: 0,
      touched: 0,
    }),
    "NO_FILL",
  );
});

test("regime price parsers accept official BRTI and Coinbase ticker payloads", () => {
  assert.deepEqual(
    parseBrtiMessage({
      type: "cfbenchmarks_value",
      msg: {
        index_id: "BRTI",
        data: JSON.stringify({ time: 1_800_000_000_000, value: "68000.12" }),
      },
    }),
    { source: "brti", timestampMs: 1_800_000_000_000, price: 68000.12 },
  );
  assert.deepEqual(
    parseCoinbaseMessage({
      channel: "ticker",
      timestamp: "2026-08-12T00:00:00.000Z",
      events: [{ tickers: [{ product_id: "BTC-USD", price: "68100.25" }] }],
    }),
    [
      {
        source: "coinbase",
        timestampMs: Date.parse("2026-08-12T00:00:00.000Z"),
        price: 68100.25,
      },
    ],
  );
  assert.deepEqual(
    parseCoinbaseMessage({
      type: "ticker",
      product_id: "BTC-USD",
      time: "2026-08-12T00:00:01.000Z",
      price: "68101.25",
    }),
    [
      {
        source: "coinbase",
        timestampMs: Date.parse("2026-08-12T00:00:01.000Z"),
        price: 68101.25,
      },
    ],
  );
});

test("BRTI protocol parser preserves sequence and entitlement errors", () => {
  const message = parseBrtiProtocolMessage({
    type: "cfbenchmarks_value",
    sid: 7,
    seq: 42,
    msg: {
      index_id: "BRTI",
      received_at: 1_800_000_000_000,
      data: JSON.stringify({ time: 1_800_000_000_000, value: "68000.12" }),
    },
  });
  assert.equal(message.sid, 7);
  assert.equal(message.sequence, 42);
  assert.equal(message.point?.price, 68000.12);
  assert.deepEqual(
    parseBrtiProtocolMessage({
      type: "error",
      msg: { code: 8, msg: "not entitled" },
    }).error,
    { code: 8, message: "not entitled" },
  );
});

test("score rejects missing, stale, and low-coverage paths", () => {
  const nowMs = 1_800_000_000_000;
  const books = testBooks(0.2, 0.8);
  const input = {
    bookSamples: [],
    books,
    cheap: books[0]!,
    favorite: books[1]!,
    nowMs,
    source: "brti" as const,
    volatilityP10: 0,
    volatilityP90: 0.01,
    pairHistory: [] as boolean[],
    staleMs: 2_000,
  };
  assert.equal(scoreOscillation({ ...input, points: [] }).reason, "missing_source");
  assert.equal(
    scoreOscillation({
      ...input,
      points: [{ source: "brti", timestampMs: nowMs - 10_000, price: 60_000 }],
    }).reason,
    "insufficient_history",
  );
  const stale = pricePath("trend", nowMs - 3_000);
  assert.equal(scoreOscillation({ ...input, points: stale }).reason, "stale_source");
});

test("queue depletion and alternating flow score above growth and persistent flow", () => {
  const nowMs = 1_800_000_000_000;
  const books = testBooks(0.2, 0.8);
  const samples = (favorable: boolean) =>
    Array.from({ length: 16 }, (_, index) => ({
      timestampMs: nowMs - (15 - index) * 1_000,
      upMid: 0.5,
      cheapQueue: favorable ? 100 - index * 4 : 100 + index * 4,
      yesBidDepth: 100,
      yesAskDepth: 100,
      ofi: favorable ? (index % 2 === 0 ? 10 : -10) : 10,
      tradeFlow: 0,
    }));
  const base = {
    points: pricePath("oscillate", nowMs),
    books,
    cheap: books[0]!,
    favorite: books[1]!,
    nowMs,
    source: "brti" as const,
    volatilityP10: 0,
    volatilityP90: 0.01,
    pairHistory: [] as boolean[],
    staleMs: 2_000,
  };
  const favorable = scoreOscillation({ ...base, bookSamples: samples(true) });
  const unfavorable = scoreOscillation({ ...base, bookSamples: samples(false) });
  assert.ok(favorable.features.queueDepletion > unfavorable.features.queueDepletion);
  assert.ok(favorable.features.flowAlternation > unfavorable.features.flowAlternation);
  assert.ok(favorable.score > unfavorable.score);
});

test("V10 report separates fallback and exposure cohorts and enforces 300 adaptive markets", () => {
  const cheapOnly = decision(0);
  cheapOnly.observedFills = [fill(order("cheap-maker", "up-token"), 10)];
  cheapOnly.actualPnl = 6;
  cheapOnly.counterfactualV7Pnl = -4;
  cheapOnly.settledAt = "2026-08-12T00:01:00.000Z";
  cheapOnly.shadowResult = {
    marketSlug: cheapOnly.marketSlug,
    v10Score: cheapOnly.score,
    legacyV10TargetShares: 20,
    binaryV10TargetShares: 40,
    v10Actual: { favoriteShares: 40, pnl: 6 },
    legacyV10: { favoriteShares: 20, pnl: 2 },
    shadowV7: { pnl: -4 },
    shadowDangerFilter: { triggered: true, favoritePrice: 0.65, pnl: 1 },
    shadowDynamicCheap: {
      favoritePrice: 0.65,
      cheapTarget: 0.25,
      fillState: "QUEUE_FILL",
      pnl: 3,
    },
    rungMasks: { eligible: 1, crossed: 0, queueCleared: 1 },
    favoriteDepthAt80: 100,
    vwap40: 0.65,
    vwap80: 0.66,
    vwap120: null,
  };

  const fallback = decision(40);
  fallback.marketSlug = "fallback-market";
  fallback.decisionReason = "v7_fallback";
  fallback.source = "none";
  fallback.score = null;
  fallback.scoreValid = false;
  fallback.observedFills = [fill(order("favorite-initial", "down-token"), 20)];
  fallback.actualPnl = -8;
  fallback.counterfactualV7Pnl = -9;
  fallback.settledAt = "2026-08-12T00:02:00.000Z";

  const noTrade = decision(40);
  noTrade.marketSlug = "no-trade-market";
  noTrade.actualPnl = 0;
  noTrade.counterfactualV7Pnl = -1;
  noTrade.settledAt = "2026-08-12T00:03:00.000Z";

  const report = buildLadderV10Report([cheapOnly, fallback, noTrade]);
  assert.equal(report.overall.pnlSavedOrLost, 12);
  assert.equal(report.overall.tradedMarkets, 2);
  assert.equal(report.overall.noTradeMarkets, 1);
  assert.equal(report.overall.actualWinRate, 0.5);
  assert.equal(report.binaryShadowExperiment.settledAdaptiveMarkets, 1);
  assert.equal(report.binaryShadowExperiment.windows.all.v10Actual.pnl, 6);
  assert.equal(
    report.binaryShadowExperiment.windows.all.shadowDynamicCheap.queueFills,
    1,
  );
  assert.equal(report.binaryShadowExperiment.rallyCapture["8"].captureRatio, null);
  assert.equal(report.binaryShadowExperiment.rallyCapture["8"].avoidedLoss, 10);
  assert.equal(report.cohorts.fallbackStatus.v7_fallback?.markets, 1);
  assert.equal(report.cohorts.exposure.cheap_only?.markets, 1);
  assert.equal(report.cohorts.exposure.favorite_only?.markets, 1);
  assert.equal(report.evaluationReady, false);
});

test("regime decisions survive restart and JSONL snapshots append continuously", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v10-regime-"));
  let clock = 1_800_000_000_000;
  class FakeProvider implements RegimePriceProvider {
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
  try {
    await writeFile(
      join(directory, "ladder-v10-regime-state.json"),
      JSON.stringify({
        version: 1,
        scoreVersion: "v10-heuristic-1",
        completeMarkets: Array.from({ length: 32 }, (_, index) => `burn-${index}`),
        volatilitySamples: Array.from({ length: 32 }, (_, index) => 0.001 + index / 100_000),
        volatilityP10: 0.001,
        volatilityP90: 0.01,
        coinbaseComparisons: [],
        coinbaseEligible: false,
        pairHistory: [],
        decisions: {},
      }),
      "utf8",
    );
    const provider = new FakeProvider();
    const config = testConfig({
      strategyMode: "ladder_v10",
      exchange: "kalshi",
      paperStatePath: directory,
    });
    const event = testEvent();
    event.windowEnd = clock / 1_000 + 300;
    const engine = new LadderV10RegimeEngine(config, {
      providers: [provider],
      now: () => clock,
    });
    await engine.init();
    for (const point of pricePath("oscillate", clock)) provider.emit(point);
    const frozen = await engine.decisionFor(event, snapshot(), clock / 1_000);
    assert.equal(frozen?.decisionReason, "adaptive");
    assert.equal(frozen?.source, "brti");
    assert.equal(frozen?.legacyV10TargetShares, 20);
    assert.equal(frozen?.binaryV10TargetShares, 40);
    assert.equal(frozen?.favoriteTargetShares, 40);
    assert.equal(frozen?.dynamicCheapTarget, 0.25);
    assert.equal(frozen?.favoriteDepthAt80, 10);
    assert.equal(frozen?.vwap40, null);
    engine.ingestTelemetry({
      event_type: "last_trade_price",
      market_ticker: event.market.externalMarketId ?? event.market.id,
      asset_id: "up-token",
      side: "SELL",
      price: "0.24",
      size: "1",
      timestamp: String(clock + 1_000),
      transaction_hash: "shadow-cross",
    });
    await engine.handleSettlement({
      marketSlug: event.slug,
      winningTokenId: "down-token",
      winningOutcome: "Down",
      payout: 0,
      totalCost: 0,
      totalFees: 0,
      realizedPnl: -2,
      settledAt: "2026-08-12T00:15:00.000Z",
    });
    assert.equal(engine.snapshotState().decisions[event.slug]?.actualPnl, -2);
    assert.equal(
      engine.snapshotState().decisions[event.slug]?.counterfactualV7Pnl,
      3.832,
    );
    const shadow = engine.snapshotState().decisions[event.slug]?.shadowResult;
    assert.equal(shadow?.shadowDangerFilter.triggered, true);
    assert.equal(shadow?.shadowDynamicCheap.fillState, "DEFINITE_FILL");
    assert.equal(shadow?.rungMasks.crossed & (1 << 17), 1 << 17);
    assert.equal(shadow?.legacyV10TargetShares, 20);
    assert.equal(shadow?.binaryV10TargetShares, 40);
    await engine.close();

    clock += 1_000;
    const restarted = new LadderV10RegimeEngine(config, {
      providers: [new FakeProvider()],
      now: () => clock,
    });
    await restarted.init();
    const recovered = await restarted.decisionFor(event, snapshot(), clock / 1_000);
    assert.equal(recovered?.createdAt, frozen?.createdAt);
    assert.equal(recovered?.favoriteTargetShares, frozen?.favoriteTargetShares);
    await restarted.close();

    const rows = (await readFile(join(directory, "btc-regime-events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(rows.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
