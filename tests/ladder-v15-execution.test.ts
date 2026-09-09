import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperTrader } from "../src/paper-trader.js";
import { ReverseBot } from "../src/bot.js";
import { planLadderV15 } from "../src/ladder-v15.js";
import { v15Exposure, v15Inventory } from "../src/ladder-v15-inventory.js";
import { testConfig, testEvent, testBooks } from "./helpers.js";
import type { TradeOpportunity } from "../src/types.js";

function market() {
  const event = testEvent();
  event.windowStart = Math.floor(Date.now() / 1000) - 60; event.windowEnd = event.windowStart + 900;
  event.market.exchange = "kalshi"; event.market.seriesTicker = "KXBTC15M";
  event.market.feeSchedule = { rate: 0.07, makerRate: 0, exponent: 1 };
  const books = testBooks(0.1, 0.8, 0.01);
  books[0]!.bids = [{ price: 0.09, size: 100 }]; books[0]!.bestBid = 0.09;
  books[1]!.bids = [{ price: 0.79, size: 100 }]; books[1]!.bestBid = 0.79;
  books.forEach(book => book.asks[0]!.size = 40);
  return { event, books };
}
const options = { stream: { subscribe: () => undefined, close: () => undefined }, settlementLoader: async () => null };

test("V15 paper nets filled pairs immediately, survives restart and settles without double credit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v15-accounting-"));
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v15", paperStatePath: directory, paperStartingUsdc: 1 });
  const { event, books } = market(); let trader = new PaperTrader(config, options);
  try {
    await trader.init(); await trader.observeMarket(event, books);
    let snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    const entry = planLadderV15(config, event, snapshot, 0).opportunities[0]!;
    assert.equal((await trader.placeBuy(entry)).accepted, true);
    snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(v15Exposure(snapshot), 40);
    const complete = planLadderV15(config, event, snapshot, 40).opportunities[0]!;
    assert.equal(complete.orderPolicy, "fok");
    assert.equal((await trader.placeBuy(complete)).accepted, true);
    snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(snapshot.positions.reduce((sum, p) => sum + p.shares, 0), 0);
    assert.equal(v15Exposure(snapshot), 0);
    const expected = 40 - snapshot.fills.reduce((sum, f) => sum + f.price * f.size + f.fee, 0);
    assert.ok(Math.abs(snapshot.theoreticalCash! - 1 - expected) < 1e-8);
    assert.ok(Math.abs(snapshot.realizedPnl! - expected) < 1e-8);
    const sale: TradeOpportunity = { ...entry, tradeKey: "invalid-sale", pairId: "ladder-v15:1:cleanup-sale:", price: 0.09 };
    assert.equal((await trader.placeSell(sale)).accepted, false);
    const before = snapshot.theoreticalCash;
    await trader.close(); trader = new PaperTrader(config, options);
    await trader.init();
    snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(snapshot.marketDataValid, false);
    assert.equal(snapshot.theoreticalCash, before);
    assert.equal(snapshot.positions.reduce((sum, p) => sum + p.shares, 0), 0);
    assert.equal(v15Inventory(snapshot)[0]!.pairedShares, 40);
    await trader.ingestMarketEvent({ event_type: "market_resolved", winning_asset_id: books[0]!.tokenId });
    await trader.close();
    const state = JSON.parse(await readFile(join(directory, ".runtime", "paper-state.json"), "utf8"));
    assert.equal(state.theoreticalCash, before);
    assert.ok(Math.abs(state.settlements[0].realizedPnl - expected) < 1e-8);
    assert.equal(state.v15Cycles[0].bucket, "15-10");
    assert.ok(Math.abs(state.v15Cycles[0].realizedPnl - expected) < 1e-8);
    assert.equal(state.fills.length, 0);
  } finally { await trader.close(); await rm(directory, { recursive: true, force: true }); }
});

