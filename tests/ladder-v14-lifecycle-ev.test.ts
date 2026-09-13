import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LadderV14LifecycleModel,
  entryBucket,
  sizeBucket,
  adverseBucket,
} from "../src/ladder-v14-lifecycle-ev.js";
import { LadderV14HistoryStore } from "../src/ladder-v14-history.js";
import {
  LadderV14ConditionalModel,
  ladderV14Parameters,
} from "../src/ladder-v14-model.js";
import {
  ladderV14Inventory,
  ladderV14BuyGuard,
} from "../src/ladder-v14-inventory.js";
import { planLadderV14 } from "../src/ladder-v14.js";
import {
  exactKalshiDepthCost,
  exactKalshiOrderFee,
} from "../src/kalshi-fees.js";
import { PaperTrader } from "../src/paper-trader.js";
import { PaperRunLog } from "../src/paper-run-log.js";
import { v14LifecycleReport } from "../src/ladder-v14-report.js";
import type {
  MarketExecutionSnapshot,
  PaperOrder,
  PaperFill,
} from "../src/types.js";
import { testConfig, testEvent, testBooks } from "./helpers.js";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("concurrent lifecycle/health summaries serialize before close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v14-summary-race-"));
  const log = await PaperRunLog.open(dir);
  try {
    log.lifecycleSummary(new LadderV14LifecycleModel().summary());
    await Promise.all(Array.from({ length: 20 }, () => log.writeSummary()));
    await log.close();
    const summary = JSON.parse(
      await readFile(join(dir, "run-summary.json"), "utf8"),
    );
    assert.ok(summary.endedAt);
    assert.ok(summary.btcLifecycle.G > 0);
  } finally {
    await log.close();
    await rm(dir, { recursive: true, force: true });
  }
});
const now = testEvent().windowEnd - 300;
const event = {
  ...testEvent(),
  market: { ...testEvent().market, seriesTicker: "KXBTC15M" },
};
const config = testConfig({
  strategyMode: "ladder_v14",
  exchange: "kalshi",
  ladderV14VolumeFirstMode: true,
  ladderV14LifecycleEvEnabled: true,
  ladderV14CycleShares: 20,
  ladderV14ValueRepair: true,
});
const conditional = () =>
  new LadderV14ConditionalModel(
    ladderV14Parameters({
      priorStrength: 5,
      flowWindowSeconds: 60,
      volatilityWindowSeconds: 60,
      finalCleanupSeconds: 30,
    }),
  );
function state(): MarketExecutionSnapshot {
  return {
    marketSlug: event.slug,
    orders: [],
    openOrders: [],
    fills: [],
    positions: [],
    books: testBooks(0.51, 0.51, 1),
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 1000,
    totalFees: 0,
    estimatedMakerRebate: 0,
    makerFeeRate: 0,
    takerFeeRate: 0,
    takerFeeExponent: 1,
    settledPnl: null,
    executionPending: false,
  };
}
function order(
  id: string,
  token = "up-token",
  price = 0.4,
  size = 20,
  role = "opening",
): PaperOrder {
  return {
    id,
    tradeKey: `ladder-v14:${event.slug}:${id}`,
    pairId: `ladder-v14:${role}`,
    marketSlug: event.slug,
    marketTitle: event.title,
    conditionId: event.market.conditionId,
    tokenId: token,
    outcome: token === "up-token" ? "Up" : "Down",
    limitPrice: price,
    originalSize: size,
    remainingSize: 0,
    queueAhead: 0,
    status: "filled",
    side: "BUY",
    orderPolicy: "post_only",
    createdAt: new Date(now * 1000).toISOString(),
  };
}
function fill(
  o: PaperOrder,
  t = now,
  size = o.originalSize,
  side: "BUY" | "SELL" = "BUY",
): PaperFill {
  return {
    id: `${o.id}-${t}-${size}`,
    orderId: o.id,
    marketSlug: event.slug,
    tokenId: o.tokenId,
    outcome: o.outcome,
    price: o.limitPrice,
    size,
    fee: 0,
    liquidity: "maker",
    side,
    timestamp: new Date(t * 1000).toISOString(),
  };
}
function plan(
  s: MarketExecutionSnapshot,
  t = now,
  model = new LadderV14LifecycleModel(),
) {
  return planLadderV14(config, event, s, conditional(), undefined, t, model);
}
function residual(size = 200, entry = 0.4) {
  const s = state(),
    o = order("first", "up-token", entry, size);
  s.orders = [o];
  s.fills = [fill(o)];
  s.books[0]!.bestBid = 0.22;
  s.books[0]!.bestAsk = 0.34;
  s.books[0]!.bids = [{ price: 0.22, size: 500 }];
  s.books[0]!.asks = [{ price: 0.34, size: 500 }];
  s.books[1]!.bestBid = 0.57;
  s.books[1]!.bestAsk = 0.87;
  s.books[1]!.bids = [{ price: 0.57, size: 500 }];
  s.books[1]!.asks = [{ price: 0.87, size: 500 }];
  return s;
}

