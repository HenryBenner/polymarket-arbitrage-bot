import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WriteStream } from "node:fs";
import test, { type TestContext } from "node:test";
import { ReverseBot } from "../src/bot.js";
import { PaperTrader, PAPER_CHECKPOINT_INTERVAL_MS, PAPER_HEALTH_INTERVAL_MS } from "../src/paper-trader.js";
import type { TradeOpportunity } from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Fault injection at the two I/O boundaries, without replacing trading logic.
function internals(trader: PaperTrader) {
  return trader as unknown as {
    eventLog: { stream: WriteStream; queueSize: number; flush(): Promise<void> };
    writeCheckpoint(serialized: string): Promise<void>;
    persistenceQueue: Promise<void>;
    executionQueue: Promise<void>;
    stateDirty: boolean;
    lagMax: number;
    lagTotal: number;
    lagCount: number;
  };
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Trading waited for blocked I/O")), 1_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "paper-checkpoint-"));
  const config = testConfig({ paperStatePath: directory, strategyMode: "ladder_v14" });
  const options = {
    stream: { subscribe() {}, close() {} },
    feeLoader: async () => ({ rate: 0, exponent: 1 }),
    settlementLoader: async () => null,
  };
  const trader = new PaperTrader(config, options);
  t.after(async () => {
    await trader.close();
    await rm(directory, { recursive: true, force: true });
  });
  await trader.init();
  const event = { ...testEvent(), windowStart: Date.now() / 1_000 - 1, windowEnd: Date.now() / 1_000 + 900 };
  const books = testBooks(0.6, 0.6);
  for (const book of books) { book.bids = []; book.bestBid = null; }
  await trader.observeMarket(event, books);
  const opportunity: TradeOpportunity = {
    kind: "cheap", event, token: books[0]!, price: 0.4, size: 10,
    tickSize: "0.01", negRisk: false, tradeKey: "opening",
    strategyMode: "ladder_v14", pairId: "ladder-v14:opening", orderPolicy: "post_only",
  };
  const readState = async () => JSON.parse(await readFile(join(directory, "paper-state.json"), "utf8")) as ReturnType<PaperTrader["snapshot"]>;
  const readLog = async () => (await readFile(join(directory, "paper-events.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { directory, config, options, trader, event, books, opportunity, readState, readLog };
}

test("paper fills, sales, amendments, cancellations and wakes proceed while checkpoint and log writes are blocked", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t);
  const io = internals(f.trader);
  const started = deferred();
  const release = deferred();
  const write = io.writeCheckpoint.bind(f.trader);
  let writes = 0;
  t.mock.method(io, "writeCheckpoint", async (serialized: string) => {
    writes += 1;
    started.resolve();
    await release.promise;
    await write(serialized);
  });
  io.eventLog.stream.cork();
  try {
    await f.trader.placeBuy(f.opportunity);
    assert.equal((await f.readState()).orders.length, 0);
    assert.equal(writes, 0);
    t.mock.timers.tick(PAPER_CHECKPOINT_INTERVAL_MS);
    await started.promise;
    let telemetrySeen = false;
    let wakeShares = 0;
    f.trader.setMarketTelemetryHandler(() => { telemetrySeen = true; });
    f.trader.setExecutionWakeHandler(() => {
      assert.equal(telemetrySeen, true);
      wakeShares = f.trader.getMarketExecutionSnapshot(f.event.slug)!.positions[0]!.shares;
      return release.promise;
    });
    await within(f.trader.ingestMarketEvent({
      event_type: "last_trade_price", asset_id: "up-token", side: "SELL",
      price: "0.4", size: "10", timestamp: String(Date.now()),
    }));
    assert.equal(wakeShares, 10);
    f.books[0]!.bids = [{ price: 0.5, size: 10 }];
    f.books[0]!.bestBid = 0.5;
    await within(f.trader.placeSell({ ...f.opportunity, tradeKey: "sale", price: 0.5, size: 2, orderPolicy: "fak" }));
    const placed = await within(f.trader.placeBuy({ ...f.opportunity, tradeKey: "amendable" }));
    const orderId = (placed.response as { orderId: string }).orderId;
    await within(f.trader.amendOrder(orderId, { ...f.opportunity, tradeKey: "amended", price: 0.42 }));
    await within(f.trader.cancelOrders([orderId]));
    assert.equal(f.trader.snapshot().positions[0]!.shares, 8);
    assert.ok(io.eventLog.queueSize > 0);
    t.mock.timers.tick(3 * PAPER_CHECKPOINT_INTERVAL_MS);
    assert.equal(writes, 1, "slow checkpoint must not accumulate timer writes");
    release.resolve();
    await io.persistenceQueue;
    assert.equal(io.stateDirty, true, "a fill during the write must remain dirty");
    assert.equal((await f.readState()).fills.length, 0);
    t.mock.timers.tick(PAPER_CHECKPOINT_INTERVAL_MS);
    await io.persistenceQueue;
    assert.equal(writes, 2);
    assert.equal(io.stateDirty, false);
    assert.equal((await f.readState()).fills.length, 2);
    t.mock.timers.tick(PAPER_CHECKPOINT_INTERVAL_MS);
    assert.equal(writes, 2, "clean state must not be rewritten");
  } finally {
    release.resolve();
    io.eventLog.stream.uncork();
    await io.persistenceQueue;
  }
  await f.trader.close();
  const records = await f.readLog();
  assert.equal(records[0].type, "order_submitted");
  assert.equal(records[0].payload.status, "open", "logs snapshot orders before later mutation");
  assert.equal(records.filter((record) => record.type === "fill").length, 2);
  assert.ok(records.some((record) => record.type === "order_amended"));
  assert.ok(records.some((record) => record.type === "order_cancelled"));
});

test("a failed checkpoint remains dirty and the next five-second checkpoint recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t);
  const io = internals(f.trader);
  const write = io.writeCheckpoint.bind(f.trader);
  let attempts = 0;
  t.mock.method(io, "writeCheckpoint", async (serialized: string) => {
    if (++attempts === 1) throw new Error("simulated disk failure");
    await write(serialized);
  });
  await f.trader.placeBuy(f.opportunity);
  t.mock.timers.tick(PAPER_CHECKPOINT_INTERVAL_MS);
  await io.persistenceQueue;
  assert.equal(io.stateDirty, true);
  t.mock.timers.tick(PAPER_CHECKPOINT_INTERVAL_MS);
  await io.persistenceQueue;
  assert.equal(io.stateDirty, false);
  assert.equal((await f.readState()).orders.length, 1);
  await f.trader.close();
  assert.ok((await f.readLog()).some((record) => record.type === "error"));
});

