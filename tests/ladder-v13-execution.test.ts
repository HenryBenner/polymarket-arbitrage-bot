import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperTrader } from "../src/paper-trader.js";
import { KalshiTrader } from "../src/kalshi-trader.js";
import { ladderV13Inventory } from "../src/ladder-v13-inventory.js";
import type { KalshiCreateOrderInput, KalshiFill, KalshiOrder } from "../src/kalshi-api.js";
import type { TradeOpportunity } from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

const stream = { subscribe(_ids: string[]) {}, close() {} };
function market() {
  const event = testEvent();
  event.market = { ...event.market, exchange: "kalshi", id: "KXBTC15M-TEST",
    externalMarketId: "KXBTC15M-TEST", conditionId: "KXBTC15M-TEST",
    feeSchedule: { rate: 0, makerRate: 0, exponent: 1 } };
  const books = testBooks(.6, .4).map((book, index) => ({ ...book,
    tokenId: `KXBTC15M-TEST::${index === 0 ? "yes" : "no"}`,
    asks: [{ price: index === 0 ? .6 : .4, size: 100 }],
    bids: [{ price: index === 0 ? .39 : .3, size: 3 }], bestBid: index === 0 ? .39 : .3,
  }));
  const opportunity = (index: number, size: number, key: string, policy: "fak" | "post_only" = "fak", price = books[index]!.bestAsk!): TradeOpportunity => ({
    kind: policy === "post_only" ? "maker" : "expensive", event, token: books[index]!, price, size,
    tickSize: "0.01", negRisk: false, strategyMode: "ladder_v13", tradeKey: key,
    pairId: key.includes("sale") ? "ladder-v13:residual-sale" : "ladder-v13:completion-maker",
    orderPolicy: policy,
  });
  return { event, books, opportunity };
}

test("V13 paper executor rechecks residual size, protects pairs, and cancels partial FAK remainder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v13-paper-sale-"));
  const trader = new PaperTrader(testConfig({ exchange: "kalshi", strategyMode: "ladder_v13", paperStatePath: directory }),
    { stream, feeLoader: async () => ({ rate: 0, makerRate: 0, exponent: 1 }), settlementLoader: async () => null });
  try {
    const { event, books, opportunity } = market();
    await trader.init(); await trader.observeMarket(event, books);
    await trader.placeBuy(opportunity(0, 20, "yes"));
    await trader.placeBuy(opportunity(1, 10, "no"));
    assert.equal((await trader.placeSell(opportunity(0, 11, "oversized-sale", "fak", .39))).accepted, false);
    const completion = await trader.placeBuy(opportunity(1, 10, "resting", "post_only", .3));
    const id = (completion.response as { orderId: string }).orderId;
    assert.equal((await trader.placeSell(opportunity(0, 10, "competing-sale", "fak", .39))).accepted, false);
    await trader.cancelOrders([id]);
    await trader.placeBuy(opportunity(1, 4, "late-completion"));
    assert.equal((await trader.placeSell(opportunity(0, 10, "stale-sale", "fak", .39))).accepted, false);
    const sale = await trader.placeSell(opportunity(0, 6, "partial-sale", "fak", .39));
    assert.equal(sale.accepted, true);
    assert.equal((sale.response as { filledSize: number }).filledSize, 3);
    assert.equal((sale.response as { status: string }).status, "cancelled");
    let snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(ladderV13Inventory(snapshot).pairedShares, 14);
    assert.equal(ladderV13Inventory(snapshot).unpairedShares, 3);
    const fillCount = snapshot.fills.length;
    await trader.ingestMarketEvent({ event_type: "last_trade_price", asset_id: books[0]!.tokenId, side: "BUY", price: ".9", size: "100" });
    snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(snapshot.fills.length, fillCount, "cancelled FAK cannot fill later as a maker");
    assert.equal((await trader.placeSell(opportunity(0, 6, "stale-partial-sale", "fak", .39))).accepted, false);
  } finally { await trader.close(); await rm(directory, { recursive: true, force: true }); }
});

