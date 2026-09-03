import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderV14ConditionalModel, ladderV14Parameters, type LadderV14ConditionalContext } from "../src/ladder-v14-model.js";
import { ladderV14BuyGuard, ladderV14Inventory, ladderV14SellGuard } from "../src/ladder-v14-inventory.js";
import { pairedMakerPrices, planLadderV14, type LadderV14MarketFeatures } from "../src/ladder-v14.js";
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

function flowingFeatures(
  books: readonly TokenBook[],
  flowPerSecond: number,
): LadderV14MarketFeatures {
  const result = features(books);
  result.eligibleVolumePerSecondByToken = Object.fromEntries(
    books.map((book) => [book.tokenId, flowPerSecond]),
  );
  return result;
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

test("V14 permits exactly zero hazard and makes pseudo-flow quantity-aware", () => {
  const model = new LadderV14ConditionalModel(parameters);
  const zero = model.estimateFill({
    ...baseContext,
    flowPerSecond: 0,
    queueAhead: 0,
    depth: 0,
  }, 5);
  assert.equal(zero.hazard, 0);
  assert.equal(zero.probability, 0);

  const small = model.estimateFill({
    ...baseContext,
    flowPerSecond: 0,
    queueAhead: 20,
    depth: 60,
    quantity: 10,
  }, 5);
  const large = model.estimateFill({
    ...baseContext,
    flowPerSecond: 0,
    queueAhead: 20,
    depth: 60,
    quantity: 1_000,
  }, 5);
  assert.ok(small.probability > 0);
  assert.ok(large.probability < small.probability);
});

test("V14 volume-first mode posts a profitable near-touch pair grid without EV gating", () => {
  const books = testBooks(0.65, 0.37, 1);
  books[0]!.bestBid = 0.63;
  books[0]!.bids = [{ price: 0.63, size: 500 }];
  books[1]!.bestBid = 0.35;
  books[1]!.bids = [{ price: 0.35, size: 500 }];
  const zeroModel = {
    estimateFill: () => ({ probability: 0, hazard: 0 }),
    estimateCompletion: () => ({ probability: 0, hazard: 0 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: () => 0,
  } as unknown as LadderV14ConditionalModel;
  const plan = planLadderV14(
    testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v14",
      ladderV14VolumeFirstMode: true,
      ladderV14VolumeFirstBaseShares: 40,
      ladderV14VolumeFirstLevels: 4,
    }),
    event,
    snapshot(books),
    zeroModel,
    features(books),
    event.windowEnd - 600,
  );
  assert.equal(plan.managementStage, "volume-first-post-pair-grid");
  assert.ok(plan.candidates.length >= 4);
  assert.ok(plan.candidates.every((candidate) => candidate.selectionMode === "volume"));
  const top = plan.candidates.filter((candidate) => candidate.priorityScore >= 4_000_000);
  assert.equal(top.length, 2);
  assert.equal(top[0]!.size, 40);
  assert.equal(top[1]!.size, 40);
  assert.ok(top[0]!.price + top[1]!.price <= 0.99 + 1e-8);
  assert.ok(top.some((candidate) => candidate.expectedValue === 0));
});

const repairNow = event.windowEnd - 300;
const cleanupNow = event.windowEnd - 30;
function volumePlan(state: MarketExecutionSnapshot, now = repairNow) {
  return planLadderV14(testConfig({
    exchange: "kalshi", strategyMode: "ladder_v14", ladderV14VolumeFirstMode: true,
    ladderV14QuoteLifetimeSeconds: 5,
  }), event, state, new LadderV14ConditionalModel(parameters), features([...state.books]), now);
}

function residualState(entry = 0.6, oppositeAsk = 0.43, bid = 0.25, size = 40) {
  const books = testBooks(0.65, oppositeAsk, 1);
  books[0]!.bestBid = bid;
  books[0]!.bids = [{ price: bid, size: 500 }];
  books[1]!.asks = [{ price: oppositeAsk, size: 500 }];
  const order = v14Order("repair-up", "up-token", entry, size);
  const fill = { ...v14Fill(order), timestamp: new Date(repairNow * 1_000).toISOString() };
  return snapshot(books, [order], [fill]);
}

function postedRepair(state: MarketExecutionSnapshot): PaperOrder {
  const target = volumePlan(state).opportunities[0]!;
  return { ...v14Order("repair-maker", target.token.tokenId, target.price, target.size, "open"),
    pairId: target.pairId, orderPolicy: target.orderPolicy, pairLockRole: target.pairLockRole };
}

test("V14 cancels the entire opening grid before repair and waits for reconciliation", () => {
  const state = residualState();
  const opening = [v14Order("up-open", "up-token", 0.6, 80, "open"),
    v14Order("no-open", "down-token", 0.35, 320, "open")];
  state.orders = [...state.orders, ...opening];
  state.openOrders = opening;
  const plan = volumePlan(state);
  assert.deepEqual(plan.cancelOrderIds, opening.map((order) => order.id));
  assert.equal(plan.opportunities.length, 0);
  assert.equal(plan.amendments.length, 0);
  assert.equal(plan.candidates.length, 0);
  const pending = volumePlan({ ...state, executionPending: true });
  assert.equal(pending.managementStage, "await-execution-reconciliation");
  assert.equal(pending.opportunities.length, 0);
});

test("V14 buys exactly the missing quantity immediately when all-in pairing is profitable", () => {
  const state = residualState(0.52, 0.44);
  const plan = volumePlan(state);
  assert.equal(plan.managementStage, "volume-first-repair-profitable-taker");
  assert.equal(plan.opportunities.length, 1);
  assert.equal(plan.opportunities[0]!.token.tokenId, "down-token");
  assert.equal(plan.opportunities[0]!.size, 40);
  assert.equal(plan.opportunities[0]!.orderPolicy, "fak");
  assert.equal(plan.candidates.length, 0);
});

test("V14 profitable repair includes both entry fees and current taker fees", () => {
  const state = residualState(0.55, 0.44);
  state.takerFeeRate = 0.07;
  assert.equal(volumePlan(state).opportunities[0]!.orderPolicy, "post_only");
  state.takerFeeRate = 0;
  state.fills = state.fills.map((fill) => ({ ...fill, fee: 0.8 }));
  assert.equal(volumePlan(state).opportunities[0]!.orderPolicy, "post_only");
});

test("V14 posts one aggressive missing-side maker for R with no base quantity or surplus orders", () => {
  const state = residualState(0.6, 0.43, 0.25, 200);
  const no = v14Order("paired-no", "down-token", 0.3, 160);
  state.orders = [...state.orders, no];
  state.fills = [...state.fills, { ...v14Fill(no), timestamp: new Date(repairNow * 1000).toISOString() }];
  const plan = volumePlan(state);
  assert.equal(plan.unpairedShares, 40);
  assert.equal(plan.opportunities.length, 1);
  const target = plan.opportunities[0]!;
  assert.equal(target.token.tokenId, "down-token");
  assert.equal(target.size, 40);
  assert.equal(target.price, 0.39);
  assert.equal(target.orderPolicy, "post_only");
  assert.equal(plan.nextWakeAtMs, cleanupNow * 1000);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.flattenOpportunities.length, 0);
});

