import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderTracker } from "../src/ladder.js";
import {
  LadderV13BayesianModel,
  ladderV13Center,
  planLadderV13,
  type LadderV13FillEstimate,
  type LadderV13HistoricalModel,
  type LadderV13QuoteContext,
} from "../src/ladder-v13.js";
import { LadderV13HistoryStore } from "../src/ladder-v13-history.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  TokenBook,
} from "../src/types.js";
import { testBooks, testEvent } from "./helpers.js";

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
    totalFees: fills.reduce((sum, fill) => sum + fill.fee, 0),
    estimatedMakerRebate: 0,
    takerFeeRate: 0.07,
    makerFeeRate: 0,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

function order(
  id: string,
  tokenId: string,
  price: number,
  size = 10,
  status: PaperOrder["status"] = "open",
): PaperOrder {
  return {
    id,
    tradeKey: `ladder-v13:${testEvent().slug}:opening:${id}`,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId,
    outcome: tokenId === "up-token" ? "Up" : "Down",
    limitPrice: price,
    originalSize: size,
    remainingSize: status === "filled" ? 0 : size,
    queueAhead: 0,
    status,
    side: "BUY",
    phaseId: "15-0",
    pairId: `ladder-v13:opening-${tokenId === "up-token" ? "yes" : "no"}`,
    orderPolicy: "post_only",
    pairLockRole: "opening",
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

function fill(source: PaperOrder, size = source.originalSize, fee = 0): PaperFill {
  return {
    id: `${source.id}-fill`,
    orderId: source.id,
    marketSlug: source.marketSlug,
    tokenId: source.tokenId,
    outcome: source.outcome,
    price: source.limitPrice,
    size,
    fee,
    liquidity: source.orderPolicy === "post_only" ? "maker" : "taker",
    side: "BUY",
    timestamp: "2026-08-29T00:00:01.000Z",
  };
}

async function withTracker(run: (tracker: LadderTracker) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v13-"));
  try {
    const tracker = new LadderTracker(directory, "state.json");
    await tracker.init();
    await run(tracker);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("V13 combines both books into a depth-weighted YES-space microprice", () => {
  const books = testBooks(0.42, 0.62);
  books[0]!.bids[0]!.size = 30;
  books[0]!.asks[0]!.size = 10;
  books[1]!.bids[0]!.size = 10;
  books[1]!.asks[0]!.size = 30;
  const center = ladderV13Center(books[0]!, books[1]!);
  assert.ok(center !== null);
  assert.ok(center > 0.4 && center < 0.42);
});

test("V13 Bayesian smoothing is finite at cold start and yields to observations", () => {
  const model = new LadderV13BayesianModel();
  const context: LadderV13QuoteContext = {
    secondsLeft: 600,
    halfSpread: 0.04,
    bookSpread: 0.02,
    queueAhead: 10,
    volatility: 0,
    imbalance: 0,
    orderFlow: 0,
    quoteSize: 10,
  };
  const cold = model.estimate(context);
  assert.equal(cold.both + cold.yesOnly + cold.noOnly + cold.neither, 1);
  for (let index = 0; index < 30; index += 1) {
    model.observe({ context, outcome: "both", secondsToPair: 20 });
  }
  const learned = model.estimate(context);
  assert.ok(learned.both > cold.both);
  assert.ok(learned.both > 0.8);
  assert.equal(learned.observations, 30);
  assert.equal(learned.expectedSecondsToPair, 20);
});

test("V13 persists completed quote-cycle observations across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v13-history-"));
  try {
    const tracker = new LadderTracker(directory, "tracker.json");
    await tracker.init();
    const event = testEvent();
    const nowSeconds = event.windowEnd - 600;
    const history = await LadderV13HistoryStore.load(directory);
    const initialSnapshot = snapshot();
    const initial = await planLadderV13(
      tracker,
      event,
      initialSnapshot,
      history.model,
      nowSeconds,
    );
    await history.observe(event, initialSnapshot, initial, nowSeconds * 1_000);
    const context = initial.selectedCandidate!.context;

    const yes = order("history-yes", "up-token", initial.selectedCandidate!.yesPrice, 10, "filled");
    const no = order("history-no", "down-token", initial.selectedCandidate!.noPrice, 10, "filled");
    const completedSnapshot = snapshot(testBooks(), [yes, no], [fill(yes), fill(no)]);
    const completed = await planLadderV13(
      tracker,
      event,
      completedSnapshot,
      history.model,
      nowSeconds + 20,
    );
    await history.observe(
      event,
      completedSnapshot,
      completed,
      (nowSeconds + 20) * 1_000,
    );
    assert.equal(history.model.estimate(context).observations, 1);

    const restarted = await LadderV13HistoryStore.load(directory);
    assert.equal(restarted.model.estimate(context).observations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V13 selects a positive-EV pair edge and posts both maker legs one snapshot at a time", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const now = event.windowStart + 30;
    const first = await planLadderV13(tracker, event, snapshot(), undefined, now);
    assert.equal(first.managementStage, "post-yes-maker");
    assert.equal(first.opportunities[0]?.orderPolicy, "post_only");
    assert.equal(first.opportunities[0]?.strategyMode, "ladder_v13");
    assert.ok((first.selectedCandidate?.expectedValue ?? 0) > 0);
    assert.ok((first.selectedCandidate?.pairEdge ?? 0) >= 0.02);

    const yesOrder = order(
      "yes",
      "up-token",
      first.selectedCandidate!.yesPrice,
    );
    const second = await planLadderV13(
      tracker,
      event,
      snapshot(testBooks(), [yesOrder]),
      undefined,
      now,
    );
    assert.equal(second.managementStage, "post-no-maker");
    assert.equal(second.opportunities[0]?.token.tokenId, "down-token");
  });
});

test("V13 cancels every imbalance-increasing order before completing the missing side", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const yesFilled = order("yes-filled", "up-token", 0.35, 10, "filled");
    const extraYes = order("extra-yes", "up-token", 0.34);
    const plan = await planLadderV13(
      tracker,
      event,
      snapshot(testBooks(), [yesFilled, extraYes], [fill(yesFilled)]),
      undefined,
      event.windowEnd - 600,
    );
    assert.deepEqual(plan.cancelOrderIds, [extraYes.id]);
    assert.equal(plan.unpairedShares, 10);
    assert.deepEqual(plan.opportunities, []);
  });
});