test("V13 live sales wait for cancel/fill reconciliation across restart and reject stale quantities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v13-live-sale-"));
  const { event, books, opportunity } = market();
  const config = testConfig({ exchange: "kalshi", strategyMode: "ladder_v13", executionMode: "live", dryRun: false, paperStatePath: directory });
  const remoteOrders: KalshiOrder[] = [];
  const remoteFills: KalshiFill[] = [];
  let sellCalls = 0;
  const remoteFill = (id: string, orderId: string, size: number, price: number): KalshiFill => ({
    fill_id: id, trade_id: id, order_id: orderId, count_fp: String(size),
    yes_price_dollars: String(price), no_price_dollars: String(1 - price),
    is_taker: true, fee_cost: "0", created_time: new Date().toISOString(),
  });
  const createTrader = (): KalshiTrader => {
    const trader = new KalshiTrader(config, { stream });
    Object.assign((trader as unknown as { client: object }).client, {
      init: async () => {}, getBalance: async () => 1000,
      getOrders: async () => structuredClone(remoteOrders),
      getFills: async () => structuredClone(remoteFills),
      cancelOrder: async (id: string) => {
        const order = remoteOrders.find((item) => item.order_id === id)!;
        order.status = "canceled"; order.fill_count_fp = "4"; order.remaining_count_fp = "0";
        // Cancellation raced a four-contract completion; fills endpoint lags.
      },
      createOrder: async (input: KalshiCreateOrderInput) => {
        const selling = input.action === "sell";
        const id = selling ? "sale" : input.outcome === "yes" ? "yes" : "no";
        const filled = selling ? 5 : input.outcome === "yes" ? 20 : 0;
        if (selling) {
          sellCalls++;
          assert.equal(input.timeInForce, "immediate_or_cancel");
          assert.equal(input.count, 16);
          assert.equal(input.price, .39);
        }
        remoteOrders.push({ order_id: id, ticker: "KXBTC15M-TEST", status: selling ? "canceled" : filled ? "executed" : "resting",
          fill_count_fp: String(filled), remaining_count_fp: filled ? "0" : String(input.count) });
        if (id === "yes") remoteFills.push(remoteFill("yes-filled", "yes", 20, .6));
        return { order_id: id, fill_count: String(filled), remaining_count: filled ? "0" : String(input.count), ts_ms: Date.now() };
      },
    });
    return trader;
  };
  let trader = createTrader();
  try {
    await trader.init(); await trader.observeMarket(event, books);
    await trader.placeBuy(opportunity(0, 20, "yes"));
    assert.equal(trader.getMarketExecutionSnapshot(event.slug)?.executionPending, true);
    await trader.observeMarket(event, books);
    await trader.placeBuy(opportunity(1, 10, "no", "post_only", .3));
    await trader.cancelOrders(["no"]);
    assert.equal(trader.getMarketExecutionSnapshot(event.slug)?.executionPending, true);
    assert.equal((await trader.placeSell(opportunity(0, 20, "pending-sale", "fak", .39))).accepted, false);
    await trader.close();
    trader = createTrader(); await trader.init(); await trader.observeMarket(event, books);
    assert.equal(trader.getMarketExecutionSnapshot(event.slug)?.executionPending, true);
    remoteFills.push(remoteFill("late-no", "no", 4, .7));
    assert.equal((await trader.placeSell(opportunity(0, 20, "stale-sale", "fak", .39))).accepted, false);
    assert.equal(sellCalls, 0);
    const sale = await trader.placeSell(opportunity(0, 16, "safe-sale", "fak", .39));
    assert.equal(sale.accepted, true); assert.equal(sellCalls, 1);
    let snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(snapshot.executionPending, true);
    assert.equal(snapshot.orders.find((item) => item.id === "sale")?.status, "cancelled");
    assert.equal(snapshot.openOrders.length, 0);
    assert.equal((await trader.placeSell(opportunity(0, 16, "pending-partial-sale", "fak", .39))).accepted, false);
    await trader.ingestMarketEvent({ event_type: "fill", market_ticker: "KXBTC15M-TEST", order_id: "sale",
      fill_id: "sold-five", trade_id: "sold-five", count_fp: "5", yes_price_dollars: ".39", fee_cost: "0", is_taker: true, ts_ms: Date.now() });
    snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(snapshot.executionPending, false);
    assert.equal(snapshot.orders.find((item) => item.id === "sale")?.status, "cancelled");
    assert.equal(ladderV13Inventory(snapshot).pairedShares, 4);
    assert.equal(ladderV13Inventory(snapshot).unpairedShares, 11);
    await trader.ingestMarketEvent({ event_type: "user_order", market_ticker: "KXBTC15M-TEST", order_id: "sale",
      status: "canceled", fill_count_fp: "5", remaining_count_fp: "0" });
    snapshot = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(snapshot.executionPending, false);
    assert.equal(snapshot.orders.find((item) => item.id === "sale")?.status, "cancelled");
    assert.equal(snapshot.orders.find((item) => item.id === "sale")?.remainingSize, 11);
    assert.equal((await trader.placeSell(opportunity(0, 16, "oversold-partial-sale", "fak", .39))).accepted, false);
    assert.equal(sellCalls, 1);
  } finally { await trader.close(); await rm(directory, { recursive: true, force: true }); }
});