test("V14 keeps the same repair deadline after partial fills, repricing, and replay", () => {
  const state = residualState();
  const maker = postedRepair(state);
  maker.status = "partial";
  maker.remainingSize = 25;
  state.orders = [...state.orders, maker];
  state.openOrders = [maker];
  state.fills = [...state.fills, { ...v14Fill(maker, 15), timestamp: new Date((repairNow + 3) * 1000).toISOString() }];
  const plan = volumePlan(state, repairNow + 4);
  assert.equal(plan.unpairedShares, 25);
  assert.equal(plan.managementStage, "volume-first-repair-maker-resting");
  assert.equal(plan.opportunities.length, 0);
  assert.equal(plan.nextWakeAtMs, cleanupNow * 1000);
  // Replacement and reconstruction from persisted fills do not start a new clock.
  const replayed = JSON.parse(JSON.stringify(state)) as MarketExecutionSnapshot;
  replayed.books[1]!.bestAsk = 0.39;
  const replaced = volumePlan(replayed, repairNow + 4);
  assert.deepEqual(replaced.cancelOrderIds, [maker.id]);
  assert.equal(replaced.nextWakeAtMs, plan.nextWakeAtMs);
  assert.equal(volumePlan(replayed, cleanupNow).managementStage,
    "volume-first-repair-cancel-before-exit");
  replayed.openOrders = [];
  const expired = volumePlan(replayed, cleanupNow);
  assert.equal(expired.opportunities[0]!.size, 25);
  assert.equal(expired.opportunities[0]!.orderPolicy, "fak");
  assert.equal(expired.nextWakeAtMs, undefined);
});

