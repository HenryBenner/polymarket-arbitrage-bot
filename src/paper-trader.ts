import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClobClient } from "@polymarket/clob-client-v2";
import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import { MarketStream, type MarketStreamEvent } from "./market-stream.js";
import type {
  GammaMarket,
  OrderBookLevel,
  OrderExecutor,
  OrderResult,
  PaperFill,
  PaperOrder,
  PaperPosition,
  PaperSettlement,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";

interface PaperState {
  version: 1;
  startingBalance: number;
  cash: number;
  orders: PaperOrder[];
  fills: PaperFill[];
  positions: PaperPosition[];
  settlements: PaperSettlement[];
  seenEventKeys: string[];
}

interface MarketContext {
  event: UpDownEvent;
  books: Map<string, TokenBook>;
  liquidity: Map<string, OrderBookLevel[]>;
}

interface PriceChange {
  asset_id?: string;
  price?: string;
  size?: string;
  side?: string;
}

interface PaperTraderOptions {
  stream?: Pick<MarketStream, "subscribe" | "close">;
  feeLoader?: (
    conditionId: string,
  ) => Promise<{ rate: number; exponent: number }>;
  settlementLoader?: (
    event: UpDownEvent,
  ) => Promise<{ winningTokenId: string } | null>;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLevels(value: unknown, ascending: boolean): OrderBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((level) => {
      if (!level || typeof level !== "object") return null;
      const price = parseNumber((level as Record<string, unknown>).price);
      const size = parseNumber((level as Record<string, unknown>).size);
      return price === null || size === null ? null : { price, size };
    })
    .filter((level): level is OrderBookLevel => level !== null && level.size > 0)
    .sort((left, right) =>
      ascending ? left.price - right.price : right.price - left.price,
    );
}

function emptyState(startingBalance: number): PaperState {
  return {
    version: 1,
    startingBalance,
    cash: startingBalance,
    orders: [],
    fills: [],
    positions: [],
    settlements: [],
    seenEventKeys: [],
  };
}

export class PaperTrader implements OrderExecutor {
  private state: PaperState;
  private readonly statePath: string;
  private readonly eventLogPath: string;
  private readonly stream: Pick<MarketStream, "subscribe" | "close">;
  private readonly publicClient: ClobClient;
  private readonly contexts = new Map<string, MarketContext>();
  private readonly tokenToMarket = new Map<string, string>();
  private readonly fallbackChecks = new Map<string, number>();
  private readonly settlementTimers = new Map<string, NodeJS.Timeout>();
  private readonly seenEvents = new Set<string>();
  private readonly feeConfigs = new Map<
    string,
    { rate: number; exponent: number }
  >();
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: BotConfig,
    private readonly options: PaperTraderOptions = {},
  ) {
    this.state = emptyState(config.paperStartingUsdc);
    this.statePath = join(config.paperStatePath, "paper-state.json");
    this.eventLogPath = join(config.paperStatePath, "paper-events.jsonl");
    this.stream =
      options.stream ??
      new MarketStream((event) => this.ingestMarketEvent(event));
    this.publicClient = new ClobClient({
      host: config.clobHost,
      chain: config.chainId,
    });
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as PaperState;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported paper state version: ${parsed.version}`);
      }
      this.state = parsed;
      this.state.positions ??= this.derivePositions(parsed.fills);
      for (const key of parsed.seenEventKeys) this.seenEvents.add(key);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") throw error;
      await this.persist();
    }

    log("Paper account loaded", {
      startingUsdc: this.state.startingBalance,
      cashUsdc: round(this.state.cash, 4),
      openOrders: this.state.orders.filter((order) => order.status !== "filled")
        .length,
      fills: this.state.fills.length,
    });
  }

  async observeMarket(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    const context: MarketContext = {
      event,
      books: new Map(books.map((book) => [book.tokenId, book])),
      liquidity: new Map(
        books.map((book) => [
          book.tokenId,
          book.asks.map((level) => ({ ...level })),
        ]),
      ),
    };
    this.contexts.set(event.slug, context);
    for (const book of books) this.tokenToMarket.set(book.tokenId, event.slug);
    this.stream.subscribe(books.map((book) => book.tokenId));
    await this.loadFeeConfig(event);
    this.scheduleSettlementFallback(event);

    if (Date.now() / 1000 >= event.windowEnd) {
      await this.checkGammaSettlement(event);
    }
  }

  async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
    const existing = this.state.orders.find(
      (order) => order.tradeKey === opportunity.tradeKey,
    );
    if (existing) {
      return {
        dryRun: true,
        tokenId: existing.tokenId,
        side: "BUY",
        price: existing.limitPrice,
        size: existing.originalSize,
        response: { paper: true, duplicate: true, orderId: existing.id },
      };
    }

    const reserveNeeded = opportunity.price * opportunity.size;
    const available = this.availableCash();
    if (reserveNeeded > available + 1e-8) {
      throw new Error(
        `Paper balance too low: $${available.toFixed(2)} available, ` +
          `$${reserveNeeded.toFixed(2)} required`,
      );
    }

    const context = this.contexts.get(opportunity.event.slug);
    const queueAhead = (context?.books.get(opportunity.token.tokenId)?.bids ?? [])
      .filter((level) => Math.abs(level.price - opportunity.price) < 1e-9)
      .reduce((sum, level) => sum + level.size, 0);
    const now = new Date().toISOString();
    const order: PaperOrder = {
      id: `paper-${Date.now()}-${this.state.orders.length + 1}`,
      tradeKey: opportunity.tradeKey,
      marketSlug: opportunity.event.slug,
      marketTitle: opportunity.event.title,
      conditionId: opportunity.event.market.conditionId,
      tokenId: opportunity.token.tokenId,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      originalSize: opportunity.size,
      remainingSize: opportunity.size,
      queueAhead,
      status: "open",
      phaseId: opportunity.phaseId,
      pairId: opportunity.pairId,
      createdAt: now,
      submittedMinutesLeft:
        (opportunity.event.windowEnd - Date.now() / 1000) / 60,
    };
    this.state.orders.push(order);
    await this.record("order_submitted", order);

    const asks =
      context?.liquidity.get(opportunity.token.tokenId) ??
      opportunity.token.asks.map((level) => ({ ...level }));
    for (const level of asks) {
      if (order.remainingSize <= 1e-8 || level.price > order.limitPrice + 1e-9) {
        break;
      }
      const fillSize = Math.min(order.remainingSize, level.size);
      if (fillSize <= 1e-8) continue;
      await this.applyFill(
        order,
        level.price,
        fillSize,
        "taker",
        this.takerFeeRate(opportunity.event.market),
        now,
      );
      level.size = round(level.size - fillSize);
    }
    if (context) context.liquidity.set(order.tokenId, asks);
    await this.persist();
    this.reportMarket(order.marketSlug);

    return {
      dryRun: true,
      tokenId: order.tokenId,
      side: "BUY",
      price: order.limitPrice,
      size: order.originalSize,
      response: {
        paper: true,
        orderId: order.id,
        status: order.status,
        filledSize: round(order.originalSize - order.remainingSize),
        queueAhead: round(order.queueAhead),
      },
    };
  }

  reportMarket(marketSlug: string): void {
    const orders = this.state.orders.filter(
      (order) => order.marketSlug === marketSlug,
    );
    if (orders.length === 0) return;
    const fills = this.state.fills.filter(
      (fill) => fill.marketSlug === marketSlug,
    );
    const outcomeTotals = new Map<
      string,
      { shares: number; cost: number; fees: number }
    >();
    for (const fill of fills) {
      const aggregate = outcomeTotals.get(fill.outcome) ?? {
        shares: 0,
        cost: 0,
        fees: 0,
      };
      aggregate.shares += fill.size;
      aggregate.cost += fill.size * fill.price;
      aggregate.fees += fill.fee;
      outcomeTotals.set(fill.outcome, aggregate);
    }

    const shares = [...outcomeTotals.values()].map((value) => value.shares);
    const guaranteedPayout = shares.length >= 2 ? Math.min(...shares) : 0;
    const maximumPayout = shares.length > 0 ? Math.max(...shares) : 0;
    const used = [...outcomeTotals.values()].reduce(
      (sum, value) => sum + value.cost + value.fees,
      0,
    );
    const committed = orders.reduce(
      (sum, order) => sum + order.limitPrice * order.originalSize,
      0,
    );

    log("Paper cycle status", {
      market: marketSlug,
      ordersSubmitted: orders.length,
      filled: orders.filter((order) => order.status === "filled").length,
      partial: orders.filter((order) => order.status === "partial").length,
      unfilled: orders.filter((order) => order.status === "open").length,
      capitalCommitted: round(committed, 4),
      capitalUsed: round(used, 4),
      byOutcome: [...outcomeTotals.entries()].map(([outcome, value]) => ({
        outcome,
        shares: round(value.shares, 4),
        averagePrice:
          value.shares > 0 ? round(value.cost / value.shares, 4) : null,
      })),
      guaranteedPayout: round(guaranteedPayout, 4),
      outcomeDependentPayout: round(maximumPayout - guaranteedPayout, 4),
      fees: round(
        fills.reduce((sum, fill) => sum + fill.fee, 0),
        6,
      ),
      settledPnl:
        this.state.settlements.find(
          (settlement) => settlement.marketSlug === marketSlug,
        )?.realizedPnl ?? null,
      profileComparison: {
        presetPriceLevels: "odahoa_v1 public-fill approximation",
        firstVisibleFillMinutesLeft:
          fills.length > 0
            ? round(
                orders.find((order) => order.id === fills[0]?.orderId)
                  ?.submittedMinutesLeft ?? 0,
                2,
              )
            : null,
      },
    });
  }

  async close(): Promise<void> {
    this.stream.close();
    for (const timer of this.settlementTimers.values()) clearTimeout(timer);
    this.settlementTimers.clear();
    await this.persistenceQueue;
  }

  snapshot(): Readonly<PaperState> {
    return structuredClone(this.state);
  }

  async ingestMarketEvent(event: MarketStreamEvent): Promise<void> {
    await this.handleStreamEvent(event);
  }

  private availableCash(): number {
    const reserved = this.state.orders
      .filter((order) => order.status === "open" || order.status === "partial")
      .reduce(
        (sum, order) => sum + order.remainingSize * order.limitPrice,
        0,
      );
    return round(this.state.cash - reserved);
  }

  private takerFeeRate(market: GammaMarket): {
    rate: number;
    exponent: number;
  } {
    const cached = this.feeConfigs.get(market.conditionId);
    if (cached) return cached;
    const rawRate = market.feeSchedule?.rate ?? 0;
    return {
      rate: rawRate > 1 ? rawRate / 10_000 : rawRate,
      exponent: market.feeSchedule?.exponent ?? 1,
    };
  }

  private async applyFill(
    order: PaperOrder,
    price: number,
    size: number,
    liquidity: "taker" | "maker",
    feeConfig: { rate: number; exponent: number },
    timestamp: string,
  ): Promise<void> {
    const actualSize = round(Math.min(size, order.remainingSize));
    if (actualSize <= 0) return;
    const fee =
      liquidity === "taker"
        ? round(
            actualSize *
              feeConfig.rate *
              Math.pow(price * (1 - price), feeConfig.exponent),
            5,
          )
        : 0;
    const cost = round(actualSize * price);
    if (cost + fee > this.state.cash + 1e-8) return;

    const fill: PaperFill = {
      id: `fill-${Date.now()}-${this.state.fills.length + 1}`,
      orderId: order.id,
      marketSlug: order.marketSlug,
      tokenId: order.tokenId,
      outcome: order.outcome,
      price,
      size: actualSize,
      fee,
      liquidity,
      timestamp,
    };
    this.state.fills.push(fill);
    const position = this.state.positions.find(
      (item) =>
        item.marketSlug === order.marketSlug && item.tokenId === order.tokenId,
    );
    if (position) {
      position.shares = round(position.shares + actualSize);
      position.totalCost = round(position.totalCost + cost);
    } else {
      this.state.positions.push({
        marketSlug: order.marketSlug,
        tokenId: order.tokenId,
        outcome: order.outcome,
        shares: actualSize,
        totalCost: cost,
      });
    }
    this.state.cash = round(this.state.cash - cost - fee);
    order.remainingSize = round(order.remainingSize - actualSize);
    order.status =
      order.remainingSize <= 1e-8
        ? "filled"
        : order.remainingSize < order.originalSize
          ? "partial"
          : "open";
    await this.record("fill", fill);
  }

  private async handleStreamEvent(event: MarketStreamEvent): Promise<void> {
    const eventType = String(event.event_type ?? "");
    if (eventType === "book") {
      this.handleBookEvent(event);
      return;
    }
    if (eventType === "price_change") {
      this.handlePriceChanges(event);
      return;
    }
    if (eventType === "last_trade_price") {
      await this.handleTradeEvent(event);
      return;
    }
    if (eventType === "market_resolved") {
      const winningTokenId = String(
        event.winning_asset_id ?? event.asset_id ?? "",
      );
      if (winningTokenId) await this.settleWinningToken(winningTokenId);
    }
  }

  private handleBookEvent(event: MarketStreamEvent): void {
    const tokenId = String(event.asset_id ?? "");
    const marketSlug = this.tokenToMarket.get(tokenId);
    const context = marketSlug ? this.contexts.get(marketSlug) : undefined;
    if (!context) return;
    const asks = parseLevels(event.asks, true);
    const bids = parseLevels(event.bids, false);
    const previous = context.books.get(tokenId);
    if (previous) {
      previous.asks = asks;
      previous.bids = bids;
      previous.bestAsk = asks[0]?.price ?? null;
      previous.bestBid = bids[0]?.price ?? null;
    }
    context.liquidity.set(tokenId, asks.map((level) => ({ ...level })));
  }

  private handlePriceChanges(event: MarketStreamEvent): void {
    const changes = Array.isArray(event.price_changes)
      ? (event.price_changes as PriceChange[])
      : [];
    for (const change of changes) {
      const tokenId = String(change.asset_id ?? event.asset_id ?? "");
      const marketSlug = this.tokenToMarket.get(tokenId);
      const context = marketSlug ? this.contexts.get(marketSlug) : undefined;
      if (!context) continue;
      const price = parseNumber(change.price);
      const size = parseNumber(change.size);
      if (price === null || size === null) continue;
      const side = String(change.side ?? "").toUpperCase();
      const book = context.books.get(tokenId);
      if (!book) continue;
      const levels = side === "BUY" ? book.bids : book.asks;
      const index = levels.findIndex(
        (level) => Math.abs(level.price - price) < 1e-9,
      );
      if (size <= 0 && index >= 0) levels.splice(index, 1);
      else if (index >= 0) levels[index] = { price, size };
      else if (size > 0) levels.push({ price, size });
      levels.sort((left, right) =>
        side === "BUY"
          ? right.price - left.price
          : left.price - right.price,
      );
      book.bestBid = book.bids[0]?.price ?? null;
      book.bestAsk = book.asks[0]?.price ?? null;
      if (side !== "BUY") {
        context.liquidity.set(
          tokenId,
          book.asks.map((level) => ({ ...level })),
        );
      }
    }
  }

  private async handleTradeEvent(event: MarketStreamEvent): Promise<void> {
    const tokenId = String(event.asset_id ?? "");
    const side = String(event.side ?? "").toUpperCase();
    const price = parseNumber(event.price);
    const size = parseNumber(event.size);
    if (!tokenId || side !== "SELL" || price === null || size === null) return;

    const eventKey = [
      tokenId,
      event.timestamp ?? "",
      price,
      size,
      side,
      event.transaction_hash ?? "",
    ].join(":");
    if (this.seenEvents.has(eventKey)) return;
    this.seenEvents.add(eventKey);
    if (this.seenEvents.size > 2_000) {
      const oldest = this.seenEvents.values().next().value as string | undefined;
      if (oldest) this.seenEvents.delete(oldest);
    }
    this.state.seenEventKeys = [...this.seenEvents];

    let remainingTradeSize = size;
    const orders = this.state.orders
      .filter(
        (order) =>
          order.tokenId === tokenId &&
          (order.status === "open" || order.status === "partial") &&
          order.limitPrice + 1e-9 >= price,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const order of orders) {
      if (remainingTradeSize <= 1e-8) break;
      const queueConsumed = Math.min(order.queueAhead, remainingTradeSize);
      order.queueAhead = round(order.queueAhead - queueConsumed);
      remainingTradeSize = round(remainingTradeSize - queueConsumed);
      if (remainingTradeSize <= 1e-8) continue;
      const fillSize = Math.min(order.remainingSize, remainingTradeSize);
      await this.applyFill(
        order,
        price,
        fillSize,
        "maker",
        { rate: 0, exponent: 1 },
        String(event.timestamp ?? new Date().toISOString()),
      );
      remainingTradeSize = round(remainingTradeSize - fillSize);
    }
    await this.persist();
    const marketSlug = this.tokenToMarket.get(tokenId);
    if (marketSlug) this.reportMarket(marketSlug);
  }

  private async checkGammaSettlement(event: UpDownEvent): Promise<void> {
    if (
      this.state.settlements.some(
        (settlement) => settlement.marketSlug === event.slug,
      )
    ) {
      return;
    }
    const lastCheck = this.fallbackChecks.get(event.slug) ?? 0;
    if (Date.now() - lastCheck < 30_000 || !event.market.id) return;
    this.fallbackChecks.set(event.slug, Date.now());

    try {
      if (this.options.settlementLoader) {
        const result = await this.options.settlementLoader(event);
        if (result) await this.settleWinningToken(result.winningTokenId);
        return;
      }
      const url = new URL(
        `/markets/${encodeURIComponent(event.market.id)}`,
        this.config.gammaApiHost,
      );
      const response = await fetch(url);
      if (!response.ok) return;
      const market = (await response.json()) as GammaMarket;
      if (!market.closed || !market.outcomePrices) return;
      const prices = JSON.parse(market.outcomePrices) as string[];
      const tokenIds = JSON.parse(market.clobTokenIds) as string[];
      const winningIndex = prices.findIndex((price) => Number(price) >= 0.999);
      const winningTokenId = tokenIds[winningIndex];
      if (winningTokenId) await this.settleWinningToken(winningTokenId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Gamma paper settlement check failed", {
        market: event.slug,
        error: message,
      });
    }
  }

  private scheduleSettlementFallback(event: UpDownEvent): void {
    if (
      this.settlementTimers.has(event.slug) ||
      this.state.settlements.some(
        (settlement) => settlement.marketSlug === event.slug,
      )
    ) {
      return;
    }
    const firstDelay = Math.max(0, event.windowEnd * 1000 - Date.now() + 2_000);
    const schedule = (delay: number): void => {
      const timer = setTimeout(() => {
        void this.checkGammaSettlement(event).finally(() => {
          if (
            !this.state.settlements.some(
              (settlement) => settlement.marketSlug === event.slug,
            )
          ) {
            schedule(30_000);
          } else {
            this.settlementTimers.delete(event.slug);
          }
        });
      }, Math.min(delay, 2_147_483_647));
      this.settlementTimers.set(event.slug, timer);
    };
    schedule(firstDelay);
  }

  private async loadFeeConfig(event: UpDownEvent): Promise<void> {
    if (this.feeConfigs.has(event.market.conditionId)) return;
    try {
      if (this.options.feeLoader) {
        this.feeConfigs.set(
          event.market.conditionId,
          await this.options.feeLoader(event.market.conditionId),
        );
        return;
      }
      const details = await this.publicClient.getClobMarketInfo(
        event.market.conditionId,
      );
      const rawRate = details.fd?.r ?? 0;
      this.feeConfigs.set(event.market.conditionId, {
        rate: rawRate > 1 ? rawRate / 10_000 : rawRate,
        exponent: details.fd?.e ?? 1,
      });
    } catch (error) {
      const fallback = event.slug.startsWith("btc-updown-15m") ? 0.07 : 0;
      this.feeConfigs.set(event.market.conditionId, {
        rate: fallback,
        exponent: 1,
      });
      const message = error instanceof Error ? error.message : String(error);
      log("Paper fee lookup failed; using category fallback", {
        market: event.slug,
        fallbackRate: fallback,
        error: message,
      });
    }
  }

  private async settleWinningToken(winningTokenId: string): Promise<void> {
    const marketSlug = this.tokenToMarket.get(winningTokenId);
    if (!marketSlug) return;
    if (
      this.state.settlements.some(
        (settlement) => settlement.marketSlug === marketSlug,
      )
    ) {
      return;
    }
    const marketFills = this.state.fills.filter(
      (fill) => fill.marketSlug === marketSlug,
    );
    const winningFills = marketFills.filter(
      (fill) => fill.tokenId === winningTokenId,
    );
    const payout = round(
      winningFills.reduce((sum, fill) => sum + fill.size, 0),
    );
    const totalCost = round(
      marketFills.reduce((sum, fill) => sum + fill.price * fill.size, 0),
    );
    const totalFees = round(
      marketFills.reduce((sum, fill) => sum + fill.fee, 0),
    );
    const winningOutcome =
      winningFills[0]?.outcome ??
      this.contexts
        .get(marketSlug)
        ?.books.get(winningTokenId)?.outcome ??
      "Unknown";
    const settlement: PaperSettlement = {
      marketSlug,
      winningTokenId,
      winningOutcome,
      payout,
      totalCost,
      totalFees,
      realizedPnl: round(payout - totalCost - totalFees),
      settledAt: new Date().toISOString(),
    };
    this.state.settlements.push(settlement);
    this.state.cash = round(this.state.cash + payout);
    for (const order of this.state.orders) {
      if (
        order.marketSlug === marketSlug &&
        (order.status === "open" || order.status === "partial")
      ) {
        order.status = "cancelled";
      }
    }
    await this.record("settlement", settlement);
    await this.persist();
    this.reportMarket(marketSlug);
  }

  private async record(
    type: string,
    payload: PaperOrder | PaperFill | PaperSettlement,
  ): Promise<void> {
    await mkdir(dirname(this.eventLogPath), { recursive: true });
    await appendFile(
      this.eventLogPath,
      `${JSON.stringify({ type, timestamp: new Date().toISOString(), payload })}\n`,
      "utf8",
    );
  }

  private derivePositions(fills: PaperFill[]): PaperPosition[] {
    const positions = new Map<string, PaperPosition>();
    for (const fill of fills) {
      const key = `${fill.marketSlug}:${fill.tokenId}`;
      const position = positions.get(key) ?? {
        marketSlug: fill.marketSlug,
        tokenId: fill.tokenId,
        outcome: fill.outcome,
        shares: 0,
        totalCost: 0,
      };
      position.shares = round(position.shares + fill.size);
      position.totalCost = round(position.totalCost + fill.price * fill.size);
      positions.set(key, position);
    }
    return [...positions.values()];
  }

  private async persist(): Promise<void> {
    this.persistenceQueue = this.persistenceQueue.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      const serialized = JSON.stringify(this.state, null, 2);
      await writeFile(temporaryPath, serialized, "utf8");
      try {
        await rename(temporaryPath, this.statePath);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await writeFile(this.statePath, serialized, "utf8");
        await rm(temporaryPath, { force: true });
      }
    });
    await this.persistenceQueue;
  }
}