test("V15 executor rejects excess pending completion and portfolio reservations across markets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v15-reservations-"));
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v15", paperStatePath: directory,
    ladderV15MaxUnmatchedPortfolio: 40 });
  const trader = new PaperTrader(config, options); const { event, books } = market();
  try {
    await trader.init(); await trader.observeMarket(event, books);
    const first = planLadderV15(config, event, trader.getMarketExecutionSnapshot(event.slug)!, 0).opportunities[0]!;
    await trader.placeBuy(first);
    const stale = planLadderV15(config, event, trader.getMarketExecutionSnapshot(event.slug)!, 40).opportunities[0]!;
    const maker = { ...stale, price: 0.7, orderPolicy: "post_only" as const, pairId: "ladder-v15:1:completion-maker:", tradeKey: "maker" };
    assert.equal((await trader.placeBuy(maker)).accepted, true);
    assert.equal((await trader.placeBuy(stale)).accepted, false);
    const other = structuredClone(event); other.slug = "eth-test";
    const otherBooks = books.map(b => ({ ...b, tokenId: `eth-${b.tokenId}` }));
    other.market.clobTokenIds = JSON.stringify(otherBooks.map(b => b.tokenId));
    await trader.observeMarket(other, otherBooks);
    const entry = { ...first, event: other, token: otherBooks[0]!, tradeKey: "eth-entry" };
    assert.equal((await trader.placeBuy(entry)).accepted, false);
  } finally { await trader.close(); await rm(directory, { recursive: true, force: true }); }
});

test("V15 bot dispatch uses fill-driven cycles and shuts down deadline timers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v15-bot-"));
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v15", paperStatePath: directory,
    ladderV15RetryCooldownMs: 60_000 });
  const { event, books } = market();
  const trader = new PaperTrader(config, options);
  const bot = new ReverseBot(config, trader, { scan: async () => [event], getTokenBooks: async () => books });
  try {
    await bot.init(); await bot.run();
    const snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(v15Inventory(snapshot)[0]!.pairedShares, 40);
    assert.equal(snapshot.openOrders.length, 0);
    await bot.stop();
    const state = JSON.parse(await readFile(join(directory, ".runtime", "paper-state.json"), "utf8"));
    assert.equal(state.orders.length, 2);
  } finally { await bot.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("V15 quiet-book deadline sells residual without another scanner tick", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v15-deadline-"));
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v15", paperStatePath: directory,
    ladderV15EntryMinutesMin: 0.005, ladderV15CleanupSeconds: 0.15 });
  const { event, books } = market();
  event.windowEnd = Date.now() / 1000 + 1.5;
  books[1]!.asks = [{ price: 0.99, size: 100 }]; books[1]!.bestAsk = 0.99;
  const trader = new PaperTrader(config, options);
  const bot = new ReverseBot(config, trader, { scan: async () => [event], getTokenBooks: async () => books });
  try {
    await bot.init(); await bot.runOnce();
    assert.equal(trader.getMarketExecutionSnapshot(event.slug)!.openOrders.length, 1);
    await new Promise(resolve => setTimeout(resolve, 1600));
    const snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(snapshot.openOrders.length, 0);
    assert.equal(snapshot.fills.filter(fill => fill.side === "SELL").reduce((sum, fill) => sum + fill.size, 0), 40);
    assert.equal(v15Exposure(snapshot), 0);
  } finally { await bot.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("V15 stream fill wakes completion; stale and duplicate trades do not add inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v15-stream-"));
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v15", paperStatePath: directory,
    ladderV15RetryCooldownMs: 60_000 });
  const { event, books } = market();
  books[0]!.asks = [{ price: 0.12, size: 100 }]; books[0]!.bestAsk = 0.12;
  const trader = new PaperTrader(config, options);
  const bot = new ReverseBot(config, trader, { scan: async () => [event], getTokenBooks: async () => books });
  try {
    await bot.init(); await bot.runOnce();
    const trade = { event_type: "last_trade_price", asset_id: books[0]!.tokenId,
      price: "0.10", size: "40", side: "SELL", timestamp: String(Date.now()), trade_id: "v15-fill" };
    await trader.ingestMarketEvent({ ...trade, timestamp: String(Date.now() - 5000), trade_id: "stale" });
    assert.equal(trader.getMarketExecutionSnapshot(event.slug)!.fills.length, 0);
    await trader.ingestMarketEvent(trade);
    await new Promise(resolve => setTimeout(resolve, 30));
    const snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(v15Inventory(snapshot)[0]!.pairedShares, 40);
    await trader.ingestMarketEvent(trade);
    assert.equal(trader.getMarketExecutionSnapshot(event.slug)!.fills.length, snapshot.fills.length);
  } finally { await bot.stop(); await rm(directory, { recursive: true, force: true }); }
});
