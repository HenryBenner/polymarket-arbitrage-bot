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
import { LadderV13CompletionHazardModel, ladderV13SellFraction, ladderV13TimePrior, type LadderV13CompletionContext, type LadderV13CompletionModel } from "../src/ladder-v13-completion-model.js";
import { ladderV13Inventory, ladderV13SellGuard } from "../src/ladder-v13-inventory.js";
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

function residualState(bid = 0.30, paired = 0): MarketExecutionSnapshot {
  const books = testBooks(0.6, 0.6);
  books[0]!.bids = [{ price: bid, size: 100 }];
  books[0]!.bestBid = bid;
  const yes = order("residual-yes", "up-token", 0.55, 10 + paired, "filled");
  const no = order("paired-no", "down-token", 0.4, paired, "filled");
  const orders = paired ? [yes, no] : [yes];
  const state = snapshot(books, orders, orders.map((item) => fill(item, testEvent().windowStart + 10)));
  state.takerFeeRate = 0;
  return state;
}

const completionContext: LadderV13CompletionContext = {
  queueRatio: 1, flowRatio: 0.1, distanceTicks: 1, residualShares: 10,
  residualAgeSeconds: 60, secondsRemaining: 180,
  maximumCompletionPrice: 0.44, completionMakerPrice: 0.44,
};

test("V13 completion cold priors follow every supplied time bucket and interpolate", () => {
  for (const [seconds, probability, upperProbability] of [
    [600, .274, .386], [480, .23, .337], [360, .153, .253], [300, .113, .207],
    [240, .083, .17], [180, .029, .10], [120, .028, .096], [60, .014, .074], [30, 0, .051],
  ]) {
    const model = new LadderV13CompletionHazardModel();
    const estimate = model.estimate({ ...completionContext, secondsRemaining: seconds! });
    assert.equal(estimate.probability, probability);
    assert.equal(estimate.upperProbability, upperProbability);
  }
  assert.ok(Math.abs(ladderV13TimePrior(270).probability - .098) < 1e-10);
});

test("V13 completion learning pools normalized contexts without token IDs and caps immature optimism", () => {
  const model = new LadderV13CompletionHazardModel();
  model.observe({ context: { ...completionContext }, exposureSeconds: 1, fillSeconds: 1, filled: true });
  const estimate = model.estimate({ ...completionContext, residualShares: 20 });
  assert.equal(estimate.comparableOrders, 1);
  assert.ok(estimate.probability <= .029);
  assert.ok(estimate.upperProbability <= .10);
  assert.equal(estimate.strongEvidence, false);
  model.observe({ context: completionContext, exposureSeconds: 2000, filled: false });
  assert.ok(model.estimate(completionContext).hazard < estimate.hazard);
});

test("V13 mature completion evidence can exceed startup caps", () => {
  const model = new LadderV13CompletionHazardModel();
  for (let index = 0; index < 100; index++) {
    model.observe({ context: completionContext, exposureSeconds: 40, filled: index < 80, fillSeconds: index < 80 ? 40 : undefined });
  }
  const estimate = model.estimate(completionContext);
  assert.equal(estimate.mature, true);
  assert.equal(estimate.strongEvidence, true);
  assert.ok(estimate.probability > .10);
  assert.ok(estimate.upperProbability >= estimate.probability && estimate.upperProbability <= 1);
});

test("V13 uncertainty produces zero, fractional, and full residual sale decisions", () => {
  assert.equal(ladderV13SellFraction(.20, .20, .30), 0);
  assert.equal(ladderV13SellFraction(.25, .20, .30), .5);
  assert.equal(ladderV13SellFraction(.30, .20, .30), 1);
});

test("V13 starts EV-based selling at five minutes, not before", async () => withTracker(async (tracker) => {
  const event = testEvent();
  const before = await planLadderV13(tracker, event, residualState(), undefined, event.windowEnd - 301);
  assert.equal(before.flattenOpportunities.length, 0);
  assert.equal(before.opportunities[0]?.orderPolicy, "post_only");
  const eligible = await planLadderV13(tracker, event, residualState(), undefined, event.windowEnd - 300);
  assert.equal(eligible.flattenOpportunities[0]?.size, 10);
  assert.equal(eligible.flattenOpportunities[0]?.orderPolicy, "fak");
  assert.equal(eligible.liquidation?.fallbackValue, 4 / 23);
}));

test("V13 sells only the surplus and protects already matched pairs", async () => withTracker(async (tracker) => {
  const event = testEvent();
  const state = residualState(.45, 20);
  const plan = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 300);
  assert.equal(plan.pairedShares, 20);
  assert.equal(plan.flattenOpportunities[0]?.size, 10);
  assert.equal(plan.liquidation?.fallbackValue, 1 / 3);
  assert.equal(ladderV13SellGuard(state, "up-token", 10), null);
  assert.equal(ladderV13SellGuard(state, "up-token", 10.01), "sale_exceeds_v13_residual");
  assert.equal(ladderV13SellGuard(state, "down-token", 1), "sale_exceeds_v13_residual");
}));

