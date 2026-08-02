import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planLadderV55 } from "../src/ladder-v5-5.js";
import { LadderTracker } from "../src/ladder.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  TokenBook,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function openingOrder(
  status: PaperOrder["status"] = "open",
  originalSize = 10,
  remainingSize = originalSize,
  price = 0.1,
  ceilingPrice = 0.2,
  phaseId = "5-2",
): PaperOrder {
  return {
    id: "v55-opening",
    tradeKey: "ladder-v5.5:opening:test",
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId: "up-token",
    outcome: "Up",
    limitPrice: price,
    originalSize,
    remainingSize,
    queueAhead: 0,
    status,
    phaseId,
    pairId: `ladder-v5.5:opening:${phaseId}:${ceilingPrice.toFixed(2)}`,
    orderPolicy: "post_only",
    pairLockRole: "opening",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function hedgeOrder(status: PaperOrder["status"] = "filled"): PaperOrder {
  return {
    ...openingOrder(status, 10, status === "filled" ? 0 : 10),
    id: "v55-hedge",
    tradeKey: "ladder-v5.5:hedge:test",
    tokenId: "down-token",
    outcome: "Down",
    limitPrice: 0.85,
    pairId: "ladder-v5.5:hedge:fok",
    orderPolicy: "fok",
    pairLockRole: "completion_taker",
  };
}

function fill(
  order: PaperOrder,
  price: number,
  size: number,
  fee = 0,
): PaperFill {
  return {
    id: `fill-${order.id}`,
    orderId: order.id,
    marketSlug: order.marketSlug,
    tokenId: order.tokenId,
    outcome: order.outcome,
    price,
    size,
    fee,
    liquidity: order.orderPolicy === "fok" ? "taker" : "maker",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function snapshot(
  orders: PaperOrder[] = [],
  fills: PaperFill[] = [],
  books: TokenBook[] = testBooks(0.4, 0.85),
): MarketExecutionSnapshot {
  return {
    marketSlug: testEvent().slug,
    orders,
    openOrders: orders.filter(
      (order) => order.status === "open" || order.status === "partial",
    ),
    fills,
    positions: [],
    books,
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 2_000,
    totalFees: fills.reduce((sum, item) => sum + item.fee, 0),
    estimatedMakerRebate: 0,
    takerFeeRate: 0.07,
    makerFeeRate: 0,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

async function withTracker(
  run: (tracker: LadderTracker, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v5-5-"));
  try {
    const tracker = new LadderTracker(directory, "ladder-v5-5-state.json");
    await tracker.init();
    await run(tracker, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ladder_v5.5 submits one dynamically safe post-only entry", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v5.5",
      executionMode: "paper",
      paperStatePath: directory,
      ladderSizeScale: 4,
    });
    const books = testBooks(0.4, 0.85);
    books[0]!.asks = [{ price: 0.4, size: 100 }];
    books[1]!.asks = [{ price: 0.85, size: 100 }];
    const initial = await planLadderV55(
      config,
      tracker,
      event,
      snapshot([], [], books),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(
      initial.opportunities.map((opportunity) => ({
        outcome: opportunity.token.outcome,
        price: opportunity.price,
        size: opportunity.size,
        policy: opportunity.orderPolicy,
        role: opportunity.pairLockRole,
      })),
      [
        {
          outcome: "Up",
          price: 0.12,
          size: 20,
          policy: "post_only",
          role: "opening",
        },
      ],
    );

    const resting = await planLadderV55(
      config,
      tracker,
      event,
      snapshot([openingOrder("open", 20, 20, 0.12)], [], books),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(resting.cancelOrderIds, []);
    assert.deepEqual(resting.opportunities, []);
  });
});

test("ladder_v5.5 uses the V1 phase ceilings with fee-safe dynamic bids", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v5.5",
      executionMode: "paper",
      paperStatePath: directory,
    });
    const earlyBooks = testBooks(0.5, 0.5);
    const early = await planLadderV55(
      config,
      tracker,
      event,
      snapshot([], [], earlyBooks),
      event.windowEnd - 12 * 60,
    );
    assert.equal(early.opportunities[0]!.phaseId, "15-10");
    assert.equal(early.opportunities[0]!.price, 0.45);
    assert.equal(early.opportunities[0]!.size, 2.23);

    const middle = await planLadderV55(
      config,
      tracker,
      event,
      snapshot([], [], testBooks(0.4, 0.65)),
      event.windowEnd - 7 * 60,
    );
    assert.equal(middle.opportunities[0]!.phaseId, "10-5");
    assert.equal(middle.opportunities[0]!.price, 0.31);
    assert.equal(middle.opportunities[0]!.size, 2.86);

    const late = await planLadderV55(
      config,
      tracker,
      event,
      snapshot([], [], testBooks(0.4, 0.8)),
      event.windowEnd - 4 * 60,
    );
    assert.equal(late.opportunities[0]!.phaseId, "5-2");
    assert.equal(late.opportunities[0]!.price, 0.16);
    assert.equal(late.opportunities[0]!.size, 5);

    const finalTwoMinutes = await planLadderV55(
      config,
      tracker,
      event,
      snapshot(),
      event.windowEnd - 90,
    );
    assert.deepEqual(finalTwoMinutes.opportunities, []);
  });
});

test("ladder_v5.5 cancels a resting entry when its observed hedge becomes unsafe", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("open", 2.23, 2.23, 0.45, 0.45, "15-10");
    const plan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot([entry], [], testBooks(0.5, 0.6)),
      event.windowEnd - 12 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, [entry.id]);
    assert.deepEqual(plan.opportunities, []);
  });
});

