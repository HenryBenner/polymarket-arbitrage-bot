import type { BotConfig } from "./config.js";
import type {
  GammaMarket,
  OrderBook,
  OrderBookLevel,
  RawOrderBookLevel,
  TokenBook,
  UpDownEvent,
} from "./types.js";
import {
  bestPrice,
  matchesSlugPrefixes,
  parseWindowStart,
  WINDOW_SECONDS,
} from "./utils/market.js";

function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}

function normalizeLevels(
  levels: RawOrderBookLevel[] | undefined,
  side: "bid" | "ask",
): OrderBookLevel[] {
  return (levels ?? [])
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size ?? "0"),
    }))
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        Number.isFinite(level.size) &&
        level.size >= 0,
    )
    .sort((a, b) =>
      side === "ask" ? a.price - b.price : b.price - a.price,
    );
}

export class MarketScanner {
  constructor(private readonly config: BotConfig) {}

  async scan(): Promise<UpDownEvent[]> {
    const url = new URL("/events", this.config.gammaApiHost);
    url.searchParams.set("tag_slug", "15M");
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "50");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Gamma events API error: ${response.status}`);
    }

    const events = (await response.json()) as Array<{
      title: string;
      slug: string;
      markets: GammaMarket[];
    }>;

    const now = Math.floor(Date.now() / 1000);
    const results: UpDownEvent[] = [];

    for (const event of events) {
      if (!matchesSlugPrefixes(event.slug, this.config.marketSlugPrefixes)) continue;

      const market = event.markets[0];
      if (!market || market.closed || market.active === false) continue;

      const windowStart = parseWindowStart(event.slug);
      if (!windowStart) continue;

      const windowEnd = windowStart + WINDOW_SECONDS;
      if (now < windowStart || now > windowEnd) continue;

      const minutesLeft = (windowEnd - now) / 60;
      if (
        minutesLeft < this.config.minutesBeforeCloseMin ||
        minutesLeft > this.config.minutesBeforeCloseMax
      ) {
        continue;
      }

      results.push({
        title: event.title,
        slug: event.slug,
        market,
        windowStart,
        windowEnd,
      });
    }

    return results;
  }

  async getTokenBooks(event: UpDownEvent): Promise<TokenBook[]> {
    const tokenIds = parseJsonArray<string>(event.market.clobTokenIds);
    const outcomes = parseJsonArray<string>(event.market.outcomes);

    const books = await Promise.all(
      tokenIds.map(async (tokenId, index): Promise<TokenBook | null> => {
        if (!tokenId) return null;

        const book = await fetchOrderBook(this.config.clobHost, tokenId);
        const bids = normalizeLevels(book.bids, "bid");
        const asks = normalizeLevels(book.asks, "ask");
        return {
          tokenId,
          outcome: outcomes[index] ?? `Outcome ${index}`,
          outcomeIndex: index,
          bestBid: bestPrice(book.bids, "bid"),
          bestAsk: bestPrice(book.asks, "ask"),
          bids,
          asks,
          minOrderSize: Number(book.min_order_size ?? "0") || 0,
          hash: book.hash,
          timestamp: book.timestamp,
        };
      }),
    );

    return books.filter((book): book is TokenBook => book !== null);
  }
}

async function fetchOrderBook(clobHost: string, tokenId: string): Promise<OrderBook> {
  const url = new URL("/book", clobHost);
  url.searchParams.set("token_id", tokenId);

  const response = await fetch(url);
  if (!response.ok) {
    return {};
  }

  return (await response.json()) as OrderBook;
}
