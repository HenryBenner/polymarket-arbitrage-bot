import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperTrader } from "../src/paper-trader.js";
import type {
  TokenBook,
  TradeOpportunity,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

const fakeStream = {
  subscribe(_ids: string[]): void {},
  close(): void {},
};

function opportunity(
  token: TokenBook,
  tradeKey: string,
  price: number,
  size: number,
): TradeOpportunity {
  return {
    kind: token.outcome === "Up" ? "cheap" : "expensive",
    event: testEvent(),
    token,
    price,
    size,
    tickSize: "0.01",
    negRisk: false,
    tradeKey,
    strategyMode: "odahoa_ladder",
    phaseId: "15-10",
    pairId: "0.45-0.55",
  };
}

test("paper trading handles immediate partial fills, queue-ahead, resting fills, and deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-fill-"));
  try {
    const trader = new PaperTrader(
      testConfig({ paperStatePath: directory }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0.07, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks();
    books[0]!.bids = [{ price: 0.45, size: 1.5 }];
    books[0]!.asks = [
      { price: 0.44, size: 1 },
      { price: 0.45, size: 1 },
      { price: 0.46, size: 10 },
    ];
    await trader.observeMarket(testEvent(), books);

    const result = await trader.placeBuy(
      opportunity(books[0]!, "paper-up", 0.45, 2.23),
    );
    assert.equal(
      (result.response as { status: string }).status,
      "partial",
    );
    let state = trader.snapshot();
    assert.equal(state.fills.length, 2);
    assert.equal(state.orders[0]?.remainingSize, 0.23);
    assert.ok(state.fills.every((fill) => fill.liquidity === "taker"));
    assert.ok(state.fills.every((fill) => fill.fee > 0));

    await trader.ingestMarketEvent({
      event_type: "last_trade_price",
      asset_id: "up-token",
      side: "SELL",
      price: "0.45",
      size: "1",
      timestamp: "1",
    });
    state = trader.snapshot();
    assert.equal(state.orders[0]?.queueAhead, 0.5);
    assert.equal(state.orders[0]?.remainingSize, 0.23);

    const fillEvent = {
      event_type: "last_trade_price",
      asset_id: "up-token",
      side: "SELL",
      price: "0.45",
      size: "1",
      timestamp: "2",
    };
    await trader.ingestMarketEvent(fillEvent);
    state = trader.snapshot();
    assert.equal(state.orders[0]?.status, "filled");
    assert.equal(state.fills.at(-1)?.liquidity, "maker");
    const fillCount = state.fills.length;
    await trader.ingestMarketEvent(fillEvent);
    assert.equal(trader.snapshot().fills.length, fillCount);

    const unfilled = await trader.placeBuy(
      opportunity(books[1]!, "paper-down", 0.2, 5),
    );
    assert.equal((unfilled.response as { status: string }).status, "open");
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper settlement pays the winning shares and persists across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-settle-"));
  try {
    const config = testConfig({ paperStatePath: directory });
    const trader = new PaperTrader(config, {
      stream: fakeStream,
      feeLoader: async () => ({ rate: 0, exponent: 1 }),
      settlementLoader: async () => null,
    });
    await trader.init();
    const books = testBooks();
    books[0]!.asks = [{ price: 0.4, size: 3 }];
    await trader.observeMarket(testEvent(), books);
    await trader.placeBuy(opportunity(books[0]!, "winner", 0.45, 2));
    await trader.ingestMarketEvent({
      event_type: "market_resolved",
      winning_asset_id: "up-token",
    });

    const settled = trader.snapshot();
    assert.equal(settled.settlements.length, 1);
    assert.equal(settled.settlements[0]?.payout, 2);
    assert.equal(settled.settlements[0]?.realizedPnl, 1.2);
    assert.equal(settled.cash, 101.2);
    await trader.close();

    const restarted = new PaperTrader(config, {
      stream: fakeStream,
      feeLoader: async () => ({ rate: 0, exponent: 1 }),
      settlementLoader: async () => null,
    });
    await restarted.init();
    assert.equal(restarted.snapshot().settlements.length, 1);
    const duplicate = await restarted.placeBuy(
      opportunity(books[0]!, "winner", 0.45, 2),
    );
    assert.equal(
      (duplicate.response as { duplicate: boolean }).duplicate,
      true,
    );
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paper settlement also handles the opposite outcome winning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-other-winner-"));
  try {
    const trader = new PaperTrader(
      testConfig({ paperStatePath: directory }),
      {
        stream: fakeStream,
        feeLoader: async () => ({ rate: 0, exponent: 1 }),
        settlementLoader: async () => null,
      },
    );
    await trader.init();
    const books = testBooks();
    books[1]!.asks = [{ price: 0.5, size: 2 }];
    await trader.observeMarket(testEvent(), books);
    await trader.placeBuy(opportunity(books[1]!, "down-winner", 0.55, 2));
    await trader.ingestMarketEvent({
      event_type: "market_resolved",
      winning_asset_id: "down-token",
    });
    assert.equal(trader.snapshot().settlements[0]?.winningOutcome, "Down");
    assert.equal(trader.snapshot().settlements[0]?.payout, 2);
    assert.equal(trader.snapshot().settlements[0]?.realizedPnl, 1);
    await trader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