test("stale exchange trades cannot consume queue position or fill; the 1000 ms boundary is accepted", async (t) => {
  const now = Math.floor(Date.now() / 1_000) * 1_000;
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  const f = await fixture(t);
  f.books[0]!.bids = [{ price: 0.4, size: 2 }];
  await f.trader.placeBuy(f.opportunity);
  t.mock.timers.tick(1_001);
  for (const source of [String(now), String(now / 1_000), new Date(now).toISOString()]) {
    await f.trader.ingestMarketEvent({
      event_type: "last_trade_price", asset_id: "up-token", side: "SELL",
      price: "0.4", size: "10", timestamp: String(Date.now()), source_timestamp: source,
    });
  }
  assert.equal(f.trader.snapshot().fills.length, 0);
  assert.equal(f.trader.snapshot().orders[0]!.queueAhead, 2);
  await f.trader.ingestMarketEvent({
    event_type: "last_trade_price", asset_id: "up-token", side: "SELL",
    price: "0.4", size: "3", timestamp: String(now + 1),
  });
  assert.equal(f.trader.snapshot().fills[0]!.size, 1);
  assert.equal(f.trader.snapshot().orders[0]!.queueAhead, 0);
  await f.trader.close();
  assert.equal((await f.readLog()).filter((record) => record.type === "stale_event_skipped").length, 3);
});

