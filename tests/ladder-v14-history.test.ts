import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderV14HistoryStore } from "../src/ladder-v14-history.js";
import { LadderV14ConditionalModel, ladderV14Parameters } from "../src/ladder-v14-model.js";
import { planLadderV14, type LadderV14PlacementContext } from "../src/ladder-v14.js";
import type { MarketExecutionSnapshot, PaperFill, PaperOrder } from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

const parameters = ladderV14Parameters({
  priorStrength: 5, flowWindowSeconds: 60, volatilityWindowSeconds: 60, finalCleanupSeconds: 30,
});

function repairFixture(kind: LadderV14PlacementContext["kind"] = "completion") {
  const atMs = Date.now();
  const config = testConfig({ strategyMode: "ladder_v14", ladderV14VolumeFirstMode: true });
  const event = { ...testEvent(), windowEnd: atMs / 1000 + 900 };
  const order: PaperOrder = {
    id: "repair", tradeKey: "ladder-v14:repair:100", pairId: "ladder-v14:repair-maker:episode",
    marketSlug: event.slug, marketTitle: event.title, conditionId: event.market.conditionId,
    tokenId: "down-token", outcome: "Down", limitPrice: 0.4,
    originalSize: 100, remainingSize: 100, queueAhead: 0,
    status: "open", side: "BUY", orderPolicy: "post_only",
    createdAt: new Date(atMs).toISOString(),
  };
  const snapshot: MarketExecutionSnapshot = {
    marketSlug: event.slug, orders: [order], openOrders: [order], fills: [], positions: [],
    books: testBooks(0.5, 0.5), capitalUsed: 0, openCommitted: 0, capitalCommitted: 0,
    availableCash: 1000, totalFees: 0, estimatedMakerRebate: 0, takerFeeRate: 0.07,
    takerFeeExponent: 1, settledPnl: null, executionPending: false,
  };
  const model = new LadderV14ConditionalModel(parameters);
  const plan = planLadderV14(config, event, { ...snapshot, orders: [], openOrders: [] }, model);
  const placement: LadderV14PlacementContext = {
    kind,
    context: {
      ...Object.values(plan.placementContexts)[0]!.context,
      side: "Down", quantity: 100,
    },
  };
  plan.placementContexts = { [order.tradeKey]: placement };
  const emptyPlan = { ...plan, placementContexts: {} };
  function fill(size: number, seconds: number, id = `fill-${seconds}`): PaperFill {
    return {
      id, orderId: order.id, marketSlug: event.slug, tokenId: order.tokenId,
      outcome: order.outcome, price: order.limitPrice, fee: 0, size, side: "BUY",
      liquidity: "maker", timestamp: new Date(atMs + seconds * 1000).toISOString(),
    };
  }
  return { atMs, config, event, order, snapshot, plan, emptyPlan, placement, fill };
}