test("V13 mixed evidence sells the calculated fraction and lower bids keep the maker", async () => withTracker(async (tracker) => {
  const event = testEvent();
  const plan = await planLadderV13(tracker, event, residualState(.24), undefined, event.windowEnd - 300);
  assert.equal(plan.managementStage, "gradual-residual-liquidation");
  const expected = Math.floor(1000 * ladderV13SellFraction(.24, plan.liquidation!.waitValue, plan.liquidation!.upperWaitValue)) / 100;
  assert.equal(plan.flattenOpportunities[0]?.size, expected);
  assert.ok(expected > 0 && expected < 10);
  const resume = await planLadderV13(tracker, event, residualState(.24), undefined, event.windowEnd - 300,
    true, undefined, undefined, true);
  assert.equal(resume.flattenOpportunities.length, 0);
  assert.equal(resume.opportunities[0]?.orderPolicy, "post_only");
  const wait = await planLadderV13(tracker, event, residualState(.10), undefined, event.windowEnd - 300);
  assert.equal(wait.flattenOpportunities.length, 0);
  assert.equal(wait.opportunities[0]?.orderPolicy, "post_only");
}));

test("V13 retries an unfilled IOC on a later evaluation even if displayed depth is unchanged", async () => withTracker(async (tracker) => {
  const event = testEvent();
  const now = event.windowEnd - 20;
  const state = residualState();
  const first = await planLadderV13(tracker, event, state, undefined, now);
  await tracker.mark(first.flattenOpportunities[0]!.tradeKey);
  const same = await planLadderV13(tracker, event, state, undefined, now);
  assert.equal(same.flattenOpportunities.length, 0);
  const retry = await planLadderV13(tracker, event, state, undefined, now + 1);
  assert.equal(retry.flattenOpportunities[0]?.size, 10);
}));

test("V13 three-minute default liquidates unless a live maker has strong completion evidence", async () => withTracker(async (tracker) => {
  const event = testEvent();
  const state = residualState(.1);
  const plan = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 180);
  assert.equal(plan.flattenOpportunities[0]?.size, 10);
  const strong: LadderV13CompletionModel = { estimate: () => ({ probability: .8, upperProbability: .9,
    hazard: .1, comparableOrders: 100, completedOrders: 80, exposureSeconds: 4000, mature: true, strongEvidence: true }) };
  const maker = order("live-completion", "down-token", .44, 10);
  maker.pairId = "ladder-v13:completion-maker";
  state.orders.push(maker); state.openOrders.push(maker);
  const wait = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 180, true,
    { eligibleVolumePerSecondByToken: { "down-token": 10 } }, strong);
  assert.equal(wait.managementStage, "waiting-completion-maker");
  const final = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 30, true,
    { eligibleVolumePerSecondByToken: { "down-token": 10 } }, strong);
  assert.deepEqual(final.cancelOrderIds, [maker.id]);
  assert.equal(final.opportunities.length, 0);
}));

test("V13 cancels every competing order before selling and replans late completion fills", async () => withTracker(async (tracker) => {
  const event = testEvent();
  const state = residualState();
  const maker = order("late-no", "down-token", .44, 10);
  maker.pairId = "ladder-v13:completion-maker";
  const extra = order("extra-yes", "up-token", .2, 10);
  state.orders.push(maker, extra); state.openOrders.push(maker, extra);
  const cancel = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 30);
  assert.deepEqual(cancel.cancelOrderIds.sort(), [maker.id, extra.id].sort());
  assert.deepEqual(cancel.flattenOpportunities, []);
  maker.status = "cancelled"; maker.remainingSize = 6; extra.status = "cancelled";
  state.openOrders = [];
  state.fills.push(fill(maker, event.windowEnd - 31, 4));
  const sell = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 30);
  assert.equal(sell.pairedShares, 4);
  assert.equal(sell.flattenOpportunities[0]?.size, 6);
  state.executionPending = true;
  const blocked = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 30);
  assert.equal(blocked.managementStage, "await-execution-reconciliation");
  assert.deepEqual(blocked.flattenOpportunities, []);
  // An uncertain cancellation that reconciles as still resting must be retried,
  // rather than letting the execution barrier prevent cancellation itself.
  maker.status = "partial"; state.openOrders = [maker];
  const retryCancel = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 30);
  assert.deepEqual(retryCancel.cancelOrderIds, [maker.id]);
  assert.deepEqual(retryCancel.flattenOpportunities, []);
}));

