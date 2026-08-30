import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderTracker } from "../src/ladder.js";
import {
  LadderV13FillHazardModel,
  ladderV13Center,
  planLadderV13,
  type LadderV13OrderHazardContext,
} from "../src/ladder-v13.js";
import { LadderV13HistoryStore } from "../src/ladder-v13-history.js";
import type { MarketExecutionSnapshot, PaperFill, PaperOrder, TokenBook } from "../src/types.js";
import { testBooks, testEvent } from "./helpers.js";

function snapshot(
  books: TokenBook[] = testBooks(0.4, 0.6),
  orders: PaperOrder[] = [],
  fills: PaperFill[] = [],
  availableCash = 2_000,
): MarketExecutionSnapshot {
  return {
    marketSlug: testEvent().slug,
    orders,
    openOrders: orders.filter((order) => order.status === "open" || order.status === "partial"),
    fills,
    positions: [],
    books,
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash,
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
  size = 20,
  status: PaperOrder["status"] = "open",
  createdAt = new Date(testEvent().windowStart * 1_000).toISOString(),
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
    queueAhead: 10,
    status,
    side: "BUY",
    phaseId: "15-0",
    pairId: `ladder-v13:opening-${tokenId === "up-token" ? "yes" : "no"}`,
    orderPolicy: "post_only",
    pairLockRole: "opening",
    createdAt,
  };
}

function fill(source: PaperOrder, timestampSeconds: number, size = source.originalSize): PaperFill {
  return {
    id: `${source.id}-fill`, orderId: source.id, marketSlug: source.marketSlug,
    tokenId: source.tokenId, outcome: source.outcome, price: source.limitPrice,
    size, fee: 0, liquidity: "maker", side: "BUY",
    timestamp: new Date(timestampSeconds * 1_000).toISOString(),
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

test("V13 combines complementary books into one YES-space microprice", () => {
  const books = testBooks(0.42, 0.62);
  books[0]!.bids[0]!.size = 30;
  books[0]!.asks[0]!.size = 10;
  books[1]!.bids[0]!.size = 10;
  books[1]!.asks[0]!.size = 30;
  const center = ladderV13Center(books[0]!, books[1]!);
  assert.ok(center !== null && center > 0.4 && center < 0.42);
});

test("V13 cold fill hazard follows queue-plus-half-size over eligible volume", () => {
  const model = new LadderV13FillHazardModel();
  const context: LadderV13OrderHazardContext = {
    tokenId: "up-token", queueAhead: 10, distanceTicks: 0,
    eligibleVolumePerSecond: 2, quoteSize: 20, horizonSeconds: 10,
  };
  const estimate = model.estimate(context);
  assert.equal(estimate.expectedFillSeconds, 10);
  assert.ok(Math.abs(estimate.fillProbability - (1 - Math.exp(-1))) < 1e-10);
});

test("V13 treats cancelled orders as censored hazard exposure", () => {
  const context: LadderV13OrderHazardContext = {
    tokenId: "up-token", queueAhead: 0, distanceTicks: 0,
    eligibleVolumePerSecond: 2, quoteSize: 20, horizonSeconds: 30,
  };
  const model = new LadderV13FillHazardModel();
  const cold = model.estimate(context);
  model.observe({ context, exposureSeconds: 120, filled: false });
  const learned = model.estimate(context);
  assert.equal(learned.observations, 1);
  assert.ok(learned.expectedFillSeconds > cold.expectedFillSeconds);
  assert.ok(learned.fillProbability < cold.fillProbability);
});

test("V13 persists per-order fill observations across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v13-history-"));
  try {
    const tracker = new LadderTracker(directory, "tracker.json");
    await tracker.init();
    const event = testEvent();
    const now = event.windowStart + 30;
    const history = await LadderV13HistoryStore.load(directory);
    const plan = await planLadderV13(tracker, event, snapshot(), history.model, now);
    const yes = order("history-yes", "up-token", plan.selectedCandidate!.yesPrice, 20, "open", new Date(now * 1_000).toISOString());
    const no = order("history-no", "down-token", plan.selectedCandidate!.noPrice, 20, "open", new Date(now * 1_000).toISOString());
    await history.observe(event, snapshot(testBooks(), [yes, no]), plan, now * 1_000);
    yes.status = "filled"; yes.remainingSize = 0;
    no.status = "cancelled";
    await history.observe(event, snapshot(testBooks(), [yes, no], [fill(yes, now + 20)]), plan, (now + 30) * 1_000);
    assert.equal(history.model.getObservationCount(), 2);
    const restarted = await LadderV13HistoryStore.load(directory);
    assert.equal(restarted.model.getObservationCount(), 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V13 cold start chooses the most aggressive profitable pair and returns both legs", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const plan = await planLadderV13(tracker, event, snapshot(), undefined, event.windowStart + 30);
    assert.equal(plan.managementStage, "batch-opening-pair");
    assert.equal(plan.opportunities.length, 2);
    assert.deepEqual(plan.opportunities.map((value) => value.token.tokenId), ["up-token", "down-token"]);
    assert.ok(plan.opportunities.every((value) => value.orderPolicy === "post_only" && value.strategyMode === "ladder_v13"));
    assert.equal(plan.selectedCandidate?.yesPrice, 0.39);
    assert.equal(plan.selectedCandidate?.noPrice, 0.59);
    assert.ok((plan.selectedCandidate?.pairProfit ?? 0) > 0);
  });
});