test("health records report receive-to-process lag every 30 seconds and reset the lag window", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const f = await fixture(t);
  const io = internals(f.trader);
  const release = deferred();
  io.executionQueue = release.promise;
  const queued = f.trader.ingestMarketEvent({ event_type: "book", asset_id: "up-token", bids: [], asks: [] });
  t.mock.timers.tick(250);
  release.resolve();
  await queued;
  await f.trader.ingestMarketEvent({ event_type: "book", asset_id: "up-token", bids: [], asks: [] });
  t.mock.timers.tick(PAPER_HEALTH_INTERVAL_MS - 250);
  await io.eventLog.flush();
  const first = (await f.readLog()).find((record) => record.type === "health").payload;
  assert.equal(first.averageLag, 125);
  assert.equal(first.maxLag, 250);
  assert.equal(first.eventsProcessed, 2);
  for (const field of ["processingLagMs", "openOrders", "fillsProcessed", "logQueueSize", "stateDirty", "staleEventsSkipped"]) {
    assert.ok(field in first);
  }
  t.mock.timers.tick(PAPER_HEALTH_INTERVAL_MS);
  await io.eventLog.flush();
  const second = (await f.readLog()).filter((record) => record.type === "health")[1].payload;
  assert.equal(second.averageLag, 0);
  assert.equal(second.maxLag, 0);
});

test("settlement saves and prunes history after the learner callback without blocking another market", async (t) => {
  const f = await fixture(t);
  const io = internals(f.trader);
  await f.trader.placeBuy({ ...f.opportunity, price: 0.6, orderPolicy: "fak" });
  const otherEvent = { ...f.event, slug: "other-market", market: { ...f.event.market, conditionId: "other-condition" } };
  const otherBooks = f.books.map((book) => ({ ...book, tokenId: `other-${book.tokenId}` }));
  await f.trader.observeMarket(otherEvent, otherBooks);
  await f.trader.placeBuy({ ...f.opportunity, event: otherEvent, token: otherBooks[0]!, tradeKey: "other-opening" });
  const started = deferred();
  const release = deferred();
  const write = io.writeCheckpoint.bind(f.trader);
  t.mock.method(io, "writeCheckpoint", async (serialized: string) => {
    started.resolve();
    await release.promise;
    await write(serialized);
  });
  let learnerFills = 0;
  f.trader.setSettlementHandler(() => {
    learnerFills = f.trader.getMarketExecutionSnapshot(f.event.slug)!.fills.length;
  });
  const settling = f.trader.ingestMarketEvent({ event_type: "market_resolved", winning_asset_id: "up-token" });
  try {
    await started.promise;
    await within(f.trader.ingestMarketEvent({
      event_type: "last_trade_price", asset_id: "other-up-token", side: "SELL",
      price: "0.4", size: "10", timestamp: String(Date.now()),
    }));
    assert.equal(f.trader.getMarketExecutionSnapshot(otherEvent.slug)!.fills.length, 1);
    assert.equal((await f.trader.placeBuy({ ...f.opportunity, tradeKey: "too-late" })).accepted, false);
  } finally {
    release.resolve();
    await settling;
  }
  assert.equal(learnerFills, 1);
  assert.equal(f.trader.getMarketExecutionSnapshot(f.event.slug), null);
  const state = await f.readState();
  assert.equal(state.settlements.length, 1);
  for (const rows of [state.orders, state.fills, state.positions]) {
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.marketSlug === otherEvent.slug));
  }
  assert.ok((await f.readLog()).some((record) => record.type === "fill" && record.payload.marketSlug === f.event.slug));
  const cash = state.theoreticalCash;
  await f.trader.ingestMarketEvent({ event_type: "market_resolved", winning_asset_id: "up-token" });
  assert.equal(f.trader.snapshot().theoreticalCash, cash);
});

