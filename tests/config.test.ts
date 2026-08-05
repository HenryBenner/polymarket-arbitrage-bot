import assert from "node:assert/strict";
import test from "node:test";
import {
  kalshiFeeRatesForSeries,
  loadConfig,
  validateTradingConfig,
} from "../src/config.js";
import { testConfig } from "./helpers.js";

test("paper ladder mode needs no wallet secrets", () => {
  assert.doesNotThrow(() => validateTradingConfig(testConfig()));
});

test("ladder v1 rejects non-BTC or multiple market prefixes", () => {
  assert.throws(
    () =>
      validateTradingConfig(
        testConfig({
          marketSlugPrefixes: ["btc-updown-15m", "eth-updown-15m"],
        }),
      ),
    /only support/,
  );
});

test("Kalshi ladder modes accept multiple validated crypto series", () => {
  const config = testConfig({
    exchange: "kalshi",
    strategyMode: "ladder_v5",
    kalshiSeriesTickers: [
      "KXADA15M",
      "KXBTC15M",
      "KXETH15M",
      "KXSOL15M",
      "KXXRP15M",
    ],
    kalshiApiKeyId: "key-id",
    kalshiPrivateKeyPem:
      "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
  });
  assert.doesNotThrow(() => validateTradingConfig(config));
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        strategyMode: "odahoa_static_maker",
      }),
    /only supports CRYPTO_MARKETS=KXBTC15M/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        kalshiSeriesTickers: ["BTC15M"],
      }),
    /expected KX<ASSET>15M/,
  );
});

test("CRYPTO_MARKETS takes precedence, normalizes, and deduplicates", () => {
  const keys = [
    "CRYPTO_MARKETS",
    "KALSHI_SERIES_TICKERS",
    "KALSHI_FEE_OVERRIDES",
    "LADDER_MAX_USDC_PER_MARKET",
    "LADDER_LIVE_MAX_USDC_PER_MARKET",
    "LADDER_PRESET",
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.CRYPTO_MARKETS =
      " kxada15m, KXBTC15M,kxada15m ";
    process.env.KALSHI_SERIES_TICKERS = "KXETH15M";
    process.env.KALSHI_FEE_OVERRIDES =
      "kxada15m:0.05:0.01";
    process.env.LADDER_MAX_USDC_PER_MARKET = "72";
    process.env.LADDER_LIVE_MAX_USDC_PER_MARKET = "61";
    process.env.LADDER_PRESET = "odahoa_v1";
    const config = loadConfig();
    assert.deepEqual(config.kalshiSeriesTickers, [
      "KXADA15M",
      "KXBTC15M",
    ]);
    assert.equal(config.ladderMaxUsdcPerMarket, 72);
    assert.deepEqual(
      kalshiFeeRatesForSeries(config, "KXADA15M"),
      { takerRate: 0.05, makerRate: 0.01 },
    );
    assert.deepEqual(
      kalshiFeeRatesForSeries(config, "KXBTC15M"),
      {
        takerRate: config.kalshiTakerFeeRate,
        makerRate: config.kalshiMakerFeeRate,
      },
    );
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Kalshi fee overrides reject malformed or out-of-range entries", () => {
  assert.throws(
    () =>
      validateTradingConfig(
        testConfig({
          exchange: "kalshi",
          executionMode: "dry_run",
          kalshiFeeOverrides: {
            KXBTC15M: { takerRate: 1, makerRate: 0 },
          },
        }),
      ),
    /KALSHI_FEE_OVERRIDES/,
  );
  const previous = process.env.KALSHI_FEE_OVERRIDES;
  const previousPreset = process.env.LADDER_PRESET;
  try {
    process.env.KALSHI_FEE_OVERRIDES = "KXBTC15M:not-a-rate:0";
    process.env.LADDER_PRESET = "odahoa_v1";
    assert.throws(() => loadConfig(), /Invalid KALSHI_FEE_OVERRIDES/);
  } finally {
    if (previous === undefined) delete process.env.KALSHI_FEE_OVERRIDES;
    else process.env.KALSHI_FEE_OVERRIDES = previous;
    if (previousPreset === undefined) delete process.env.LADDER_PRESET;
    else process.env.LADDER_PRESET = previousPreset;
  }
});

test("live ladder mode enforces the projected cap before wallet startup", () => {
  assert.throws(
    () =>
      validateTradingConfig(
        testConfig({
          executionMode: "live",
          dryRun: false,
          ladderSizeScale: 2,
          ladderMaxUsdcPerMarket: 65,
        }),
      ),
    /projected exposure \$113\.20 exceeds/,
  );
});

test("live ladder mode requires both explicit acknowledgements", () => {
  const live = testConfig({
    executionMode: "live",
    dryRun: false,
    privateKey: `0x${"1".repeat(64)}`,
    funderAddress: `0x${"2".repeat(40)}`,
    liveTradingAck: "I_UNDERSTAND_REAL_MONEY_IS_AT_RISK",
  });
  assert.throws(() => validateTradingConfig(live), /Live ladder mode is locked/);
  assert.doesNotThrow(() =>
    validateTradingConfig({
      ...live,
      ladderLiveAck: "I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY",
    }),
  );
});

test("pair-lock mode is available in live mode with the same ladder safeguards", () => {
  const live = testConfig({
    strategyMode: "odahoa_ladder_2",
    executionMode: "live",
    dryRun: false,
    privateKey: `0x${"1".repeat(64)}`,
    funderAddress: `0x${"2".repeat(40)}`,
    liveTradingAck: "I_UNDERSTAND_REAL_MONEY_IS_AT_RISK",
    ladderLiveAck: "I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY",
  });
  assert.doesNotThrow(() => validateTradingConfig(live));
  assert.throws(
    () => validateTradingConfig({ ...live, ladderLiveAck: undefined }),
    /Live ladder mode is locked/,
  );
});

test("ladder scale must be a positive integer", () => {
  assert.throws(
    () => validateTradingConfig(testConfig({ ladderSizeScale: 1.5 })),
    /integer of at least 1/,
  );
  assert.throws(
    () => validateTradingConfig(testConfig({ ladderSizeScale: 0 })),
    /integer of at least 1/,
  );
});

test("static maker is BTC paper-only with a 90-share, $500 cap", () => {
  const config = testConfig({
    strategyMode: "odahoa_static_maker",
    staticMakerMaxShares: 90,
    staticMakerMaxUsdcPerMarket: 500,
  });
  assert.doesNotThrow(() => validateTradingConfig(config));
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        executionMode: "live",
        dryRun: false,
      }),
    /paper-only/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        marketSlugPrefixes: ["eth-updown-15m"],
      }),
    /only support/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        staticMakerMaxUsdcPerMarket: 400,
      }),
    /projected exposure \$405\.00 exceeds/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        staticMakerMaxShares: 90.5,
      }),
    /positive integer/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        staticMakerMaxShares: 91,
      }),
    /no greater than 90/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        staticMakerMaxUsdcPerMarket: 501,
      }),
    /at most 500/,
  );
});

