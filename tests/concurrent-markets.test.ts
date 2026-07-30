import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReverseBot, type MarketSource } from "../src/bot.js";
import type {
  OrderExecutor,
  OrderResult,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "../src/types.js";
import { testConfig } from "./helpers.js";

function marketEvent(asset: string, series: string): UpDownEvent {
  const windowEnd = Date.now() / 1_000 + 14 * 60;
  const slug = `${asset}-updown-15m-${Math.floor(windowEnd - 900)}`;
  return {
    title: `${asset.toUpperCase()} Up or Down`,
    slug,
    windowStart: windowEnd - 900,
    windowEnd,
    market: {
      exchange: "kalshi",
      externalMarketId: `${series}-TEST`,
      seriesTicker: series,
      id: `${series}-TEST`,
      question: `${asset.toUpperCase()} Up or Down`,
      conditionId: `${series}-TEST`,
      slug,
      clobTokenIds: JSON.stringify([
        `${series}-TEST::yes`,
        `${series}-TEST::no`,
      ]),
      outcomes: JSON.stringify(["Up", "Down"]),
      negRisk: false,
      orderPriceMinTickSize: 0.01,
      feeSchedule: { rate: 0.07, makerRate: 0, exponent: 1 },
      active: true,
      closed: false,
    },
  };
}

function booksFor(event: UpDownEvent): TokenBook[] {
  const tokenIds = JSON.parse(event.market.clobTokenIds) as string[];
  return [
    {
      tokenId: tokenIds[0]!,
      outcome: "Up",
      outcomeIndex: 0,
      bestBid: 0.39,
      bestAsk: 0.4,
      bids: [{ price: 0.39, size: 100 }],
      asks: [{ price: 0.4, size: 100 }],
      minOrderSize: 1,
    },
    {
      tokenId: tokenIds[1]!,
      outcome: "Down",
      outcomeIndex: 1,
      bestBid: 0.59,
      bestAsk: 0.6,
      bids: [{ price: 0.59, size: 100 }],
      asks: [{ price: 0.6, size: 100 }],
      minOrderSize: 1,
    },
  ];
}

class RecordingExecutor implements OrderExecutor {
  readonly markets = new Set<string>();
  inFlight = 0;
  maxInFlight = 0;

  async init(): Promise<void> {}

  async observeMarket(event: UpDownEvent): Promise<void> {
    this.markets.add(event.slug);
  }

  async placeBuy(
    opportunity: TradeOpportunity,
  ): Promise<OrderResult> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    this.inFlight -= 1;
    return {
      dryRun: true,
      accepted: true,
      tokenId: opportunity.token.tokenId,
      side: "BUY",
      price: opportunity.price,
      size: opportunity.size,
    };
  }
}

test("ladder markets process concurrently and isolate a market failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multi-market-bot-"));
  try {
    const events = [
      marketEvent("ada", "KXADA15M"),
      marketEvent("btc", "KXBTC15M"),
      marketEvent("eth", "KXETH15M"),
      marketEvent("sol", "KXSOL15M"),
      marketEvent("xrp", "KXXRP15M"),
    ];
    const scanner: MarketSource = {
      async scan() {
        return events;
      },
      async getTokenBooks(event) {
        if (event.market.seriesTicker === "KXETH15M") {
          throw new Error("isolated book failure");
        }
        return booksFor(event);
      },
    };
    const executor = new RecordingExecutor();
    const bot = new ReverseBot(
      testConfig({
        exchange: "kalshi",
        strategyMode: "odahoa_ladder",
        executionMode: "paper",
        paperStatePath: directory,
        kalshiSeriesTickers: events.map(
          (event) => event.market.seriesTicker!,
        ),
      }),
      executor,
      scanner,
    );
    await bot.init();
    await bot.runOnce();

    assert.ok(executor.maxInFlight >= 4);
    assert.equal(executor.markets.size, 4);
    assert.equal(
      [...executor.markets].some((slug) =>
        slug.startsWith("eth-updown-15m-"),
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
