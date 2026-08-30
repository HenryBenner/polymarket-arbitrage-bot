import assert from "node:assert/strict";
import test from "node:test";
import { exactKalshiDepthCost, exactKalshiFee } from "../src/kalshi-fees.js";

test("Kalshi trade fees round up to the nearest centicent", () => {
  const result = exactKalshiFee({ price: 0.42, size: 1, rate: 0.07, exponent: 1 });
  assert.equal(result.tradeFee, 0.0171);
  assert.equal(result.roundingFee, 0.0029);
  assert.equal(result.netFee, 0.02);
});

test("Kalshi order rounding accumulator rebates complete cents", () => {
  const first = exactKalshiFee({ price: 0.333, size: 1, rate: 0, exponent: 1 });
  const second = exactKalshiFee({
    price: 0.333, size: 1, rate: 0, exponent: 1,
    accumulator: first.accumulator,
  });
  assert.equal(first.roundingFee, 0.007);
  assert.equal(first.rebate, 0);
  assert.equal(second.rebate, 0.01);
  assert.equal(second.accumulator, 0.004);
});

test("Kalshi depth cost carries one rounding accumulator across partial fills", () => {
  const cost = exactKalshiDepthCost({
    levels: [{ price: 0.333, size: 1 }, { price: 0.334, size: 1 }],
    size: 2, rate: 0, exponent: 1,
  });
  assert.ok(cost);
  assert.equal(cost.limitPrice, 0.334);
  assert.equal(cost.total, 0.67);
  assert.equal(cost.fee, 0.003);
});