test("ladder_v5 supports Kalshi live mode and enforces its statistical guardrails", () => {
  const config = testConfig({
    strategyMode: "ladder_v5",
    executionMode: "paper",
    ladderSizeScale: 6,
    ladderV5MaxImbalance: 70,
    ladderV5MaxPairCost: 0.98,
  });
  assert.doesNotThrow(() => validateTradingConfig(config));
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        executionMode: "live",
        dryRun: false,
      }),
    /live mode on Kalshi/,
  );
  const kalshiLive = {
    ...config,
    exchange: "kalshi" as const,
    executionMode: "live" as const,
    dryRun: false,
    kalshiSeriesTickers: ["KXBTC15M", "KXETH15M"],
    kalshiApiKeyId: "key-id",
    kalshiPrivateKeyPem:
      "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
    liveTradingAck: "I_UNDERSTAND_REAL_MONEY_IS_AT_RISK",
    ladderLiveAck:
      "I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY",
  };
  assert.doesNotThrow(() => validateTradingConfig(kalshiLive));
  assert.throws(
    () =>
      validateTradingConfig({
        ...kalshiLive,
        ladderLiveAck: undefined,
      }),
    /Live ladder mode is locked/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, ladderSizeScale: 7 }),
    /limited to LADDER_SIZE_SCALE=1 through 6/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, ladderV5MaxImbalance: 0 }),
    /LADDER_V5_MAX_IMBALANCE/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, ladderV5MaxPairCost: 1 }),
    /LADDER_V5_MAX_PAIR_COST/,
  );
});

