import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findLadderOpportunities,
  LadderTracker,
} from "../src/ladder.js";
import { planLadderV5 } from "../src/ladder-v5.js";
import { planLadderV55 } from "../src/ladder-v5-5.js";
import { planLadderV6 } from "../src/ladder-v6.js";
import { planLadderV7 } from "../src/ladder-v7.js";
import { planLadderV9 } from "../src/ladder-v9.js";
import { findPairLockOpeningOpportunities } from "../src/pair-lock.js";
import type { MarketExecutionSnapshot } from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

test("all ladder planners operate on a non-BTC Kalshi market slug", async () => {
  const directory = await mkdtemp(join(tmpdir(), "altcoin-ladders-"));
  try {
    const base = testEvent();
    const windowEnd = Date.now() / 1_000 + 4 * 60;
    const slug = `eth-updown-15m-${Math.floor(windowEnd - 900)}`;
    const event = {
      ...base,
      slug,
      windowStart: windowEnd - 900,
      windowEnd,
      market: {
        ...base.market,
        exchange: "kalshi" as const,
        externalMarketId: "KXETH15M-TEST",
        seriesTicker: "KXETH15M",
        id: "KXETH15M-TEST",
        conditionId: "KXETH15M-TEST",
        slug,
        feeSchedule: { rate: 0.07, makerRate: 0, exponent: 1 },
      },
    };
    const books = testBooks();
    const tracker = new LadderTracker(directory, "altcoin-state.json");
    await tracker.init();
    const config = testConfig({
      exchange: "kalshi",
      kalshiSeriesTickers: ["KXETH15M"],
      paperStatePath: directory,
    });
    const snapshot: MarketExecutionSnapshot = {
      marketSlug: slug,
      orders: [],
      openOrders: [],
      fills: [],
      positions: [],
      books,
      capitalUsed: 0,
      openCommitted: 0,
      capitalCommitted: 0,
      availableCash: 1_000,
      totalFees: 0,
      estimatedMakerRebate: 0,
      takerFeeRate: 0.07,
      makerFeeRate: 0,
      takerFeeExponent: 1,
      settledPnl: null,
    };

    const v1 = await findLadderOpportunities(
      { ...config, strategyMode: "odahoa_ladder" },
      tracker,
      event,
      books,
    );
    const v2 = await findPairLockOpeningOpportunities(
      { ...config, strategyMode: "odahoa_ladder_2" },
      tracker,
      event,
      books,
    );
    const v5 = await planLadderV5(
      { ...config, strategyMode: "ladder_v5" },
      tracker,
      event,
      books,
      snapshot,
    );
    const v6 = await planLadderV6(
      { ...config, strategyMode: "ladder_v6" },
      tracker,
      event,
      snapshot,
    );
    const v55 = await planLadderV55(
      { ...config, strategyMode: "ladder_v5.5" },
      tracker,
      event,
      snapshot,
    );
    const v7 = await planLadderV7(
      { ...config, strategyMode: "ladder_v7" },
      tracker,
      event,
      books,
      snapshot,
    );
    const v9 = await planLadderV9(
      { ...config, strategyMode: "ladder_v9" },
      tracker,
      event,
      books,
      snapshot,
    );

    for (const opportunities of [
      v1,
      v2,
      v5.opportunities,
      v55.opportunities,
      v6.opportunities,
      v7.opportunities,
      v9.opportunities,
    ]) {
      assert.ok(opportunities.length > 0);
      assert.ok(
        opportunities.every(
          (opportunity) => opportunity.event.slug === slug,
        ),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
