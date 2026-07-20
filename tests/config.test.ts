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
    /only supports/,
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