test("BTC economic seeds, entry hazards, 300-second probabilities and exact boundaries", () => {
  const m = new LadderV14LifecycleModel();
  close(m.G, 0.03715720651497936);
  close(m.L, 0.18613713607509574);
  close(m.qBreakEven, 0.8335953966232241);
  close(m.lambdaGlobal, 0.010665204639130071);
  close(m.qSafe, 0.883052345);
  const hazards = [
    0.01145152507769666, 0.0032570589063600068, 0.0061048244803037065,
    0.013694463929327164, 0.022426843326311226,
  ];
  const qs = [
    0.9677893302720871, 0.6236055709185738, 0.8398184379177459,
    0.9835649524523619, 0.9988031390180747,
  ];
  [0.09, 0.1, 0.3, 0.7, 0.9].forEach((p, i) => {
    assert.equal(entryBucket(p), i);
    close(m.entryHazard(i), hazards[i]!);
    close(m.evaluate(p, 20, 300, 1).qEntry, qs[i]!);
  });
  assert.equal(entryBucket(0.099999), 0);
  [9.99, 10, 25, 50, 100].forEach((q, i) => assert.equal(sizeBucket(q), i));
});
test("BTC adverse hazards, exact boundaries, missing hold value and risk classification", () => {
  const m = new LadderV14LifecycleModel();
  const qs = [
    0.9903708053408261, 0.771351949823294, 0.6777531620745858,
    0.5928945368550922, 0.5412019813754021, 0.2712364018226777,
  ];
  [-0.001, 0, 0.01, 0.03, 0.05, 0.1].forEach((g, i) => {
    assert.equal(adverseBucket(g), i);
    close(m.repair(g, 180)!, qs[i]!);
  });
  assert.equal(m.repair(null, 180), null);
  assert.equal(m.risk(null), null);
  assert.equal(m.risk(m.repair(0.1, 180)), "poor");
});
test("BTC opening gate uses min and classifies reject/probe/normal from baseline size", () => {
  const m = new LadderV14LifecycleModel();
  assert.equal(m.evaluate(0.2, 20, 300, 1).classification, "reject");
  const probe = m.evaluate(0.5, 20, 300, 1);
  assert.equal(probe.classification, "probe");
  assert.equal(probe.quantity, 10);
  close(probe.qOpen, Math.min(probe.qEntry, probe.qSize));
  close(probe.qSize, -Math.expm1(-m.sizeHazard(sizeBucket(20)) * 300));
  assert.equal(m.evaluate(0.8, 20, 300, 1).classification, "normal");
  assert.equal(m.evaluate(0.8, 100, 1, 1).classification, "reject");
  assert.equal(m.evaluate(0.5, 20, 300, 11).classification, "reject");
  const small = m.evaluate(0.5, 5, 300, 1);
  assert.equal(small.quantity, 5);
  assert.equal(m.evaluate(0.8, 20, 0, 1).classification, "reject");
});
test("BTC candidates pass independently and never use the old opening EV gate", () => {
  const s = state();
  s.books[0]!.bestAsk = 0.21;
  s.books[0]!.asks = [{ price: 0.21, size: 500 }];
  s.books[0]!.bestBid = 0.19;
  s.books[1]!.bestAsk = 0.81;
  s.books[1]!.asks = [{ price: 0.81, size: 500 }];
  s.books[1]!.bestBid = 0.79;
  const p = plan(s);
  assert.equal(p.opportunities.length, 1);
  assert.equal(p.opportunities[0]!.token.tokenId, "down-token");
  assert.equal(p.opportunities[0]!.size, 20);
  const probe = plan(state());
  assert.equal(probe.opportunities.length, 2);
  assert.ok(probe.opportunities.every((o) => o.size === 10));
  const legacyFlag = planLadderV14(
    { ...config, ladderV14VolumeFirstMode: false },
    event,
    s,
    conditional(),
    undefined,
    now,
  );
  assert.deepEqual(legacyFlag, p);
});