test("V13 keeps economically sound quotes through a one-tick book move", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const initial = await planLadderV13(tracker, event, snapshot(), undefined, event.windowStart + 30);
    const yes = order("sticky-yes", "up-token", initial.selectedCandidate!.yesPrice);
    const no = order("sticky-no", "down-token", initial.selectedCandidate!.noPrice);
    const books = testBooks(0.41, 0.6);
    books[0]!.bestBid = 0.4;
    books[0]!.bids = [{ price: 0.4, size: 10 }];
    const plan = await planLadderV13(tracker, event, snapshot(books, [yes, no]), undefined, event.windowStart + 31);
    assert.equal(plan.managementStage, "sticky-profitable-quotes");
    assert.deepEqual(plan.cancelOrderIds, []);
  });
});

test("V13 cancels imbalance-increasing orders before completing the missing side", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const yesFilled = order("yes-filled", "up-token", 0.35, 10, "filled");
    const extraYes = order("extra-yes", "up-token", 0.34, 10);
    const plan = await planLadderV13(tracker, event, snapshot(testBooks(), [yesFilled, extraYes], [fill(yesFilled, event.windowStart + 1)]), undefined, event.windowEnd - 600);
    assert.deepEqual(plan.cancelOrderIds, [extraYes.id]);
    assert.equal(plan.unpairedShares, 10);
  });
});

test("V13 immediately takes any strictly profitable completion", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    event.market.orderPriceMinTickSize = 0.001;
    const yesFilled = order("yes-filled", "up-token", 0.45, 10, "filled");
    const books = testBooks(0.46, 0.545);
    books[1]!.asks = [{ price: 0.545, size: 10 }];
    books[1]!.bestAsk = 0.545;
    const state = snapshot(books, [yesFilled], [fill(yesFilled, event.windowStart + 1)]);
    state.takerFeeRate = 0;
    const plan = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 10);
    assert.equal(plan.managementStage, "profitable-fok-completion");
    assert.equal(plan.opportunities[0]?.orderPolicy, "fok");
    assert.ok((plan.plannedPairCost ?? 1) < 1);
  });
});

test("V13 hunts new pairs in the final minute and after more than 40 completed pairs", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const yes = order("old-yes", "up-token", 0.39, 100, "filled");
    const no = order("old-no", "down-token", 0.59, 100, "filled");
    const plan = await planLadderV13(
      tracker, event, snapshot(testBooks(), [yes, no], [fill(yes, event.windowStart + 1), fill(no, event.windowStart + 1)]),
      undefined, event.windowEnd - 30,
    );
    assert.equal(plan.pairedShares, 100);
    assert.equal(plan.managementStage, "batch-opening-pair");
    assert.equal(plan.opportunities.length, 2);
    assert.deepEqual(plan.flattenOpportunities, []);
  });
});

test("V13 scales a cycle only to available cash instead of a lifetime contract cap", async () => {
  await withTracker(async (tracker) => {
    const event = testEvent();
    const plan = await planLadderV13(tracker, event, snapshot(testBooks(), [], [], 5), undefined, event.windowStart + 30);
    assert.equal(plan.opportunities.length, 2);
    assert.ok((plan.selectedCandidate?.size ?? 0) > 0);
    assert.ok((plan.selectedCandidate?.size ?? 99) < 20);
  });
});
