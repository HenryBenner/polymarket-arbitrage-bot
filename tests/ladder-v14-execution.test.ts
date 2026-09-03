import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KalshiTrader } from "../src/kalshi-trader.js";
import { ladderV14Inventory } from "../src/ladder-v14-inventory.js";
import type { KalshiCreateOrderInput, KalshiFill, KalshiOrder } from "../src/kalshi-api.js";
import type { TradeOpportunity } from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

test("V14 live buy guard handles batch fills, cancel races, and stale repair amendments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v14-live-repair-"));
  const ticker = "KXBTC15M-TEST";
  const event = testEvent();
  event.market = { ...event.market, exchange: "kalshi", id: ticker,
    externalMarketId: ticker, conditionId: ticker,
    feeSchedule: { rate: 0, makerRate: 0, exponent: 1 } };
  const books = testBooks(0.6, 0.4, 1).map((book, index) => ({
    ...book, tokenId: `${ticker}::${index === 0 ? "yes" : "no"}`,
  }));
  const remoteOrders: KalshiOrder[] = [];
  const remoteFills: KalshiFill[] = [];
  let createCalls = 0;
  const trader = new KalshiTrader(testConfig({
    exchange: "kalshi", strategyMode: "ladder_v14", ladderV14VolumeFirstMode: true,
    executionMode: "live", dryRun: false, paperStatePath: directory,
  }), { stream: { subscribe: () => undefined, close: () => undefined } });
  const remoteFill = (id: string, orderId: string, size: number, yesPrice: number): KalshiFill => ({
    fill_id: id, trade_id: id, order_id: orderId, count_fp: String(size),
    yes_price_dollars: String(yesPrice), no_price_dollars: String(1 - yesPrice),
    is_taker: true, fee_cost: "0", created_time: new Date().toISOString(),
  });
  Object.assign((trader as unknown as { client: object }).client, {
    init: async () => undefined,
    getBalance: async () => 1000,
    getOrders: async () => structuredClone(remoteOrders),
    getFills: async () => structuredClone(remoteFills),
    createOrders: async () => { throw new Error("V14 batch must recheck after each acknowledgment"); },
    amendOrder: async () => { throw new Error("stale amendment must not reach exchange"); },
    createOrder: async (input: KalshiCreateOrderInput) => {
      const id = `remote-${++createCalls}`;
      const filled = input.outcome === "yes" ? input.count : 0;
      remoteOrders.push({ order_id: id, ticker, status: filled ? "executed" : "resting",
        fill_count_fp: String(filled), remaining_count_fp: filled ? "0" : String(input.count) });
      if (filled) remoteFills.push(remoteFill("first-fill", id, filled, 0.6));
      return { order_id: id, fill_count: String(filled), remaining_count: filled ? "0" : String(input.count) };
    },
    cancelOrder: async (id: string) => {
      const order = remoteOrders.find((candidate) => candidate.order_id === id)!;
      order.status = "canceled";
      order.fill_count_fp = "4";
      order.remaining_count_fp = "0";
      // Four missing-side shares filled during cancellation; the fills feed lags.
    },
  });
  const opening: TradeOpportunity = {
    event, token: books[0]!, kind: "expensive", price: 0.6, size: 20,
    tickSize: "0.01", negRisk: false, strategyMode: "ladder_v14",
    tradeKey: "v14-open-yes", pairId: "ladder-v14:opening", orderPolicy: "fak",
  };
  const other: TradeOpportunity = { ...opening, token: books[1]!, kind: "maker",
    price: 0.3, size: 40, orderPolicy: "post_only", tradeKey: "v14-open-no" };
  try {
    await trader.init();
    await trader.observeMarket(event, books);
    const batch = await trader.placeBuys([opening, other]);
    assert.equal(batch[0]!.accepted, true);
    assert.equal(batch[1]!.accepted, false);
    assert.equal(createCalls, 1);
    await trader.observeMarket(event, books);
    assert.equal((await trader.placeBuy(other)).accepted, false);
    const repair = { ...other, size: 20, tradeKey: "v14-repair", pairId: "ladder-v14:repair-maker:test" };
    assert.equal((await trader.placeBuy(repair)).accepted, true);
    assert.equal((await trader.amendOrder("remote-2", { ...repair, size: 40 })).accepted, false);
    await trader.cancelOrders(["remote-2"]);
    assert.equal(trader.getMarketExecutionSnapshot(event.slug)!.executionPending, true);
    assert.equal((await trader.placeBuy({ ...repair, tradeKey: "v14-pending-repair" })).accepted, false);
    remoteFills.push(remoteFill("late-fill", "remote-2", 4, 0.7));
    await trader.observeMarket(event, books);
    assert.equal(ladderV14Inventory(trader.getMarketExecutionSnapshot(event.slug)!).unpairedShares, 16);
    assert.equal((await trader.placeBuy({ ...repair, tradeKey: "v14-stale-repair" })).accepted, false);
    assert.equal((await trader.placeBuy({ ...repair, size: 16, tradeKey: "v14-current-repair" })).accepted, true);
    assert.equal(createCalls, 3);
  } finally {
    await trader.close();
    await rm(directory, { recursive: true, force: true });
  }
});