test("BTC resting probes keep their original baseline hazard on later ticks", () => {
  const s = state(),
    m = new LadderV14LifecycleModel();
  for (const book of s.books) {
    book.bestBid = 0.49;
    book.bids = book.bids.map((l) => ({ ...l, price: 0.49, size: 35 }));
    book.asks = book.asks.map((l) => ({ ...l, size: 35 }));
  }
  const flow = {
    eligibleVolumePerSecondByToken: { "up-token": 100, "down-token": 100 },
    volatilityByToken: {},
    midpointByToken: {},
  };
  const c = { ...config, ladderV14LiquiditySizing: true };
  const initial = planLadderV14(c, event, s, conditional(), flow, now, m);
  assert.ok(initial.opportunities.length > 0);
  s.orders = initial.opportunities.map((o, i) => ({
    ...order(`probe-${i}`, o.token.tokenId, o.price, o.size),
    tradeKey: o.tradeKey,
    status: "open",
    remainingSize: o.size,
  }));
  s.openOrders = s.orders;
  for (const [key, placement] of Object.entries(initial.placementContexts))
    m.state.openings[key] = placement.lifecycle!;
  const next = planLadderV14(c, event, s, conditional(), flow, now, m);
  for (const candidate of next.candidates) {
    assert.equal(candidate.lifecycle!.baselineQuantity, 35);
    assert.equal(candidate.size, 10);
    close(
      candidate.lifecycle!.qSize,
      -Math.expm1(-m.sizeHazard(sizeBucket(35)) * 300),
    );
  }
  assert.equal(next.candidates.length, 2);
});
test("BTC first fill cancels both opening sides and waits for reconciliation before repair", () => {
  const s = residual(20);
  const pending = order("other", "down-token", 0.59, 20);
  pending.status = "open";
  pending.remainingSize = 20;
  s.orders.push(pending);
  s.openOrders = [pending];
  const p = plan(s);
  assert.deepEqual(p.cancelOrderIds, [pending.id]);
  assert.equal(p.opportunities.length, 0);
  assert.equal(plan({ ...s, executionPending: true }).opportunities.length, 0);
  assert.equal(
    ladderV14BuyGuard(
      s,
      { ...plan(state()).opportunities[0]! },
      undefined,
      config,
    ),
    "repair_only_while_unpaired",
  );
});
test("BTC takes fee-inclusive profitable marginal depth immediately, including final cleanup", () => {
  const s = residual(20, 0.6);
  s.takerFeeRate = 0.07;
  s.books[1]!.bestAsk = 0.35;
  s.books[1]!.asks = [
    { price: 0.35, size: 10 },
    { price: 0.8, size: 100 },
  ];
  for (const t of [now, event.windowEnd - 5]) {
    const p = plan(s, t);
    assert.equal(p.managementStage, "lifecycle-profitable-taker-completion");
    const o = p.opportunities[0]!;
    const depth = exactKalshiDepthCost({
      levels: s.books[1]!.asks,
      size: o.size,
      rate: 0.07,
      exponent: 1,
    })!;
    assert.ok(o.size >= 10 && o.size < 20);
    assert.ok(0.6 + depth.total / o.size < 1);
    assert.equal(o.orderPolicy, "fak");
  }
  s.books[1]!.asks = [{ price: 0.39, size: 20 }];
  s.books[1]!.bestAsk = 0.39;
  assert.notEqual(
    plan(s).managementStage,
    "lifecycle-profitable-taker-completion",
  );
});
test("BTC maker repair stays positive after old age relaxation and executor checks stale basis", () => {
  const s = residual(100, 0.6);
  const p = plan(s, event.windowEnd - 50);
  for (const o of p.opportunities.filter(
    (o) => o.orderPolicy === "post_only",
  )) {
    assert.ok(
      0.6 +
        o.price +
        exactKalshiOrderFee({
          price: o.price,
          size: o.size,
          rate: s.makerFeeRate!,
          exponent: 1,
        }) /
          o.size <
        1,
    );
  }
  const target = {
    ...plan(state()).opportunities[0]!,
    token: s.books[1]!,
    size: 100,
    price: 0.4,
    pairId: "ladder-v14:repair-maker:test",
  };
  assert.equal(
    ladderV14BuyGuard(s, target, undefined, config),
    "v14_negative_maker_pair",
  );
});
test("BTC old, large, adverse and low-qRepair residuals do not force losses or terminal pairing", () => {
  const s = residual();
  assert.ok(
    new LadderV14LifecycleModel().repair(0.12, 180)! <
      new LadderV14LifecycleModel().qBreakEven,
  );
  for (const t of [now + 70, event.windowEnd - 5]) {
    const p = plan(s, t);
    assert.equal(p.flattenOpportunities.length, 0);
    assert.ok(p.opportunities.every((o) => o.orderPolicy === "post_only"));
    assert.ok(!p.managementStage.includes("excess"));
  }
});

