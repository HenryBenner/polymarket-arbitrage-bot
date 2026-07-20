import type { BotConfig } from "../src/config.js";
import type { TokenBook, UpDownEvent } from "../src/types.js";

export function testConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    strategyMode: "odahoa_ladder",
    executionMode: "paper",
    pollIntervalMs: 5_000,
    marketSlugPrefixes: ["btc-updown-15m"],
    cheapBuyMin: 0.07,
    cheapBuyMax: 0.1,
    expensiveBuyMin: 0.9,
    expensiveBuyMax: 0.95,
    enableExpensiveHedge: true,
    cheapOrderUsdc: 10,
    expensiveOrderUsdc: 50,
    maxSharesPerOrder: 90,
    minutesBeforeCloseMin: 0,
    minutesBeforeCloseMax: 15,
    dryRun: true,
    signatureType: 3,
    clobHost: "https://clob.polymarket.com",
    chainId: 137,
    gammaApiHost: "https://gamma-api.polymarket.com",
    ladderPreset: "odahoa_v1",
    ladderSizeScale: 1,
    ladderLiveMaxUsdcPerMarket: 65,
    paperStartingUsdc: 100,
    paperStatePath: "./data/test-paper",
    ...overrides,
  };
}

export function testEvent(): UpDownEvent {
  return {
    title: "Bitcoin Up or Down - Test",
    slug: "btc-updown-15m-1000000000",
    windowStart: 1_000_000_000,
    windowEnd: 1_000_000_900,
    market: {
      id: "123",
      question: "Bitcoin Up or Down?",
      conditionId: "condition",
      slug: "btc-updown-15m-1000000000",
      clobTokenIds: JSON.stringify(["up-token", "down-token"]),
      outcomes: JSON.stringify(["Up", "Down"]),
      negRisk: false,
      orderPriceMinTickSize: 0.01,
      active: true,
      closed: false,
    },
  };
}

export function testBooks(
  upAsk = 0.4,
  downAsk = 0.6,
  minimumSize = 0,
): TokenBook[] {
  return [
    {
      tokenId: "up-token",
      outcome: "Up",
      outcomeIndex: 0,
      bestBid: 0.39,
      bestAsk: upAsk,
      bids: [{ price: 0.39, size: 10 }],
      asks: [{ price: upAsk, size: 10 }],
      minOrderSize: minimumSize,
    },
    {
      tokenId: "down-token",
      outcome: "Down",
      outcomeIndex: 1,
      bestBid: 0.59,
      bestAsk: downAsk,
      bids: [{ price: 0.59, size: 10 }],
      asks: [{ price: downAsk, size: 10 }],
      minOrderSize: minimumSize,
    },
  ];
}