test("V13 final exit accepts partial depth and never waits for a maker without bids", async () => withTracker(async (tracker) => {
  const event = testEvent();
  const state = residualState(.1);
  state.books[0]!.bids[0]!.size = 3.5;
  state.books.forEach((book) => { book.asks = []; book.bestAsk = null; });
  const partial = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 30);
  assert.equal(partial.flattenOpportunities[0]?.size, 3.5);
  assert.equal(partial.flattenOpportunities[0]?.price, .1);
  state.books[0]!.bids = []; state.books[0]!.bestBid = null;
  const noDepth = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 30);
  assert.equal(noDepth.managementStage, "residual-sale-no-bid-depth");
  assert.deepEqual(noDepth.opportunities, []);
  assert.deepEqual(noDepth.flattenOpportunities, []);
}));

test("V13 chooses the higher guaranteed value between immediate pairing and selling", async () => withTracker(async (tracker) => {
  const event = testEvent();
  const state = residualState(.7);
  state.books[1]!.asks = [{ price: .4, size: 100 }]; state.books[1]!.bestAsk = .4;
  const sell = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 60);
  assert.equal(sell.managementStage, "sale-beats-immediate-pair");
  assert.equal(sell.flattenOpportunities[0]?.size, 10);
  state.books[0]!.bids[0]!.price = .3; state.books[0]!.bestBid = .3;
  const pair = await planLadderV13(tracker, event, state, undefined, event.windowEnd - 60);
  assert.equal(pair.opportunities[0]?.orderPolicy, "fok");
}));

test("V13 residual episodes and lot costs survive sells and reset when balanced", () => {
  const state = residualState(.3, 5);
  const start = ladderV13Inventory(state);
  const sale = { ...order("sold", "up-token", .3, 10, "filled"), pairId: "ladder-v13:residual-sale", side: "SELL" as const };
  state.orders.push(sale);
  state.fills.push({ ...fill(sale, testEvent().windowStart + 20, 4), side: "SELL" });
  const partial = ladderV13Inventory(state);
  assert.equal(partial.episode?.id, start.episode?.id);
  assert.equal(partial.episode?.residualQuantity, 6);
  assert.ok(Math.abs(partial.unpairedCost - 3.3) < 1e-10);
  state.fills.push({ ...fill(sale, testEvent().windowStart + 21, 6), id: "sold-rest", side: "SELL" });
  const balanced = ladderV13Inventory(state);
  assert.equal(balanced.episode, null);
  assert.equal(balanced.pairedShares, 5);
  assert.equal(balanced.lockedPnl, .25);
});

test("V13 completion contexts survive restart and partial cancelled orders are censored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v13-completion-history-"));
  try {
    const event = testEvent();
    const tracker = new LadderTracker(directory, "tracker.json"); await tracker.init();
    const state = residualState(.1);
    const now = event.windowEnd - 600;
    let history = await LadderV13HistoryStore.load(directory);
    const plan = await planLadderV13(tracker, event, state, undefined, now);
    await history.observe(event, state, plan, now * 1000);
    const opportunity = plan.opportunities[0]!;
    const maker = { ...order("completion-history", "down-token", opportunity.price, 10, "open", new Date(now * 1000).toISOString()),
      pairId: opportunity.pairId, tradeKey: opportunity.tradeKey };
    state.orders.push(maker); state.openOrders.push(maker);
    history = await LadderV13HistoryStore.load(directory);
    await history.observe(event, state, { ...plan, opportunities: [] }, (now + 10) * 1000);
    history = await LadderV13HistoryStore.load(directory);
    maker.status = "cancelled"; maker.remainingSize = 5; state.openOrders = [];
    state.fills.push(fill(maker, now + 20, 5));
    await history.observe(event, state, { ...plan, opportunities: [] }, (now + 30) * 1000);
    const observations = history.completionModel.toJSON();
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.filled, false);
    assert.equal(observations[0]?.exposureSeconds, 30);
    assert.deepEqual(observations[0]?.context, plan.completionContext);
    history = await LadderV13HistoryStore.load(directory);
    await history.finalize(event, state, (now + 40) * 1000);
    assert.equal(history.completionModel.getObservationCount(), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("V13 records a completion fill even when settlement precedes the next planning pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v13-completion-finalize-"));
  try {
    const event = testEvent();
    const tracker = new LadderTracker(directory, "tracker.json"); await tracker.init();
    const history = await LadderV13HistoryStore.load(directory);
    const state = residualState(.1);
    const now = event.windowEnd - 600;
    const plan = await planLadderV13(tracker, event, state, undefined, now);
    await history.observe(event, state, plan, now * 1000);
    const opportunity = plan.opportunities[0]!;
    const maker = { ...order("final-completion", "down-token", opportunity.price, 10, "filled", new Date(now * 1000).toISOString()),
      pairId: opportunity.pairId, tradeKey: opportunity.tradeKey };
    state.orders.push(maker); state.fills.push(fill(maker, now + 15));
    await history.finalize(event, state, (now + 30) * 1000);
    const observation = history.completionModel.toJSON()[0]!;
    assert.equal(observation.filled, true);
    assert.equal(observation.fillSeconds, 15);
    assert.equal(observation.exposureSeconds, 15);
    assert.deepEqual(observation.context, plan.completionContext);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