test("BTC frozen qRepair annotates risk without changing economic action", () => {
  const s = residual(),
    m = new LadderV14LifecycleModel();
  m.state.active[event.slug] = {
    m: event.slug,
    s: "up",
    token: "up-token",
    t: now,
    p: 0.4,
    shares: 200,
    q: 200,
    originalQuantity: 200,
    h: 300,
    q0: 0.9,
    entryBucket: 2,
    sizeBucket: 4,
    g: 0.12,
    ps: 0,
    pp: 0,
    negative: false,
    sold: false,
  };
  const p = plan(s, now + 70, m);
  assert.equal(p.residualDecisions[0]!.lifecycleRisk, "poor");
  close(p.residualDecisions[0]!.qRepair!, m.repair(0.12, 230)!);
  assert.equal(p.flattenOpportunities.length, 0);
  assert.ok(p.opportunities.every((o) => o.orderPolicy === "post_only"));
});
test("BTC value-based negative hedge/sale remains possible when better than holding by margin", () => {
  const s = residual(20, 0.4);
  s.books[0]!.bestBid = 0.01;
  s.books[0]!.bestAsk = 0.1;
  s.books[0]!.bids = [{ price: 0.01, size: 100 }];
  s.books[1]!.bestBid = 0.7;
  s.books[1]!.bestAsk = 0.75;
  s.books[1]!.asks = [{ price: 0.75, size: 100 }];
  const hedge = plan(s, event.windowEnd - 5);
  assert.equal(hedge.opportunities[0]!.orderPolicy, "fak");
  assert.equal(hedge.residualDecisions[0]!.reason, "exit-beats-continuation");
  const sale = residual(20, 0.6);
  sale.books[0]!.bestBid = 0.4;
  sale.books[0]!.bestAsk = 0.42;
  sale.books[0]!.bids = [{ price: 0.4, size: 100 }];
  sale.books[1]!.bestBid = 0.9;
  sale.books[1]!.bestAsk = 0.95;
  sale.books[1]!.asks = [{ price: 0.95, size: 100 }];
  assert.equal(plan(sale, event.windowEnd - 5).flattenOpportunities.length, 1);
});
test("ETH and SOL keep their opening behavior and never touch BTC lifecycle statistics", () => {
  for (const ticker of ["KXETH15M", "KXSOL15M"]) {
    const m = new LadderV14LifecycleModel(),
      s = state(),
      e = { ...event, market: { ...event.market, seriesTicker: ticker } };
    const enabled = planLadderV14(
      config,
      e,
      s,
      conditional(),
      undefined,
      now,
      m,
    );
    const disabled = planLadderV14(
      { ...config, ladderV14LifecycleEvEnabled: false },
      e,
      s,
      conditional(),
      undefined,
      now,
    );
    assert.deepEqual(enabled, disabled);
    assert.equal(Object.keys(m.state.verdicts).length, 0);
  }
});
test("BTC lifecycle opening sizes retain the $125 and 250-share exposure caps", () => {
  const s = state();
  const p = planLadderV14(
    { ...config, ladderV14CycleShares: 1000 },
    event,
    s,
    conditional(),
    undefined,
    event.windowEnd - 800,
  );
  assert.ok(p.opportunities.length > 0);
  for (const o of p.opportunities) {
    assert.ok(o.size <= 250);
    assert.ok(o.price * o.size <= 125);
  }
});