test("V14 stays repair-only at 1/100 and 99/100 filled, resuming only at 100/100", () => {
  const state = residualState(0.6, 0.43, 0.25, 100);
  const maker = postedRepair(state);
  state.orders = [...state.orders, maker];
  state.openOrders = [maker];
  const opening = { ...volumePlan(residualState()).opportunities[0]!, pairId: "ladder-v14:opening" };
  for (const filled of [1, 99]) {
    maker.status = "partial";
    maker.remainingSize = 100 - filled;
    state.fills = [state.fills[0]!, { ...v14Fill(maker, filled),
      timestamp: new Date((repairNow + filled) * 1000).toISOString() }];
    // Simulate reconstruction after a process restart, not an in-memory flag.
    const replayed = structuredClone(state);
    const plan = volumePlan(replayed, repairNow + filled);
    assert.equal(plan.unpairedShares, 100 - filled);
    assert.equal(plan.managementStage, "volume-first-repair-maker-resting");
    assert.equal(plan.opportunities.length, 0);
    assert.equal(ladderV14BuyGuard(replayed, opening), "repair_only_while_unpaired");
  }
  // A filled order acknowledgment without the final ledger fill is insufficient.
  maker.status = "filled";
  maker.remainingSize = 0;
  state.openOrders = [];
  const unconfirmed = volumePlan(state, repairNow + 100);
  assert.equal(unconfirmed.unpairedShares, 1);
  assert.equal(unconfirmed.opportunities[0]!.size, 1);
  assert.ok(unconfirmed.opportunities[0]!.pairId?.startsWith("ladder-v14:repair-"));
  state.fills = [...state.fills, { ...v14Fill(maker, 1), id: "last-repair-share",
    timestamp: new Date((repairNow + 101) * 1000).toISOString() }];
  const complete = volumePlan(state, repairNow + 101);
  assert.equal(complete.unpairedShares, 0);
  assert.equal(complete.managementStage, "volume-first-post-pair-grid");
});

test("V14 full fill of a small hedge clip does not end repair of the larger residual", () => {
  const state = residualState(0.6, 0.3, 0.25, 100);
  state.books[1]!.asks = [{ price: 0.3, size: 10 }];
  const target = volumePlan(state).opportunities[0]!;
  assert.equal(target.size, 10);
  const clip = { ...v14Order("repair-clip", target.token.tokenId, target.price, 10),
    tradeKey: target.tradeKey, pairId: target.pairId, orderPolicy: target.orderPolicy };
  state.orders = [...state.orders, clip];
  state.fills = [...state.fills, { ...v14Fill(clip),
    timestamp: new Date((repairNow + 1) * 1000).toISOString() }];
  const plan = volumePlan(state, repairNow + 2);
  assert.equal(plan.unpairedShares, 90);
  assert.ok(plan.managementStage.startsWith("volume-first-repair-"));
  assert.equal(plan.candidates.length, 0);
  assert.ok(plan.opportunities.every((order) => order.pairId?.startsWith("ladder-v14:repair-")));
});

test("V14 recomputes R after in-flight fills during cancellation", () => {
  const state = residualState();
  const late = v14Order("late-fill", "up-token", 0.6, 10);
  state.orders = [...state.orders, late];
  state.fills = [...state.fills, { ...v14Fill(late), timestamp: new Date((repairNow + 1) * 1000).toISOString() }];
  const plan = volumePlan(state, repairNow + 2);
  assert.equal(plan.opportunities[0]!.size, 50);
  assert.equal(plan.nextWakeAtMs, cleanupNow * 1000);
});

test("V14 final cleanup locks a smaller loss rather than making a worse residual sale", () => {
  const plan = volumePlan(residualState(0.6, 0.43, 0.25), cleanupNow);
  assert.equal(plan.managementStage, "volume-first-repair-cleanup-hedge");
  assert.equal(plan.opportunities[0]!.price, 0.43);
  assert.equal(plan.opportunities[0]!.size, 40);
  assert.equal(plan.flattenOpportunities.length, 0);
});

