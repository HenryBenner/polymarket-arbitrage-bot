import type { BotConfig } from "./config.js";
import type { TradeTracker } from "./trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";

export const STATIC_MAKER_LEVELS = [
  0.45,
  0.4,
  0.35,
  0.3,
  0.25,
  0.2,
  0.15,
  0.1,
  0.05,
] as const;

export const STATIC_MAKER_ENTRY_MINUTES_LEFT = 13;

export function projectedStaticMakerCapital(shares: number): number {
  return (
    shares *
    2 *
    STATIC_MAKER_LEVELS.reduce((sum, price) => sum + price, 0)
  );
}

export function findStaticMakerOpportunities(
  config: BotConfig,
  tracker: TradeTracker,
  event: UpDownEvent,
  books: TokenBook[],
  nowSeconds = Date.now() / 1000,
): TradeOpportunity[] {
  const minutesLeft = (event.windowEnd - nowSeconds) / 60;
  if (
    minutesLeft <= STATIC_MAKER_ENTRY_MINUTES_LEFT ||
    minutesLeft > 15
  ) {
    return [];
  }

  if (
    books.length !== 2 ||
    books.some(
      (book) =>
        book.bestAsk === null ||
        book.minOrderSize > config.staticMakerMaxShares,
    )
  ) {
    return [];
  }

  if (
    projectedStaticMakerCapital(config.staticMakerMaxShares) >
    config.staticMakerMaxUsdcPerMarket + 1e-9
  ) {
    return [];
  }

  const opportunities: TradeOpportunity[] = [];
  for (const price of STATIC_MAKER_LEVELS) {
    const passiveOnBoth = books.every(
      (book) => book.bestAsk !== null && price + 1e-9 < book.bestAsk,
    );
    if (!passiveOnBoth) continue;

    const pairId = `maker-${price.toFixed(2)}`;
    for (const token of books) {
      const tradeKey = tracker.makeKey(
        event.slug,
        token.outcome,
        "maker",
        price,
      );
      if (tracker.has(tradeKey)) continue;
      opportunities.push({
        kind: "maker",
        event,
        token,
        price,
        size: config.staticMakerMaxShares,
        tickSize: tickSizeFromMarket(event.market),
        negRisk: event.market.negRisk,
        tradeKey,
        strategyMode: "odahoa_static_maker",
        phaseId: "15-13",
        pairId,
      });
    }
  }

  return opportunities;
}