test("BTC history migration, first adverse gap freeze, confirmed episode learning and restart dedup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v14-lifecycle-"));
  let store = await LadderV14HistoryStore.load(dir, config);
  try {
    await store.flush();
    const initial = store.lifecycle.toJSON();
    const p = plan(state());
    store.observe(event, state(), p, now * 1000);
    await store.flush();
    const path = join(dir, "ladder-v14-history.json"),
      saved = JSON.parse(await readFile(path, "utf8"));
    delete saved.lifecycle;
    await writeFile(path, JSON.stringify(saved));
    store = await LadderV14HistoryStore.load(dir, config);
    assert.deepEqual(store.model.toJSON(), saved.model);
    assert.deepEqual(store.lifecycle.toJSON(), initial);
    const s = residual(20, 0.5);
    s.books[0]!.bestBid = null;
    store.observe(event, s, { ...p, placementContexts: {} }, now * 1000);
    assert.equal(store.lifecycle.state.active[event.slug]!.g, null);
    s.books[0]!.bestBid = 0.22;
    store.observe(event, s, { ...p, placementContexts: {} }, (now + 1) * 1000);
    const gap = store.lifecycle.state.active[event.slug]!.g;
    assert.notEqual(gap, null);
    s.books[0]!.bestBid = 0.2;
    store.observe(event, s, { ...p, placementContexts: {} }, (now + 2) * 1000);
    assert.equal(store.lifecycle.state.active[event.slug]!.g, gap);
    await store.flush();
    store = await LadderV14HistoryStore.load(dir, config);
    const completion = order(
      "completion",
      "down-token",
      0.4,
      20,
      "repair-maker:test",
    );
    s.orders.push(completion);
    s.fills.push(fill(completion, now + 30));
    const rows: Record<string, unknown>[] = [];
    store.onLifecycleRecord = (row) => rows.push(row);
    store.observe(event, s, { ...p, placementContexts: {} }, (now + 30) * 1000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.o, "p");
    assert.equal(store.lifecycle.state.global.events, 1);
    close(store.lifecycle.state.global.seconds, 30);
    assert.equal(store.lifecycle.state.size[sizeBucket(20)]!.events, 1);
    await store.flush();
    store = await LadderV14HistoryStore.load(dir, config);
    store.observe(event, s, { ...p, placementContexts: {} }, (now + 40) * 1000);
    assert.equal(store.lifecycle.state.global.events, 1);
    close(
      store.lifecycle.G,
      initial.positivePairPnl / initial.positivePairShares,
    );
    s.settledPnl = 2;
    store.finalize(s, event.windowEnd * 1000);
    store.finalize(s, event.windowEnd * 1000);
    assert.equal(store.lifecycle.state.postUpdateSettledBtcMarkets, 1);
    close(store.lifecycle.state.positivePairPnl, initial.positivePairPnl + 2);
    await store.flush();
    store = await LadderV14HistoryStore.load(dir, config);
    store.finalize(s, event.windowEnd * 1000);
    assert.equal(store.lifecycle.state.postUpdateSettledBtcMarkets, 1);
  } finally {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  }
});
test("BTC sales, negative pairs, flips, aborts and terminal residuals have correct hazard outcomes", async () => {
  for (const outcome of ["s", "n", "c", "r"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "v14-censor-")),
      store = await LadderV14HistoryStore.load(dir, config),
      s = residual(20, 0.6),
      p = plan(state());
    const rows: Record<string, unknown>[] = [];
    store.onLifecycleRecord = (r) => rows.push(r);
    try {
      store.observe(event, s, { ...p, placementContexts: {} }, now * 1000);
      if (outcome === "s" || outcome === "n") {
        const o = order(
          "exit",
          outcome === "s" ? "up-token" : "down-token",
          0.5,
          20,
          outcome === "s" ? "repair-sale" : "repair-taker",
        );
        s.orders.push(o);
        s.fills.push(fill(o, now + 20, 20, outcome === "s" ? "SELL" : "BUY"));
        store.observe(
          event,
          s,
          { ...p, placementContexts: {} },
          (now + 20) * 1000,
        );
      } else if (outcome === "c") {
        const o = order("flip", "down-token", 0.3, 30, "repair-taker");
        s.orders.push(o);
        s.fills.push(fill(o, now + 20));
        store.observe(
          event,
          s,
          { ...p, placementContexts: {} },
          (now + 20) * 1000,
        );
        assert.equal(
          store.lifecycle.state.active[event.slug]!.token,
          "down-token",
        );
      } else {
        s.settledPnl = -12;
        store.finalize(s, event.windowEnd * 1000);
        close(store.lifecycle.state.residualNetPnl, -621.054 - 12);
        close(store.lifecycle.state.residualShares, 3336.54 + 20);
      }
      assert.equal(rows[0]!.o, outcome);
      assert.equal(store.lifecycle.state.global.events, 0);
      assert.ok(store.lifecycle.state.global.seconds > 0);
      if (outcome === "n")
        assert.equal(store.lifecycle.state.counts.executionAnomalies, 1);
    } finally {
      await store.flush();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
test("BTC qSafe bootstrap starts at 300 new settlements, runs each 50 and is deterministic", () => {
  const economics = {
    positivePairPnl: 1,
    positivePairShares: 20,
    residualNetPnl: -2,
    residualShares: 10,
  };
  const m = new LadderV14LifecycleModel();
  for (let i = 0; i < 299; i++) m.settle(`${i}`, economics);
  close(m.state.qSafe, 0.883052345);
  const restored = new LadderV14LifecycleModel(m.toJSON());
  m.settle("299", economics);
  restored.settle("299", economics);
  close(m.qSafe, Math.max(m.qBreakEven, 0.8));
  close(m.qSafe, restored.qSafe);
  const safe = m.state.qSafe;
  for (let i = 300; i < 349; i++)
    m.settle(`${i}`, { ...economics, residualNetPnl: -100 });
  close(m.state.qSafe, safe);
  m.settle("349", economics);
  assert.ok(m.qSafe > 0.8);
  assert.ok(m.qSafe >= m.qBreakEven);
  const empty = new LadderV14LifecycleModel();
  for (let i = 0; i < 300; i++)
    empty.settle(`${i}`, {
      ...economics,
      residualShares: 0,
      residualNetPnl: 0,
    });
  assert.equal(empty.state.qSafe, 0.883052345);
});
test("BTC nonpositive gain rejects and zero failure cost updates break-even", () => {
  const m = new LadderV14LifecycleModel();
  m.state.positivePairPnl = 0;
  assert.equal(m.qBreakEven, 1);
  assert.equal(m.evaluate(0.9, 20, 900, 1).classification, "reject");
  m.state.positivePairPnl = 1;
  m.state.residualNetPnl = 10;
  assert.equal(m.qBreakEven, 0);
  assert.equal(m.L, 0);
});

test("BTC finalized gain excludes guard pairs and individually losing matches", () => {
  const s = state(),
    first = order("first", "up-token", 0.4, 20),
    forced = order("forced", "down-token", 0.5, 10, "repair-taker"),
    normal = order("normal", "down-token", 0.4, 5, "repair-maker:x"),
    negative = order("negative", "down-token", 0.7, 5, "repair-taker");
  forced.tradeKey += ":guard:q10";
  s.orders = [first, forced, normal, negative];
  s.fills = s.orders.map((o, i) => fill(o, now + i));
  s.settledPnl = 1.5;
  const report = v14LifecycleReport(s, event.windowEnd * 1000);
  close(report.positivePairPnl, 1);
  close(report.positivePairShares, 5);
  close(report.negativePairShares, 5);
});
test("BTC normal paper logging suppresses per-tick residuals and maker quote churn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v14-skinny-"));
  const trader = new PaperTrader({ ...config, paperStatePath: dir });
  try {
    await trader.init();
    const start = Math.floor(Date.now() / 1000),
      live = {
        ...event,
        slug: `btc-updown-15m-${start}`,
        windowStart: start,
        windowEnd: start + 900,
      };
    await trader.observeMarket(live, state().books);
    const target = {
      ...plan(state()).opportunities[0]!,
      event: live,
      tradeKey: "skinny-opening",
    };
    assert.equal((await trader.placeBuy(target)).accepted, true);
    await trader.cancelOrders(
      trader.getMarketExecutionSnapshot(live.slug)!.openOrders.map((o) => o.id),
    );
    for (let i = 0; i < 100; i++)
      trader.recordPaperStrategyEvent({
        m: event.slug,
        t: i,
        age: i,
        left: 300 - i,
        action: "wait",
        hold: 0.4 + i / 1000,
      });
    trader.recordPaperStrategyEvent({
      e: "v14_ep",
      m: event.slug,
      o: "p",
      d: 20,
    });
    trader.recordPaperStrategyEvent({
      e: "v14_summary",
      btcLifecycle: new LadderV14LifecycleModel().summary(),
    });
    await trader.close();
    const lines = (await readFile(join(dir, "trades.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(lines.filter((r) => r.e === "residual_decision").length, 0);
    assert.equal(lines.filter((r) => r.e === "v14_ep").length, 1);
    assert.equal(
      lines.filter(
        (r) => r.e === "opening_submitted" || r.e === "repair_maker_submitted",
      ).length,
      0,
    );
    assert.ok(
      JSON.parse(await readFile(join(dir, "run-summary.json"), "utf8"))
        .btcLifecycle.G > 0,
    );
  } finally {
    await trader.close();
    await rm(dir, { recursive: true, force: true });
  }
});