test("V14 cleanup sells when net bid beats the hedge and hedges on a tie", () => {
  const sale = volumePlan(residualState(0.6, 0.8, 0.4), cleanupNow);
  assert.equal(sale.managementStage, "volume-first-repair-cleanup-sale");
  assert.equal(sale.flattenOpportunities[0]!.token.tokenId, "up-token");
  assert.equal(sale.flattenOpportunities[0]!.size, 40);
  assert.equal(sale.opportunities.length, 0);
  const tie = volumePlan(residualState(0.6, 0.8, 0.2), cleanupNow);
  assert.equal(tie.managementStage, "volume-first-repair-cleanup-hedge");
});

test("V14 cancels a resting repair before taking and compares matching executable depth", () => {
  const state = residualState(0.6, 0.8, 0.4);
  const maker = postedRepair(state);
  state.orders = [...state.orders, maker];
  state.openOrders = [maker];
  const cancel = volumePlan(state, cleanupNow);
  assert.deepEqual(cancel.cancelOrderIds, [maker.id]);
  assert.equal(cancel.opportunities.length + cancel.flattenOpportunities.length, 0);
  state.openOrders = [];
  state.books[0]!.bids = [{ price: 0.4, size: 5 }];
  const partial = volumePlan(state, cleanupNow);
  assert.equal(partial.flattenOpportunities[0]!.size, 5);
});

test("V14 handles missing depth and final cleanup without starting another maker wait", () => {
  const state = residualState();
  state.books[1]!.asks = [];
  state.books[1]!.bestAsk = null;
  assert.equal(volumePlan(state, cleanupNow).flattenOpportunities[0]!.size, 40);
  state.books[0]!.bids = [];
  const empty = volumePlan(state, cleanupNow);
  assert.equal(empty.opportunities.length + empty.flattenOpportunities.length, 0);
  assert.equal(empty.nextWakeAtMs, undefined);
  const finalState = residualState();
  finalState.fills = finalState.fills.map((fill) => ({ ...fill,
    timestamp: new Date((event.windowEnd - 20) * 1000).toISOString() }));
  const final = volumePlan(finalState, event.windowEnd - 20);
  assert.equal(final.opportunities[0]!.orderPolicy, "fak");
  assert.equal(final.managementStage, "volume-first-repair-cleanup-hedge");
});

test("V14 resumes the unchanged grid once repair balances inventory", () => {
  const state = residualState();
  const maker = postedRepair(state);
  maker.status = "filled";
  maker.remainingSize = 0;
  state.orders = [...state.orders, maker];
  state.fills = [...state.fills, { ...v14Fill(maker), timestamp: new Date((repairNow + 2) * 1000).toISOString() }];
  const plan = volumePlan(state, repairNow + 2);
  assert.equal(plan.managementStage, "volume-first-post-pair-grid");
  assert.equal(plan.unpairedShares, 0);
  assert.equal(plan.nextWakeAtMs, undefined);
  assert.ok(plan.opportunities.some((target) => target.token.tokenId === "up-token"));
  assert.ok(plan.opportunities.some((target) => target.token.tokenId === "down-token"));
  state.openOrders = [{ ...maker, status: "open", remainingSize: 1 }];
  const stale = volumePlan(state, repairNow + 2);
  assert.deepEqual(stale.cancelOrderIds, [maker.id]);
  assert.equal(stale.opportunities.length, 0);
});

test("V14 mutation guard rejects stale grids, duplicate or oversized repair, and pending reconciliation", () => {
  const state = residualState();
  const target = volumePlan(state).opportunities[0]!;
  assert.equal(ladderV14BuyGuard(state, target), null);
  assert.equal(ladderV14BuyGuard(state, { ...target, pairId: "ladder-v14:opening" }),
    "repair_only_while_unpaired");
  assert.equal(ladderV14BuyGuard(state, { ...target, size: 41 }), "buy_exceeds_v14_missing_quantity");
  assert.equal(ladderV14BuyGuard(state, { ...target, token: state.books[0]! }),
    "buy_exceeds_v14_missing_quantity");
  assert.equal(ladderV14BuyGuard(state, { ...target, size: 39 }), "repair_maker_must_match_residual");
  assert.equal(ladderV14BuyGuard({ ...state, executionPending: true }, target),
    "pending_execution_reconciliation");
  assert.equal(ladderV14BuyGuard({ ...state, openOrders: [postedRepair(state)] }, target),
    "cancel_v14_orders_before_repair");
});