test("ladder_v5.5 does not open a rung without full opposite hedge depth", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.5, 0.5);
    books[1]!.asks = [{ price: 0.5, size: 1 }];
    const plan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot([], [], books),
      event.windowEnd - 12 * 60,
    );
    assert.deepEqual(plan.opportunities, []);
  });
});

test("ladder_v5.5 keeps a partially filled cheap order resting and hedges its confirmed fill", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("partial", 40, 30);
    const plan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot([entry], [fill(entry, 0.1, 10)]),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, []);
    assert.equal(plan.opportunities.length, 1);
    assert.equal(plan.opportunities[0]!.size, 10);
    assert.equal(plan.opportunities[0]!.orderPolicy, "fok");
  });
});

test("ladder_v5.5 cancels a partial remainder at cutoff and hedges its confirmed fill", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("partial", 40, 30);
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v5.5",
      executionMode: "paper",
      paperStatePath: directory,
    });
    const cutoff = await planLadderV55(
      config,
      tracker,
      event,
      snapshot([entry], [fill(entry, 0.1, 10)]),
      event.windowEnd - 2 * 60,
    );
    assert.deepEqual(cutoff.cancelOrderIds, [entry.id]);
    assert.equal(cutoff.opportunities.length, 1);
    assert.equal(cutoff.opportunities[0]!.size, 10);

    const cancelled = { ...entry, status: "cancelled" as const };
    const afterCancellation = await planLadderV55(
      config,
      tracker,
      event,
      snapshot([cancelled], [fill(cancelled, 0.1, 10)]),
      event.windowEnd - 90,
    );
    assert.deepEqual(afterCancellation.cancelOrderIds, []);
    assert.equal(afterCancellation.opportunities.length, 1);
    assert.equal(afterCancellation.opportunities[0]!.size, 10);
    assert.equal(afterCancellation.unmatchedCheapShares, 10);
  });
});

test("ladder_v5.5 issues another hedge only for later confirmed cheap fills", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("partial", 40, 20);
    const firstHedge = hedgeOrder("filled");
    const firstEntryFill = fill(entry, 0.1, 10);
    const secondEntryFill = {
      ...fill(entry, 0.1, 10),
      id: "fill-v55-opening-second",
    };
    const plan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(
        [entry, firstHedge],
        [firstEntryFill, secondEntryFill, fill(firstHedge, 0.85, 10)],
      ),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, []);
    assert.equal(plan.pairedShares, 10);
    assert.equal(plan.unmatchedCheapShares, 10);
    assert.equal(plan.opportunities.length, 1);
    assert.equal(plan.opportunities[0]!.size, 10);
  });
});

