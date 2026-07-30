import assert from "node:assert/strict";
import test from "node:test";
import type { TradeOpportunity } from "../src/types.js";
import { validateOrderMinimum } from "../src/utils/order-validation.js";
import { testBooks, testEvent } from "./helpers.js";

function opportunity(
  exchange: "polymarket" | "kalshi",
  price: number,
  size: number,
): TradeOpportunity {
  const event = testEvent();
  event.market.exchange = exchange;
  event.market.orderPriceMinTickSize = exchange === "kalshi" ? 0.001 : 0.01;
  event.market.orderPriceRanges =
    exchange === "kalshi"
      ? [
          { start: 0, end: 0.1, step: 0.001 },
          { start: 0.1, end: 0.9, step: 0.01 },
          { start: 0.9, end: 1, step: 0.001 },
        ]
      : undefined;
  const token = testBooks(price, 1 - price)[0]!;
  token.bestAsk = price;
  return {
    kind: "cheap",
    event,
    token,
    price,
    size,
    tickSize: exchange === "kalshi" ? "0.001" : "0.01",
    negRisk: false,
    tradeKey: `${exchange}:${price}:${size}`,
    orderPolicy: "gtc",
  };
}

test("Kalshi permits an eight-cent order when quantity and subpenny tick are valid", () => {
  const candidate = opportunity("kalshi", 0.002, 40);
  assert.equal(candidate.price * candidate.size, 0.08);
  assert.equal(validateOrderMinimum(candidate), null);
});

test("Kalshi rejects quantities below or off the 0.01-contract granularity", () => {
  assert.equal(
    validateOrderMinimum(opportunity("kalshi", 0.01, 0.009))?.reason,
    "below_min_order_size",
  );
  assert.equal(
    validateOrderMinimum(opportunity("kalshi", 0.01, 0.015))?.reason,
    "invalid_contract_increment",
  );
});

test("Kalshi validates the price step for the active tapered range", () => {
  assert.equal(
    validateOrderMinimum(opportunity("kalshi", 0.0025, 40))?.reason,
    "invalid_price_tick",
  );
  assert.equal(
    validateOrderMinimum(opportunity("kalshi", 0.15, 40)),
    null,
  );
});

test("Polymarket enforces book minimum shares and the marketable-buy dollar minimum", () => {
  const belowShares = opportunity("polymarket", 0.1, 4);
  belowShares.token.minOrderSize = 5;
  assert.equal(
    validateOrderMinimum(belowShares)?.reason,
    "below_min_order_size",
  );

  const belowDollar = opportunity("polymarket", 0.07, 9);
  assert.equal(
    validateOrderMinimum(belowDollar)?.reason,
    "below_marketable_buy_minimum",
  );
  assert.equal(
    validateOrderMinimum(opportunity("polymarket", 0.07, 15)),
    null,
  );
});