test("V14 repair learning waits for 100/100 confirmed shares across partial fills and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v14-full-repair-"));
  const f = repairFixture();
  let store = await LadderV14HistoryStore.load(directory, f.config);
  try {
    store.observe(f.event, f.snapshot, f.plan, f.atMs);
    f.order.status = "partial";
    f.order.remainingSize = 99;
    // Repeated delivery of the same fill cannot satisfy a 100-share target.
    f.snapshot.fills = Array.from({ length: 100 }, () => f.fill(1, 1));
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 1000);
    assert.equal(store.model.estimateCompletion(f.placement.context, 60).observations, 0);
    await store.flush();
    const path = join(directory, "ladder-v14-history.json");
    let saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.active.length, 1);
    assert.equal(saved.active[0][1].targetFilledSize, 100);
    assert.equal(saved.observedOrderIds.length, 0);
    store = await LadderV14HistoryStore.load(directory, f.config);
    f.snapshot.fills = [f.fill(1, 1), f.fill(98, 3)];
    f.order.remainingSize = 1;
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 3000);
    assert.equal(store.model.estimateCompletion(f.placement.context, 60).observations, 0);
    // Exchange status can precede the fill ledger; it is not full confirmation.
    f.order.status = "filled";
    f.order.remainingSize = 0;
    f.snapshot.openOrders = [];
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 4000);
    assert.equal(store.model.estimateCompletion(f.placement.context, 60).observations, 0);
    f.snapshot.fills = [...f.snapshot.fills, f.fill(1, 5)];
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 6000);
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 7000);
    assert.deepEqual(store.model.toJSON().hazards[0]![1], {
      events: 1, observations: 1, exposureSeconds: 5,
    });
    assert.equal(store.model.toJSON().completionCosts[0]![1].count, 3);
    await store.flush();
    saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.active.length, 0);
    assert.deepEqual(saved.observedOrderIds, [f.order.id]);
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("V14 cancelled partial repairs are censored and a replacement must fill its whole remainder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v14-repair-cancel-"));
  const f = repairFixture();
  const store = await LadderV14HistoryStore.load(directory, f.config);
  try {
    store.observe(f.event, f.snapshot, f.plan, f.atMs);
    f.snapshot.fills = [f.fill(1, 1)];
    f.order.status = "cancelled";
    f.order.remainingSize = 99;
    f.snapshot.openOrders = [];
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 6000);
    assert.deepEqual(store.model.toJSON().hazards[0]![1], {
      events: 0, observations: 1, exposureSeconds: 6,
    });
    const replacement: PaperOrder = {
      ...f.order, id: "replacement", tradeKey: "ladder-v14:replacement:99",
      originalSize: 99, remainingSize: 99, status: "open",
      createdAt: new Date(f.atMs + 7000).toISOString(),
    };
    f.snapshot.orders = [...f.snapshot.orders, replacement];
    f.snapshot.openOrders = [replacement];
    const placement = { ...f.placement, context: { ...f.placement.context, quantity: 99 } };
    store.observe(f.event, f.snapshot, {
      ...f.emptyPlan, placementContexts: { [replacement.tradeKey]: placement },
    }, f.atMs + 7000);
    replacement.status = "filled";
    replacement.remainingSize = 0;
    f.snapshot.openOrders = [];
    f.snapshot.fills = [...f.snapshot.fills, { ...f.fill(99, 8), orderId: replacement.id }];
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 8000);
    const stats = store.model.toJSON().hazards.map(([, value]) => value);
    assert.equal(stats.reduce((sum, value) => sum + value.events, 0), 1);
    assert.equal(stats.reduce((sum, value) => sum + value.observations, 0), 2);
    assert.equal(stats.reduce((sum, value) => sum + value.exposureSeconds, 0), 7);
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("V14 amended repair does not count old fills as filling the new remaining quantity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v14-repair-amend-"));
  const f = repairFixture();
  const store = await LadderV14HistoryStore.load(directory, f.config);
  try {
    store.observe(f.event, f.snapshot, f.plan, f.atMs);
    f.order.status = "partial";
    f.order.remainingSize = 40;
    f.snapshot.fills = [f.fill(60, 1)];
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 1000);
    f.order.tradeKey = "ladder-v14:repair:amended:40";
    f.order.lastAmendedAt = new Date(f.atMs + 2000).toISOString();
    const placement = { ...f.placement, context: { ...f.placement.context, quantity: 40 } };
    store.observe(f.event, f.snapshot, {
      ...f.emptyPlan, placementContexts: { [f.order.tradeKey]: placement },
    }, f.atMs + 2000);
    assert.equal(store.model.estimateCompletion(placement.context, 60).observations, 0);
    assert.deepEqual(store.model.toJSON().hazards[0]![1], {
      events: 0, observations: 1, exposureSeconds: 2,
    });
    f.snapshot.fills = [...f.snapshot.fills, f.fill(40, 4)];
    f.order.remainingSize = 0;
    f.order.status = "filled";
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 5000);
    assert.deepEqual(store.model.toJSON().hazards[1]![1], {
      events: 1, observations: 1, exposureSeconds: 2,
    });
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("V14 waits for cancellation reconciliation to include late full repair fills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v14-repair-reconcile-"));
  const f = repairFixture();
  const store = await LadderV14HistoryStore.load(directory, f.config);
  try {
    store.observe(f.event, f.snapshot, f.plan, f.atMs);
    f.order.status = "cancelled";
    f.order.remainingSize = 99;
    f.snapshot.fills = [f.fill(1, 1)];
    f.snapshot.executionPending = true;
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 2000);
    assert.equal(store.model.estimateCompletion(f.placement.context, 60).observations, 0);
    f.snapshot.fills = [...f.snapshot.fills, f.fill(99, 3)];
    f.snapshot.executionPending = false;
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 4000);
    assert.deepEqual(store.model.toJSON().hazards[0]![1], {
      events: 1, observations: 1, exposureSeconds: 3,
    });
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const finalSize of [1, 100]) {
  test(`V14 settlement counts ${finalSize}/100 repair shares as ${finalSize === 100 ? "complete" : "incomplete"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "v14-repair-finalize-"));
    const f = repairFixture();
    const store = await LadderV14HistoryStore.load(directory, f.config);
    try {
      store.observe(f.event, f.snapshot, f.plan, f.atMs);
      f.snapshot.fills = [f.fill(finalSize, 5)];
      store.finalize(f.snapshot, f.atMs + 10000);
      assert.deepEqual(store.model.toJSON().hazards[0]![1], {
        events: finalSize === 100 ? 1 : 0, observations: 1,
        exposureSeconds: finalSize === 100 ? 5 : 10,
      });
      store.finalize(f.snapshot, f.atMs + 11000);
      assert.equal(store.model.toJSON().hazards[0]![1].observations, 1);
    } finally {
      await store.flush();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("V14 opening fill learning still measures the first fill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v14-opening-first-fill-"));
  const f = repairFixture("fill");
  const store = await LadderV14HistoryStore.load(directory, f.config);
  try {
    store.observe(f.event, f.snapshot, f.plan, f.atMs);
    f.order.status = "partial";
    f.order.remainingSize = 99;
    f.snapshot.fills = [f.fill(1, 1)];
    store.observe(f.event, f.snapshot, f.emptyPlan, f.atMs + 2000);
    assert.deepEqual(store.model.toJSON().hazards[0]![1], {
      events: 1, observations: 1, exposureSeconds: 1,
    });
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("V14 preserves legacy first-fill statistics without using them as full-completion evidence", () => {
  const { placement } = repairFixture();
  const seed = new LadderV14ConditionalModel(parameters);
  seed.observeHazard("fill", placement.context, 5, true);
  seed.observeHazard("completion", placement.context, 1, true);
  const legacy = seed.toJSON();
  legacy.hazards = legacy.hazards.map(([key, stats]) => [key.replace(/^completion-full\|/, "completion|"), stats]);
  const model = new LadderV14ConditionalModel(parameters, legacy);
  assert.equal(model.estimateFill(placement.context, 60).observations, 1);
  assert.equal(model.estimateCompletion(placement.context, 60).observations, 0);
  assert.equal(model.estimateCompletion({ ...placement.context, executionMode: "live" }, 60).observations, 0);
  assert.deepEqual(model.toJSON(), legacy);
  model.observeHazard("completion", placement.context, 50, true);
  assert.equal(model.estimateCompletion(placement.context, 60).observations, 1);
  assert.equal(model.estimateCompletion({ ...placement.context, executionMode: "live" }, 60).observations, 1);
  assert.equal(model.toJSON().hazards.length, 3);
});

test("V14 history removes expired/rejected placements and coalesces writes without losing learning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v14-history-bounds-"));
  const config = testConfig({strategyMode:"ladder_v14",ladderV14VolumeFirstMode:true});
  const event = testEvent();
  event.windowEnd = Date.now()/1000 + 900;
  const snapshot: MarketExecutionSnapshot = {
    marketSlug:event.slug, orders:[],openOrders:[],fills:[],positions:[],books:testBooks(0.5,0.5),
    capitalUsed:0,openCommitted:0,capitalCommitted:0,availableCash:1000,totalFees:0,
    estimatedMakerRebate:0,takerFeeRate:0.07,takerFeeExponent:1,settledPnl:null,
  };
  let store = await LadderV14HistoryStore.load(directory,config);
  try {
    const plan = planLadderV14(config,event,snapshot,store.model);
    const placement = Object.values(plan.placementContexts)[0]!;
    store.model.observeHazard("fill", placement.context, 5, true);
    const learned = store.model.toJSON();
    // A blocked filesystem must not enqueue many full historical snapshots.
    let release!: () => void;
    const internal = store as unknown as {persistence:Promise<void>;persist():Promise<void>};
    internal.persistence = new Promise<void>(resolve => {release=resolve;});
    store.observe(event,snapshot,{...plan,placementContexts:{first:placement}});
    const flush = store.flush();
    const inFlight = internal.persistence;
    store.observe(event,snapshot,{...plan,placementContexts:{second:placement}});
    const another = internal.persist();
    assert.equal(internal.persistence,inFlight,"must coalesce, not append another write");
    release();
    await Promise.all([flush,another]);
    const path = join(directory,"ladder-v14-history.json");
    let saved = JSON.parse(await readFile(path,"utf8"));
    assert.equal(saved.planned.length,2);
    assert.deepEqual(saved.model,learned);
    // Regression fixture mirrors the expired contexts in the supplied file.
    const expired = `ladder-v14:${testEvent().slug}:repair-maker:old:40:1`;
    await writeFile(path,JSON.stringify({...saved,planned:[[expired,placement]]}));
    store = await LadderV14HistoryStore.load(directory,config);
    await store.flush();
    saved = JSON.parse(await readFile(path,"utf8"));
    assert.equal(saved.planned.length,0);
    assert.deepEqual(saved.model,learned);
    store.observe(event,snapshot,{...plan,placementContexts:{[expired]:placement}});
    store.finalize(snapshot);
    await store.flush();
    saved = JSON.parse(await readFile(path,"utf8"));
    assert.equal(saved.planned.length,0);
    assert.deepEqual(saved.model,learned);
  } finally {
    await store.flush();
    await rm(directory,{recursive:true,force:true});
  }
});