test("V14 does not force a losing taker hedge at five seconds or chase a losing maker price", () => {
  const state = residualState(0.6, 0.43, 0.57);
  state.makerFeeRate = 0.0175;
  for (const elapsed of [0, 5, 30, 120]) {
    const plan = volumePlan(state, repairNow + elapsed);
    assert.equal(plan.opportunities.length, 1);
    const quote = plan.opportunities[0]!;
    assert.equal(quote.orderPolicy, "post_only");
    assert.ok(quote.price <= 0.39);
    assert.equal(quote.size, 40);
    assert.equal(plan.flattenOpportunities.length, 0);
    assert.equal(plan.nextWakeAtMs, cleanupNow * 1000);
  }
});

test("V14 collapsed 0.1-cent ladder levels aggregate and converge without amendment oscillation", () => {
  const books = testBooks(0.99, 0.011, 0.01);
  const fineEvent = { ...event, market: { ...event.market, orderPriceMinTickSize: 0.001 } };
  const state = snapshot(books);
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v14", ladderV14VolumeFirstMode: true });
  const model = new LadderV14ConditionalModel(parameters);
  const plan = planLadderV14(config, fineEvent, state, model, features(books), repairNow);
  const keys = plan.candidates.map(candidate => `${candidate.tokenId}:${candidate.price}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(plan.candidates.find(candidate => candidate.tokenId === "down-token" && candidate.price === 0.001)?.size, 560);
  for (const book of books) assert.equal(plan.candidates.filter(c=>c.tokenId===book.tokenId).reduce((sum,c)=>sum+c.size,0), 600);
  const resting = plan.opportunities.map((target, index) => ({
    ...v14Order(`aggregate-${index}`, target.token.tokenId, target.price, target.size, "open"),
  }));
  state.orders = resting;
  state.openOrders = resting;
  for (let index = 0; index < 10; index++) {
    const next = planLadderV14(config, fineEvent, state, model, features(books), repairNow + index);
    assert.equal(next.amendments.length + next.opportunities.length + next.cancelOrderIds.length, 0);
  }
});

test("V14 constant-time pair prices match the exhaustive integer-tick objective", () => {
  for (const tick of [0.1, 0.01, 0.001]) {
    for (let sample = 1; sample <= 12; sample++) {
      const left = 1 + (sample * 37) % Math.round(0.9/tick);
      const right = 1 + (sample * 61) % Math.round(0.9/tick);
      const budget = Math.round(0.93/tick);
      const books = testBooks((left+1)*tick, (right+1)*tick, 1);
      let expected: [number,number] | null = null, best = -Infinity;
      for (let y=left; y>=1; y--) for (let n=right; n>=1; n--) {
        if (y+n>budget) continue;
        const score = (y+n)*10000 - Math.abs((left-y)-(right-n))*100 - (left-y+right-n);
        if (score > best) {best=score;expected=[Number((y*tick).toFixed(4)),Number((n*tick).toFixed(4))];}
      }
      assert.deepEqual(pairedMakerPrices(books, tick, budget*tick), expected);
    }
  }
});

test("V14 requires every cumulative quantity segment to have positive marginal EV", () => {
  const books = testBooks(0.45, 0.45, 1);
  const marginalModel = {
    estimateFill: (context: LadderV14ConditionalContext) => ({
      probability: context.quantity <= 10 ? 1 : context.quantity <= 20 ? 0.4 : 0.01,
      hazard: 1,
    }),
    estimateCompletion: () => ({ probability: 1, hazard: 1 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: () => 0,
  } as unknown as LadderV14ConditionalModel;
  const plan = planLadderV14(
    testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" }),
    event,
    snapshot(books),
    marginalModel,
    flowingFeatures(books, 100),
    event.windowEnd - 600,
  );
  assert.ok(plan.candidates.length > 0);
  assert.ok(plan.candidates.every((candidate) => candidate.size <= 10));
  assert.ok(plan.candidates.every((candidate) =>
    candidate.quantityOptions.every((option) => option.marginalValue > 0)
  ));
});

test("V14 bounds quotes by reachable flow and ranks them by profit turnover", () => {
  const books = testBooks(0.65, 0.37, 1);
  books[0]!.bestBid = 0.63;
  books[0]!.bids = [{ price: 0.63, size: 500 }];
  books[1]!.bestBid = 0.35;
  books[1]!.bids = [{ price: 0.35, size: 500 }];
  const alwaysPairs = {
    estimateFill: () => ({ probability: 0.7, hazard: 0.25 }),
    estimateCompletion: () => ({ probability: 1, hazard: 0.5 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: () => 0,
  } as unknown as LadderV14ConditionalModel;
  const plan = planLadderV14(
    testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v14",
      ladderV14QuoteLifetimeSeconds: 5,
      ladderV14ReachabilityMultiplier: 1,
    }),
    event,
    snapshot(books),
    alwaysPairs,
    flowingFeatures(books, 40),
    event.windowEnd - 600,
  );
  assert.ok(plan.candidates.length > 0);
  assert.ok(plan.candidates.every((candidate) => candidate.size <= 200));
  assert.ok(plan.candidates.every((candidate) => candidate.price > 0.1));
  for (let index = 1; index < plan.candidates.length; index += 1) {
    assert.ok(
      plan.candidates[index - 1]!.expectedProfitRate + 1e-12 >=
        plan.candidates[index]!.expectedProfitRate,
    );
  }
});

test("V14 conditions deeper maker layers on all more-aggressive fills", () => {
  const books = testBooks(0.45, 0.55, 1);
  books[0]!.bids = [{ price: 0.4, size: 40 }];
  books[1]!.bids = [{ price: 0.5, size: 40 }];
  books[0]!.asks = [{ price: 0.45, size: 100 }];
  books[1]!.asks = [{ price: 0.55, size: 100 }];
  const alwaysPairs = {
    estimateFill: () => ({ probability: 1, hazard: 1 }),
    estimateCompletion: () => ({ probability: 1, hazard: 1 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: (context: LadderV14ConditionalContext) => context.currentBid ?? 0,
  } as unknown as LadderV14ConditionalModel;
  const plan = planLadderV14(
    testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" }),
    event,
    snapshot(books),
    alwaysPairs,
    flowingFeatures(books, 100),
    event.windowEnd - 600,
  );
  assert.ok(plan.candidates.length >= 2);
  assert.ok(plan.candidates.some((candidate) => candidate.sweepPrefixShares > 0));
  assert.ok(plan.candidates.every((candidate) => candidate.expectedValue > 0));
  for (const outcome of ["Up", "Down"]) {
    let selectedPrefix = 0;
    for (const candidate of plan.candidates
      .filter((item) => item.outcome === outcome)
      .sort((left, right) => right.price - left.price)) {
      assert.equal(candidate.sweepPrefixShares, selectedPrefix);
      selectedPrefix += candidate.size;
    }
  }
});

test("V14 prices conditional passive completion at its maker quote", () => {
  const books = testBooks(0.5, 0.52, 1);
  books[0]!.bids = [{ price: 0.48, size: 100 }];
  books[1]!.bids = [{ price: 0.49, size: 100 }];
  books[0]!.asks = [{ price: 0.5, size: 100 }];
  books[1]!.asks = [{ price: 0.52, size: 100 }];
  const alwaysPairs = {
    estimateFill: () => ({ probability: 1, hazard: 1 }),
    estimateCompletion: () => ({ probability: 1, hazard: 1 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: (context: LadderV14ConditionalContext) => context.currentBid ?? 0,
  } as unknown as LadderV14ConditionalModel;
  const plan = planLadderV14(
    testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" }),
    event,
    snapshot(books),
    alwaysPairs,
    flowingFeatures(books, 100),
    event.windowEnd - 600,
  );
  const yesAt48 = plan.candidates.find(
    (candidate) => candidate.tokenId === "up-token" && candidate.price === 0.48,
  );
  assert.ok(yesAt48);
  assert.ok(yesAt48.expectedCompletionCost >= 0.51);
  assert.ok(yesAt48.expectedCompletionCost < 0.511);
  assert.ok(yesAt48.expectedValue > 0);
});

test("V14 keeps one aggregate maker order per outcome and price", () => {
  const books = testBooks(0.45, 0.55, 1);
  books[0]!.bids = [{ price: 0.4, size: 40 }];
  books[1]!.bids = [{ price: 0.5, size: 40 }];
  const alwaysPairs = {
    estimateFill: () => ({ probability: 1, hazard: 1 }),
    estimateCompletion: () => ({ probability: 1, hazard: 1 }),
    expectedCompletionCost: (_context: LadderV14ConditionalContext, fallback: number) => fallback,
    expectedFailedExit: (context: LadderV14ConditionalContext) => context.currentBid ?? 0,
  } as unknown as LadderV14ConditionalModel;
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v14" });
  const initial = planLadderV14(
    config, event, snapshot(books), alwaysPairs, flowingFeatures(books, 100), event.windowEnd - 600,
  );
  const target = initial.opportunities[0]!;
  const first = v14Order("duplicate-a", target.token.tokenId, target.price, target.size, "open");
  const second = v14Order("duplicate-b", target.token.tokenId, target.price, target.size, "open");
  const reconciled = planLadderV14(
    config,
    event,
    snapshot(books, [first, second]),
    alwaysPairs,
    flowingFeatures(books, 100),
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
    {
      estimateCompletion: () => ({ probability: 0, hazard: 0 }),
      expectedCompletionCost: () => 0.42,
      expectedFailedExit: () => 0.1,
    } as unknown as LadderV14ConditionalModel,
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

test("V14 paper executor rechecks residuals for batch buys, amendments, and duplicate repairs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-v14-repair-"));
  const trader = new PaperTrader(testConfig({
    exchange: "kalshi", strategyMode: "ladder_v14", ladderV14VolumeFirstMode: true,
    paperStatePath: directory,
  }), { stream: { subscribe: async () => undefined, close: () => undefined },
    settlementLoader: async () => null });
  try {
    await trader.init();
    const books = testBooks(0.65, 0.43, 1);
    await trader.observeMarket(event, books);
    const opening: TradeOpportunity = {
      kind: "maker", event, token: books[0]!, price: 0.6, size: 40,
      tickSize: "0.01", negRisk: false, tradeKey: "ladder-v14:guard-up",
      strategyMode: "ladder_v14", pairId: "ladder-v14:opening",
      orderPolicy: "post_only", pairLockRole: "opening",
    };
    const other = { ...opening, tradeKey: "ladder-v14:guard-down", token: books[1]!, price: 0.4, size: 80 };
    assert.equal((await trader.placeBuy(opening)).accepted, true);
    assert.equal((await trader.placeBuy(other)).accepted, true);
    const downId = trader.snapshot().orders.find((order) => order.tokenId === "down-token")!.id;
    const createdAt = Date.parse(trader.snapshot().orders[0]!.createdAt);
    await trader.ingestMarketEvent({
      event_type: "last_trade_price", asset_id: "up-token", side: "SELL",
      price: "0.6", size: "200", timestamp: createdAt + 1,
    });
    assert.equal(ladderV14Inventory(trader.getMarketExecutionSnapshot(event.slug)!).unpairedShares, 40);
    const stale = await trader.placeBuys([
      { ...opening, tradeKey: "ladder-v14:stale-up" },
      { ...other, tradeKey: "ladder-v14:stale-down" },
    ]);
    assert.ok(stale.every((result) => result.accepted === false));
    assert.equal((await trader.amendOrder(downId, { ...other, size: 120 })).accepted, false);
    const repair = { ...other, tradeKey: "ladder-v14:guard-repair", size: 40,
      pairId: "ladder-v14:repair-maker:test" };
    assert.equal((await trader.placeBuy(repair)).accepted, false);
    await trader.cancelOrders([downId]);
    assert.equal((await trader.placeBuy(repair)).accepted, true);
    assert.equal((await trader.placeBuy({ ...repair, tradeKey: "ladder-v14:duplicate-repair" })).accepted, false);
  } finally {
    await trader.close();
    await rm(directory, { recursive: true, force: true });
  }
});
