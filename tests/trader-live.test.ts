import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClobClient, Trade } from "@polymarket/clob-client-v2";
import { Trader } from "../src/trader.js";
import type { TradeOpportunity } from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

test("live executor mirrors post-only, FAK, cancellation, and authenticated fills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pair-lock-live-"));
  try {
    const calls: Array<Record<string, unknown>> = [];
    let openOrderIds: string[] = [];
    let trades: Trade[] = [];
    let sequence = 0;
    const fakeClient = {
      getFeeRateBps: async () => 700,
      getFeeExponent: async () => 1,
      getOpenOrders: async () =>
        openOrderIds.map((id) => ({
          id,
          status: "ORDER_STATUS_LIVE",
        })),
      getTrades: async () => trades,
      createAndPostOrder: async (
        order: unknown,
        options: unknown,
        orderType: unknown,
        postOnly: unknown,
      ) => {
        const id = `live-${++sequence}`;
        calls.push({ method: "limit", order, options, orderType, postOnly, id });
        openOrderIds.push(id);
        return { success: true, orderID: id, status: "live" };
      },
      createAndPostMarketOrder: async (
        order: unknown,
        options: unknown,
        orderType: unknown,
      ) => {
        const id = `live-${++sequence}`;
        calls.push({ method: "market", order, options, orderType, id });
        return { success: true, orderID: id, status: "matched" };
      },
      cancelOrders: async (ids: string[]) => {
        calls.push({ method: "cancel", ids });
        openOrderIds = openOrderIds.filter((id) => !ids.includes(id));
        return { canceled: ids, not_canceled: {} };
      },
    } as unknown as ClobClient;

    const config = testConfig({
      strategyMode: "odahoa_ladder_2",
      executionMode: "live",
      dryRun: false,
      paperStatePath: directory,
    });
    const trader = new Trader(config, { client: fakeClient });
    await trader.init();
    const event = testEvent();
    const books = testBooks(0.5, 0.6);
    await trader.observeMarket(event, books);

    const opening: TradeOpportunity = {
      kind: "cheap",
      event,
      token: books[0]!,
      price: 0.4,
      size: 5,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: "opening",
      strategyMode: "odahoa_ladder_2",
      orderPolicy: "post_only",
      pairLockRole: "opening",
    };
    const openingResult = await trader.placeBuy(opening);
    assert.equal(openingResult.accepted, true);
    assert.equal(calls[0]?.method, "limit");
    assert.equal(calls[0]?.postOnly, true);
    assert.equal(calls[0]?.orderType, "GTC");

    openOrderIds = [];
    trades = [
      {
        id: "maker-trade",
        taker_order_id: "someone-else",
        market: event.market.conditionId,
        asset_id: "up-token",
        side: "SELL",
        size: "5",
        fee_rate_bps: "700",
        price: "0.4",
        status: "MATCHED",
        match_time: "1767225600",
        last_update: "1767225600",
        outcome: "Up",
        bucket_index: 0,
        owner: "owner",
        maker_address: "maker",
        maker_orders: [
          {
            order_id: String(responseId(openingResult.response)),
            owner: "owner",
            maker_address: "maker",
            matched_amount: "5",
            price: "0.4",
            fee_rate_bps: "700",
            asset_id: "up-token",
            outcome: "Up",
            side: "BUY",
          },
        ],
        trader_side: "MAKER",
      } as Trade,
    ];
    await trader.observeMarket(event, books);
    let execution = trader.getMarketExecutionSnapshot(event.slug)!;
    assert.equal(execution.fills.length, 1);
    assert.equal(execution.fills[0]?.liquidity, "maker");
    assert.equal(execution.fills[0]?.fee, 0);

    const completion: TradeOpportunity = {
      ...opening,
      token: books[1]!,
      price: 0.6,
      size: 5,
      tradeKey: "completion",
      orderPolicy: "fak",
      pairLockRole: "completion_taker",
      pairLockSourceFillId: "maker-trade:live-1",
      pairLockEntryPrice: 0.4,
    };
    const completionResult = await trader.placeBuy(completion);
    assert.equal(completionResult.accepted, true);
    const marketCall = calls.find((call) => call.method === "market")!;
    assert.equal(marketCall.orderType, "FAK");
    assert.deepEqual(marketCall.order, {
      tokenID: "down-token",
      amount: 3,
      price: 0.6,
      side: "BUY",
      orderType: "FAK",
    });

    trades.push({
      id: "taker-trade",
      taker_order_id: String(responseId(completionResult.response)),
      market: event.market.conditionId,
      asset_id: "down-token",
      side: "BUY",
      size: "5",
      fee_rate_bps: "700",
      price: "0.6",
      status: "MATCHED",
      match_time: "1767225601",
      last_update: "1767225601",
      outcome: "Down",
      bucket_index: 0,
      owner: "owner",
      maker_address: "maker",
      maker_orders: [],
      trader_side: "TAKER",
    } as Trade);
    await trader.observeMarket(event, books);
    execution = trader.getMarketExecutionSnapshot(event.slug)!;
    const takerFill = execution.fills.find(
      (fill) => fill.id === "taker-trade:live-2",
    );
    assert.equal(takerFill?.size, 5);
    assert.ok((takerFill?.fee ?? 0) > 0);

    const resting = await trader.placeBuy({
      ...opening,
      tradeKey: "cancel-me",
    });
    await trader.cancelOrders([String(responseId(resting.response))]);
    assert.ok(
      calls.some(
        (call) =>
          call.method === "cancel" &&
          (call.ids as string[]).includes("live-3"),
        ),
    );

    const limitCallsBeforeRestart = calls.filter(
      (call) => call.method === "limit",
    ).length;
    const restarted = new Trader(config, { client: fakeClient });
    await restarted.init();
    await restarted.observeMarket(event, books);
    const duplicate = await restarted.placeBuy(opening);
    assert.equal(
      (duplicate.response as { duplicate?: boolean }).duplicate,
      true,
    );
    assert.equal(
      calls.filter((call) => call.method === "limit").length,
      limitCallsBeforeRestart,
    );
    assert.equal(
      restarted.getMarketExecutionSnapshot(event.slug)?.fills.length,
      2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function responseId(response: unknown): unknown {
  return (response as { orderID?: unknown })?.orderID;
}
