import {
  kalshiFeeRatesForSeries,
  type BotConfig,
} from "./config.js";
import {
  KalshiClient,
  kalshiTokenId,
  type KalshiMarket,
  type KalshiOrderbook,
} from "./kalshi-api.js";
import type {
  GammaMarket,
  OrderBook,
  OrderBookLevel,
  RawOrderBookLevel,
  TokenBook,
  UpDownEvent,
} from "./types.js";
import { log } from "./logger.js";
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
  private readonly kalshi: KalshiClient;

  constructor(private readonly config: BotConfig) {
    this.kalshi = new KalshiClient(config);
  }

  async scan(): Promise<UpDownEvent[]> {
    if (this.config.exchange === "kalshi") return this.scanKalshi();
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
    if (this.config.exchange === "kalshi") {
      const ticker = event.market.externalMarketId ?? event.market.id;
      if (!ticker) return [];
      return kalshiBooks(ticker, await this.kalshi.getOrderbook(ticker));
    }
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

  private async scanKalshi(): Promise<UpDownEvent[]> {
    const pages = await Promise.allSettled(
      this.config.kalshiSeriesTickers.map((series) =>
        this.kalshi
          .getMarkets(series)
          .then((markets) => ({ series, markets })),
      ),
    );
    const now = Date.now() / 1_000;
    const results: UpDownEvent[] = [];
    const seenMarketTickers = new Set<string>();
    for (const [index, page] of pages.entries()) {
      if (page.status === "rejected") {
        const message =
          page.reason instanceof Error
            ? page.reason.message
            : String(page.reason);
        log("Kalshi series scan failed", {
          series: this.config.kalshiSeriesTickers[index],
          error: message,
        });
        continue;
      }
      const { series, markets } = page.value;
      for (const market of markets) {
        if (seenMarketTickers.has(market.ticker)) continue;
        seenMarketTickers.add(market.ticker);
        if (market.status !== "active" && market.status !== "open") {
          continue;
        }
        const windowEnd = Date.parse(market.close_time) / 1_000;
        if (!Number.isFinite(windowEnd)) continue;
        const windowStart = windowEnd - WINDOW_SECONDS;
        if (now < windowStart || now > windowEnd) continue;
        const minutesLeft = (windowEnd - now) / 60;
        if (
          minutesLeft < this.config.minutesBeforeCloseMin ||
          minutesLeft > this.config.minutesBeforeCloseMax
        ) {
          continue;
        }
        const asset =
          series.match(/^KX([A-Z0-9]+)15M$/)?.[1]?.toLowerCase();
        if (!asset) continue;
        const slug = `${asset}-updown-15m-${Math.floor(windowStart)}`;
        results.push(
          kalshiEvent(
            market,
            series,
            slug,
            windowStart,
            windowEnd,
            this.config,
          ),
        );
      }
    }
    return results;
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

function kalshiEvent(
  market: KalshiMarket,
  seriesTicker: string,
  slug: string,
  windowStart: number,
  windowEnd: number,
  config: BotConfig,
): UpDownEvent {
  const fees = kalshiFeeRatesForSeries(config, seriesTicker);
  const tick = Math.min(
    ...((market.price_ranges ?? [])
      .map((range) => Number(range.step))
      .filter((step) => Number.isFinite(step) && step > 0)),
    0.01,
  );
  return {
    title: market.title || `Kalshi ${market.ticker}`,
    slug,
    windowStart,
    windowEnd,
    market: {
      exchange: "kalshi",
      externalMarketId: market.ticker,
      seriesTicker,
      id: market.ticker,
      question: market.title || market.ticker,
      conditionId: market.ticker,
      slug,
      clobTokenIds: JSON.stringify([
        kalshiTokenId(market.ticker, "yes"),
        kalshiTokenId(market.ticker, "no"),
      ]),
      outcomes: JSON.stringify(["Up", "Down"]),
      negRisk: false,
      orderPriceMinTickSize: tick,
      feesEnabled:
        fees.takerRate > 0 || fees.makerRate > 0,
      feeSchedule: {
        rate: fees.takerRate,
        makerRate: fees.makerRate,
        exponent: 1,
        rebateRate: 0,
      },
      active: market.status === "active" || market.status === "open",
      closed:
        market.status === "closed" ||
        market.status === "determined" ||
        market.status === "finalized" ||
        market.status === "settled",
    },
  };
}

export function kalshiBooks(
  ticker: string,
  response: KalshiOrderbook,
): TokenBook[] {
  const yesBids = normalizeKalshiLevels(response.orderbook_fp?.yes_dollars, false);
  const noBids = normalizeKalshiLevels(response.orderbook_fp?.no_dollars, false);
  const yesAsks = complementLevels(noBids);
  const noAsks = complementLevels(yesBids);
  return [
    {
      tokenId: kalshiTokenId(ticker, "yes"),
      outcome: "Up",
      outcomeIndex: 0,
      bestBid: yesBids[0]?.price ?? null,
      bestAsk: yesAsks[0]?.price ?? null,
      bids: yesBids,
      asks: yesAsks,
      minOrderSize: 1,
    },
    {
      tokenId: kalshiTokenId(ticker, "no"),
      outcome: "Down",
      outcomeIndex: 1,
      bestBid: noBids[0]?.price ?? null,
      bestAsk: noAsks[0]?.price ?? null,
      bids: noBids,
      asks: noAsks,
      minOrderSize: 1,
    },
  ];
}

function normalizeKalshiLevels(
  levels: Array<[string, string]> | undefined,
  ascending: boolean,
): OrderBookLevel[] {
  return (levels ?? [])
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        Number.isFinite(level.size) &&
        level.price > 0 &&
        level.price < 1 &&
        level.size > 0,
    )
    .sort((left, right) =>
      ascending ? left.price - right.price : right.price - left.price,
    );
}

function complementLevels(levels: OrderBookLevel[]): OrderBookLevel[] {
  return levels
    .map((level) => ({
      price: Number((1 - level.price).toFixed(4)),
      size: level.size,
    }))
    .sort((left, right) => left.price - right.price);
}