test("ladder_v5.5 opens the 15-cent ceiling after the 20-cent rung is fully paired", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("filled", 10, 0);
    const hedge = hedgeOrder("filled");
    const plan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(
        [entry, hedge],
        [fill(entry, 0.1, 10), fill(hedge, 0.85, 10)],
      ),
      event.windowEnd - 4 * 60,
    );
    assert.equal(plan.unmatchedCheapShares, 0);
    assert.equal(plan.opportunities.length, 1);
    assert.equal(plan.opportunities[0]!.kind, "cheap");
    assert.equal(plan.opportunities[0]!.price, 0.12);
    assert.equal(
      plan.opportunities[0]!.pairId,
      "ladder-v5.5:opening:5-2:0.15",
    );
  });
});

test("ladder_v5.5 hedges exactly the confirmed cheap fill with profitable FOK depth", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("filled", 10, 0);
    const plan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
        ladderV5MaxPairCost: 0.98,
      }),
      tracker,
      event,
      snapshot([entry], [fill(entry, 0.1, 10)]),
      event.windowEnd - 4 * 60,
    );
    assert.equal(plan.opportunities.length, 1);
    const hedge = plan.opportunities[0]!;
    assert.equal(hedge.token.outcome, "Down");
    assert.equal(hedge.price, 0.85);
    assert.equal(hedge.size, 10);
    assert.equal(hedge.orderPolicy, "fok");
    assert.equal(hedge.pairLockRole, "completion_taker");
    assert.ok((hedge.plannedAllInPairCost ?? 1) <= 0.98);
  });
});

test("ladder_v5.5 leaves cheap exposure capped when the fee-adjusted hedge is unprofitable", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("filled", 10, 0);
    const books = testBooks(0.4, 0.89);
    books[1]!.asks = [{ price: 0.89, size: 100 }];
    books[1]!.bestAsk = 0.89;
    const plan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
        ladderV5MaxPairCost: 0.98,
      }),
      tracker,
      event,
      snapshot([entry], [fill(entry, 0.1, 10)], books),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(plan.opportunities, []);
    assert.ok((plan.plannedAllInPairCost ?? 0) > 0.98);
    assert.equal(plan.unmatchedCheapShares, 10);
  });
});

test("ladder_v5.5 cancels the unfilled cheap remainder when a partial fill cannot be hedged", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("partial", 20, 10, 0.1);
    const books = testBooks(0.4, 0.89);
    books[1]!.asks = [{ price: 0.89, size: 100 }];
    books[1]!.bestAsk = 0.89;
    const plan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
        ladderV5MaxPairCost: 0.98,
      }),
      tracker,
      event,
      snapshot([entry], [fill(entry, 0.1, 10)], books),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, [entry.id]);
    assert.deepEqual(plan.opportunities, []);
    assert.equal(plan.unmatchedCheapShares, 10);
  });
});

test("ladder_v5.5 stops after an exact hedge and cancels an unfilled entry at two minutes", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const entry = openingOrder("filled", 10, 0);
    const hedge = hedgeOrder("filled");
    const pairedPlan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(
        [entry, hedge],
        [fill(entry, 0.1, 10), fill(hedge, 0.85, 10)],
      ),
      event.windowEnd - 90,
    );
    assert.deepEqual(pairedPlan.opportunities, []);
    assert.equal(pairedPlan.pairedShares, 10);
    assert.equal(pairedPlan.unmatchedCheapShares, 0);

    const resting = openingOrder("open", 10, 10);
    const cutoffPlan = await planLadderV55(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v5.5",
        executionMode: "paper",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot([resting]),
      event.windowEnd - 2 * 60,
    );
    assert.deepEqual(cutoffPlan.cancelOrderIds, [resting.id]);
  });
});
