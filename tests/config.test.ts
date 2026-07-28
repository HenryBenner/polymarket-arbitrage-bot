import assert from "node:assert/strict";
import test from "node:test";
import { validateTradingConfig } from "../src/config.js";
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

test("live ladder mode enforces the projected cap before wallet startup", () => {
  assert.throws(
    () =>
      validateTradingConfig(
        testConfig({
          executionMode: "live",
          dryRun: false,
          ladderSizeScale: 2,
          ladderLiveMaxUsdcPerMarket: 65,
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

test("ladder_v5 is paper-only and enforces its statistical guardrails", () => {
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
    /paper-only/,
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
