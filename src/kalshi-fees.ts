const EPSILON = 1e-10;

export interface KalshiFeeResult {
  tradeFee: number;
  roundingFee: number;
  rebate: number;
  netFee: number;
  accumulator: number;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function ceilTo(value: number, quantum: number): number {
  return round(Math.ceil((value - EPSILON) / quantum) * quantum);
}

/**
 * Mirrors Kalshi's V2 fee rounding for one fill. The accumulator belongs to
 * the order and must be carried across all of that order's fills.
 */
export function exactKalshiFee(input: {
  price: number;
  size: number;
  rate: number;
  exponent: number;
  side?: "BUY" | "SELL";
  accumulator?: number;
}): KalshiFeeResult {
  if (input.size <= 0) {
    return {
      tradeFee: 0,
      roundingFee: 0,
      rebate: 0,
      netFee: 0,
      accumulator: Math.max(0, input.accumulator ?? 0),
    };
  }
  const rawTradeFee =
    input.size * Math.max(0, input.rate) *
    Math.pow(input.price * (1 - input.price), input.exponent);
  const tradeFee = ceilTo(rawTradeFee, 0.0001);
  const revenue =
    (input.side ?? "BUY") === "SELL"
      ? input.price * input.size
      : -input.price * input.size;
  const balanceChange = revenue - tradeFee;
  const postedBalanceChange = Math.floor((balanceChange + EPSILON) * 100) / 100;
  const roundingFee = round(Math.max(0, balanceChange - postedBalanceChange));
  let accumulator = round(Math.max(0, input.accumulator ?? 0) + roundingFee);
  const rebate = round(Math.floor((accumulator + EPSILON) / 0.01) * 0.01);
  accumulator = round(Math.max(0, accumulator - rebate));
  return {
    tradeFee,
    roundingFee,
    rebate,
    netFee: round(tradeFee + roundingFee - rebate),
    accumulator,
  };
}

export function exactKalshiOrderFee(input: {
  price: number;
  size: number;
  rate: number;
  exponent: number;
  side?: "BUY" | "SELL";
}): number {
  return exactKalshiFee(input).netFee;
}

export function exactKalshiDepthCost(input: {
  levels: readonly { price: number; size: number }[];
  size: number;
  rate: number;
  exponent: number;
}): { total: number; limitPrice: number; fee: number } | null {
  let remaining = input.size;
  let total = 0;
  let feeTotal = 0;
  let accumulator = 0;
  let limitPrice = 0;
  for (const level of [...input.levels].sort((left, right) => left.price - right.price)) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, level.size);
    if (selected <= EPSILON) continue;
    const fee = exactKalshiFee({
      price: level.price,
      size: selected,
      rate: input.rate,
      exponent: input.exponent,
      accumulator,
    });
    accumulator = fee.accumulator;
    feeTotal += fee.netFee;
    total += level.price * selected + fee.netFee;
    limitPrice = level.price;
    remaining = round(remaining - selected);
  }
  return remaining <= EPSILON && limitPrice > 0
    ? { total: round(total), limitPrice, fee: round(feeTotal) }
    : null;
}

/** Executable FAK sell depth; shallow books return a partial quantity, not null. */
export function exactKalshiDepthProceeds(input: {
  levels: readonly { price: number; size: number }[];
  size: number;
  rate: number;
  exponent: number;
}): { total: number; averageNetPrice: number; limitPrice: number; fee: number; size: number } | null {
  let remaining = input.size;
  let total = 0;
  let feeTotal = 0;
  let accumulator = 0;
  let limitPrice = 0;
  for (const level of [...input.levels].sort((left, right) => right.price - left.price)) {
    if (remaining <= EPSILON) break;
    if (!Number.isFinite(level.price) || level.price <= 0 || level.price >= 1 || !Number.isFinite(level.size)) continue;
    const size = Math.min(remaining, Math.max(0, level.size));
    if (size <= EPSILON) continue;
    const fee = exactKalshiFee({ ...input, price: level.price, size, side: "SELL", accumulator });
    accumulator = fee.accumulator;
    total += size * level.price - fee.netFee;
    feeTotal += fee.netFee;
    limitPrice = level.price;
    remaining = round(remaining - size);
  }
  const size = round(input.size - remaining);
  return size > EPSILON && limitPrice > 0
    ? { total: round(total), averageNetPrice: round(total / size), limitPrice, fee: round(feeTotal), size }
    : null;
}