test("ladder_v5.5 is Kalshi-only with matching paper and live safeguards", () => {
  const paper = testConfig({
    exchange: "kalshi",
    strategyMode: "ladder_v5.5",
    executionMode: "paper",
    kalshiApiKeyId: "key-id",
    kalshiPrivateKeyPem:
      "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
  });
  assert.doesNotThrow(() => validateTradingConfig(paper));
  assert.throws(
    () =>
      validateTradingConfig({
        ...paper,
        exchange: "polymarket",
      }),
    /Kalshi paper and live modes only/,
  );
  const live = {
    ...paper,
    executionMode: "live" as const,
    dryRun: false,
    liveTradingAck: "I_UNDERSTAND_REAL_MONEY_IS_AT_RISK",
    ladderLiveAck: "I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY",
  };
  assert.doesNotThrow(() => validateTradingConfig(live));
  assert.throws(
    () => validateTradingConfig({ ...live, ladderLiveAck: undefined }),
    /Live ladder mode is locked/,
  );
  assert.throws(
    () => validateTradingConfig({ ...paper, ladderSizeScale: 7 }),
    /limited to LADDER_SIZE_SCALE=1 through 6/,
  );
});

test("ladder_v6 is paper-only with a 40-share cap and positive edge", () => {
  const config = testConfig({
    strategyMode: "ladder_v6",
    executionMode: "paper",
    ladderV6MaxUnmatchedShares: 40,
    ladderV6MinNetEdge: 0.01,
    ladderV6SafetyBuffer: 0.01,
    ladderV6MaxRescueLoss: 0.02,
  });
  assert.doesNotThrow(() => validateTradingConfig(config));
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        executionMode: "live",
        dryRun: false,
      }),
    /paper-only/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, ladderV6SafetyBuffer: -0.01 }),
    /LADDER_V6_SAFETY_BUFFER/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, ladderV6MaxRescueLoss: -0.01 }),
    /LADDER_V6_MAX_RESCUE_LOSS/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        ladderV6MaxUnmatchedShares: 0,
      }),
    /LADDER_V6_MAX_UNMATCHED_SHARES/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, ladderV6MinNetEdge: 0 }),
    /LADDER_V6_MIN_NET_EDGE/,
  );
});

test("ladder_v7 is Kalshi paper-only with an asymmetric price and share cap", () => {
  const config = testConfig({
    exchange: "kalshi",
    strategyMode: "ladder_v7",
    executionMode: "paper",
    ladderV7CheapPrice: 0.1,
    ladderV7FavoritePrice: 0.8,
    ladderV7MaxShares: 40,
    kalshiApiKeyId: "key-id",
    kalshiPrivateKeyPem:
      "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  });
  assert.doesNotThrow(() => validateTradingConfig(config));
  assert.throws(
    () => validateTradingConfig({ ...config, executionMode: "live" }),
    /paper-only/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, exchange: "polymarket" }),
    /paper-only/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, ladderV7MaxShares: 0 }),
    /LADDER_V7_MAX_SHARES/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        ladderV7CheapPrice: 0.2,
        ladderV7FavoritePrice: 0.8,
      }),
    /must be less than 1/,
  );
});

test("ladder_v8 is Polymarket paper-only with Odahoa sizing guards", () => {
  const config = testConfig({
    exchange: "polymarket",
    strategyMode: "ladder_v8",
    executionMode: "paper",
    ladderV8SizeScale: 1,
    ladderV8MaxSharesPerOrder: 120,
    ladderV8MaxUnmatchedShares: 240,
  });
  assert.doesNotThrow(() => validateTradingConfig(config));
  assert.throws(
    () => validateTradingConfig({ ...config, executionMode: "live" }),
    /paper-only/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, exchange: "kalshi" }),
    /paper-only/,
  );
  assert.throws(
    () => validateTradingConfig({ ...config, ladderV8SizeScale: 0 }),
    /LADDER_V8_SIZE_SCALE/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        ladderV8MaxSharesPerOrder: 0,
      }),
    /LADDER_V8_MAX_SHARES_PER_ORDER/,
  );
  assert.throws(
    () =>
      validateTradingConfig({
        ...config,
        ladderV8MaxUnmatchedShares: 0,
      }),
    /LADDER_V8_MAX_UNMATCHED_SHARES/,
  );
});
