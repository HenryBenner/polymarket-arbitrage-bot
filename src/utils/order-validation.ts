import type {
  ExchangeName,
  OrderResult,
  TradeOpportunity,
} from "../types.js";

const EPSILON = 1e-8;
const KALSHI_MIN_CONTRACTS = 0.01;
const KALSHI_CONTRACT_STEP = 0.01;
const POLYMARKET_MIN_MARKETABLE_BUY_USDC = 1;

export type OrderValidationFailure = {
  reason:
    | "invalid_price"
    | "invalid_size"
    | "below_min_order_size"
    | "invalid_contract_increment"
    | "invalid_price_tick"
    | "below_marketable_buy_minimum";
  details: Record<string, number | string>;
};

function exchangeFor(opportunity: TradeOpportunity): ExchangeName {
  return opportunity.event.market.exchange ?? "polymarket";
}

function alignedToStep(value: number, step: number): boolean {
  if (!Number.isFinite(step) || step <= 0) return false;
  return Math.abs(value / step - Math.round(value / step)) <= EPSILON;
}

function validPriceTick(opportunity: TradeOpportunity): boolean {
  const ranges = opportunity.event.market.orderPriceRanges ?? [];
  const matchingRanges = ranges.filter(
    (range) =>
      opportunity.price >= range.start - EPSILON &&
      opportunity.price <= range.end + EPSILON,
  );
  if (matchingRanges.length > 0) {
    return matchingRanges.some((range) =>
      alignedToStep(opportunity.price - range.start, range.step),
    );
  }

  return alignedToStep(opportunity.price, Number(opportunity.tickSize));
}

export function validateOrderMinimum(
  opportunity: TradeOpportunity,
): OrderValidationFailure | null {
  if (
    !Number.isFinite(opportunity.price) ||
    opportunity.price <= 0 ||
    opportunity.price >= 1
  ) {
    return {
      reason: "invalid_price",
      details: { price: opportunity.price },
    };
  }
  if (!Number.isFinite(opportunity.size) || opportunity.size <= 0) {
    return {
      reason: "invalid_size",
      details: { size: opportunity.size },
    };
  }
  if (!validPriceTick(opportunity)) {
    return {
      reason: "invalid_price_tick",
      details: {
        price: opportunity.price,
        tickSize: opportunity.tickSize,
      },
    };
  }

  const exchange = exchangeFor(opportunity);
  if (exchange === "kalshi") {
    if (opportunity.size + EPSILON < KALSHI_MIN_CONTRACTS) {
      return {
        reason: "below_min_order_size",
        details: {
          exchange,
          size: opportunity.size,
          minimumSize: KALSHI_MIN_CONTRACTS,
        },
      };
    }
    if (!alignedToStep(opportunity.size, KALSHI_CONTRACT_STEP)) {
      return {
        reason: "invalid_contract_increment",
        details: {
          exchange,
          size: opportunity.size,
          contractStep: KALSHI_CONTRACT_STEP,
        },
      };
    }
    return null;
  }

  const bookMinimum = Math.max(0, opportunity.token.minOrderSize);
  if (opportunity.size + EPSILON < bookMinimum) {
    return {
      reason: "below_min_order_size",
      details: {
        exchange,
        size: opportunity.size,
        minimumSize: bookMinimum,
      },
    };
  }

  const marketable =
    opportunity.orderPolicy === "fak" ||
    opportunity.orderPolicy === "fok" ||
    (opportunity.orderPolicy !== "post_only" &&
      opportunity.token.bestAsk !== null &&
      opportunity.price + EPSILON >= opportunity.token.bestAsk);
  const limitNotional = opportunity.price * opportunity.size;
  if (
    marketable &&
    limitNotional + EPSILON < POLYMARKET_MIN_MARKETABLE_BUY_USDC
  ) {
    return {
      reason: "below_marketable_buy_minimum",
      details: {
        exchange,
        limitNotional,
        minimumUsdc: POLYMARKET_MIN_MARKETABLE_BUY_USDC,
      },
    };
  }

  return null;
}

export function minimumOrderRejection(
  opportunity: TradeOpportunity,
  failure: OrderValidationFailure,
  dryRun: boolean,
): OrderResult {
  return {
    dryRun,
    accepted: false,
    tokenId: opportunity.token.tokenId,
    side: "BUY",
    price: opportunity.price,
    size: opportunity.size,
    response: {
      status: "rejected",
      reason: failure.reason,
      ...failure.details,
    },
  };
}