test("startup compacts legacy settled orders, fills, positions and fee accumulators without paying twice", async (t) => {
  const f = await fixture(t);
  await f.trader.placeBuy({ ...f.opportunity, price: 0.6, orderPolicy: "fak" });
  const active = f.trader.snapshot();
  await f.trader.ingestMarketEvent({ event_type: "market_resolved", winning_asset_id: "up-token" });
  await f.trader.close();
  const settled = await f.readState();
  await writeFile(join(f.directory, "paper-state.json"), JSON.stringify({
    ...settled, orders: active.orders, fills: active.fills, positions: active.positions,
    feeAccumulators: { [active.orders[0]!.id]: 0.5 },
  }));
  const restarted = new PaperTrader(f.config, f.options);
  try {
    await restarted.init();
    const compact = await f.readState();
    assert.deepEqual(compact.orders, []);
    assert.deepEqual(compact.fills, []);
    assert.deepEqual(compact.positions, []);
    assert.deepEqual(compact.feeAccumulators, {});
    assert.equal(compact.theoreticalCash, settled.theoreticalCash);
    assert.deepEqual(compact.settlements, settled.settlements);
    await restarted.observeMarket(f.event, f.books);
    assert.equal(restarted.getMarketExecutionSnapshot(f.event.slug), null);
    assert.equal((await restarted.placeBuy(f.opportunity)).accepted, false);
  } finally {
    await restarted.close();
  }
});

test("manual bot stop flushes the paper log and final checkpoint before five seconds", async (t) => {
  const f = await fixture(t);
  let scans = 0;
  const bot = new ReverseBot(f.config, f.trader, {
    scan: async () => { scans += 1; return []; }, getTokenBooks: async () => [],
  });
  await f.trader.placeBuy(f.opportunity);
  assert.equal((await f.readState()).orders.length, 0);
  await Promise.all([bot.stop(), bot.stop()]);
  assert.equal((await f.readState()).orders.length, 1);
  assert.equal((await f.readLog())[0].type, "order_submitted");
  await bot.runOnce();
  assert.equal(scans, 0);
  await assert.rejects(f.trader.placeBuy(f.opportunity), /closed/);
});

test("shutdown after failed startup preserves the unreadable checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-invalid-checkpoint-"));
  const statePath = join(directory, "paper-state.json");
  const corrupt = '{"version":1,"cash":';
  await writeFile(statePath, corrupt);
  const trader = new PaperTrader(testConfig({ paperStatePath: directory }), {
    stream: { subscribe() {}, close() {} },
  });
  try {
    await assert.rejects(trader.init(), SyntaxError);
    await trader.close();
    assert.equal(await readFile(statePath, "utf8"), corrupt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown drains a settlement event already admitted to the RAM queue", async (t) => {
  const f = await fixture(t);
  await f.trader.placeBuy({ ...f.opportunity, price: 0.6, orderPolicy: "fak" });
  const settling = f.trader.ingestMarketEvent({ event_type: "market_resolved", winning_asset_id: "up-token" });
  await Promise.all([settling, f.trader.close()]);
  const state = await f.readState();
  assert.equal(state.settlements.length, 1);
  assert.equal(state.settlements[0]!.payout, 10);
  assert.equal(state.orders.length, 0);
  assert.equal(state.positions.length, 0);
  assert.ok((await f.readLog()).some((record) => record.type === "settlement"));
});

test("a burst of maker events updates RAM and wakes V14 without per-event checkpoints", async (t) => {
  const f = await fixture(t);
  await f.trader.placeBuy({ ...f.opportunity, size: 500 });
  let wakes = 0;
  f.trader.setExecutionWakeHandler(() => { wakes += 1; });
  const atMs = Date.now();
  await Promise.all(Array.from({ length: 500 }, (_, index) => f.trader.ingestMarketEvent({
    event_type: "last_trade_price", asset_id: "up-token", side: "SELL",
    price: "0.4", size: "1", timestamp: String(atMs), transaction_hash: `burst-${index}`,
  })));
  assert.equal(f.trader.snapshot().fills.length, 500);
  assert.equal(wakes, 500);
  assert.equal((await f.readState()).orders.length, 0);
  const io = internals(f.trader);
  t.diagnostic(`500 maker events: average processing lag ${(io.lagTotal / io.lagCount).toFixed(2)} ms; max ${io.lagMax} ms`);
});