test("V13 uses exact depth for immediate profitable FOK completion", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const yesFilled = order("yes-filled", "up-token", 0.35, 10, "filled");
    const books = testBooks(0.4, 0.55);
    books[1]!.asks = [
      { price: 0.54, size: 4 },
      { price: 0.55, size: 6 },
    ];
    books[1]!.bestAsk = 0.54;
    const plan = await planLadderV13(
      tracker,
      event,
      snapshot(books, [yesFilled], [fill(yesFilled)]),
      undefined,
      event.windowEnd - 600,
    );
    assert.equal(plan.managementStage, "profitable-fok-completion");
    assert.equal(plan.opportunities[0]?.orderPolicy, "fok");
    assert.equal(plan.opportunities[0]?.price, 0.55);
    assert.equal(plan.opportunities[0]?.size, 10);
    assert.ok((plan.plannedPairCost ?? 1) <= 1 - plan.requiredEdge + 1e-8);
  });
});

test("V13 creates no new directional inventory in the final minute", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const open = order("open", "up-token", 0.35);
    const plan = await planLadderV13(
      tracker,
      event,
      snapshot(testBooks(), [open]),
      undefined,
      event.windowEnd - 60,
    );
    assert.deepEqual(plan.cancelOrderIds, [open.id]);
    assert.deepEqual(plan.opportunities, []);
    assert.equal(plan.managementStage, "final-minute-no-new-inventory");
  });
});

test("V13 emits a reduce-only-style residual sale in the final 15 seconds", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const yesFilled = order("late-yes", "up-token", 0.8, 10, "filled");
    const books = testBooks(0.81, 0.25);
    books[0]!.bids = [{ price: 0.79, size: 10 }];
    books[0]!.bestBid = 0.79;
    books[1]!.asks = [{ price: 0.25, size: 10 }];
    books[1]!.bestAsk = 0.25;
    const plan = await planLadderV13(
      tracker,
      event,
      snapshot(books, [yesFilled], [fill(yesFilled)]),
      undefined,
      event.windowEnd - 10,
      true,
    );
    assert.equal(plan.managementStage, "final-seconds-flatten-residual");
    assert.equal(plan.flattenOpportunities[0]?.token.tokenId, "up-token");
    assert.equal(plan.flattenOpportunities[0]?.price, 0.79);
    assert.equal(plan.flattenOpportunities[0]?.orderPolicy, "fok");
  });
});

test("V13 declines every rung when historical one-sided losses make EV negative", async () => {
  const hostileModel: LadderV13HistoricalModel = {
    estimate(_context: LadderV13QuoteContext): LadderV13FillEstimate {
      return {
        both: 0.05,
        yesOnly: 0.4,
        noOnly: 0.4,
        neither: 0.15,
        yesUnwindLoss: 0.2,
        noUnwindLoss: 0.2,
        expectedSecondsToPair: 300,
        observations: 1_000,
      };
    },
  };
  await withTracker(async (tracker) => {
    const event = testEvent();
    const plan = await planLadderV13(
      tracker,
      event,
      snapshot(),
      hostileModel,
      event.windowEnd - 600,
    );
    assert.equal(plan.managementStage, "no-positive-ev-rung");
    assert.deepEqual(plan.opportunities, []);
  });
});
