import type { BotConfig } from "./config.js";
import {
  findLadderOpportunities,
  LadderTracker,
  projectedLadderCapital,
} from "./ladder.js";
import { log } from "./logger.js";
import { MarketScanner } from "./market-scanner.js";
import { findOpportunities } from "./strategy.js";
import { TradeTracker } from "./trade-tracker.js";
import type {
  OrderExecutor,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";
import { formatReturnPct } from "./utils/prices.js";
export class ReverseBot {
  private readonly scanner: MarketScanner;
  private readonly tracker = new TradeTracker();
  private readonly ladderTracker: LadderTracker;
  private ladderTickRunning = false;

  constructor(
    private readonly config: BotConfig,
    private readonly trader: OrderExecutor,
  ) {
    this.scanner = new MarketScanner(config);
    this.ladderTracker = new LadderTracker(config.paperStatePath);
  }

  async init(): Promise<void> {
    await this.trader.init();
    if (this.config.strategyMode === "odahoa_ladder") {
      await this.ladderTracker.init();
    }
  }

  async run(): Promise<void> {
    log("Reverse bot starting", {
      strategy:
        this.config.strategyMode === "reverse"
          ? "buy cheap reversal tokens on 15m BTC/ETH markets"
          : "odahoa_v1 timed complementary ladder approximation",
      strategyMode: this.config.strategyMode,
      executionMode: this.config.executionMode,
      cheapRange: `${this.config.cheapBuyMin}-${this.config.cheapBuyMax}`,
      expensiveHedge: this.config.enableExpensiveHedge
        ? `${this.config.expensiveBuyMin}-${this.config.expensiveBuyMax}`
        : "disabled",
      markets: this.config.marketSlugPrefixes,
      dryRun: this.config.dryRun,
      pollMs: this.config.pollIntervalMs,
    });

    await this.scheduledTick();
    setInterval(() => void this.scheduledTick(), this.config.pollIntervalMs);
  }

  private async scheduledTick(): Promise<void> {
    if (this.config.strategyMode === "reverse") {
      // Preserve the original reverse-mode scheduling and lifecycle exactly.
      await this.tick();
      return;
    }
    if (this.ladderTickRunning) {
      log("Ladder scan skipped because the previous scan is still running");
      return;
    }
    this.ladderTickRunning = true;
    try {
      await this.tick();
    } finally {
      this.ladderTickRunning = false;
    }
  }

  private async tick(): Promise<void> {
    try {
      const events = await this.scanner.scan();
      if (events.length === 0) {
        log("No active markets in window");
        return;
      }

      for (const event of events) {
        await this.processEvent(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Scan error", { error: message });
    }
  }

  private async processEvent(event: UpDownEvent): Promise<void> {
    const books = await this.scanner.getTokenBooks(event);
    await this.trader.observeMarket?.(event, books);

    if (
      this.config.strategyMode === "odahoa_ladder" &&
      this.config.executionMode === "live"
    ) {
      await this.enforceDynamicLadderCap(event, books);
      if (this.ladderTracker.isExposureBlocked(event.slug)) return;
    }

    const opportunities =
      this.config.strategyMode === "reverse"
        ? findOpportunities(this.config, this.tracker, event, books)
        : await findLadderOpportunities(
            this.config,
            this.ladderTracker,
            event,
            books,
          );

    if (opportunities.length === 0) {
      log("Watching market", {
        market: event.title,
        slug: event.slug,
        books: books.map((book) => ({
          outcome: book.outcome,
          bestAsk: book.bestAsk,
        })),
      });
      return;
    }

    for (const opportunity of opportunities) {
      await this.executeOpportunity(opportunity);
    }
    this.trader.reportMarket?.(event.slug);
  }

  private async executeOpportunity(opportunity: TradeOpportunity): Promise<void> {
    log("Placing limit order", {
      kind: opportunity.kind,
      market: opportunity.event.title,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      size: opportunity.size,
      potentialReturn: formatReturnPct(opportunity.price),
    });

    const result = await this.trader.placeBuy(opportunity);
    if (this.config.strategyMode === "reverse") {
      this.tracker.mark(opportunity.tradeKey);
    } else {
      await this.ladderTracker.mark(opportunity.tradeKey);
    }

    const resultLabel =
      this.config.executionMode === "paper"
        ? "Paper order submitted"
        : this.config.dryRun
          ? "Dry-run order"
          : "Live order placed";
    log(resultLabel, {
      tokenId: result.tokenId,
      price: result.price,
      size: result.size,
      response: result.response,
    });
  }

  private async enforceDynamicLadderCap(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    if (this.ladderTracker.isExposureBlocked(event.slug)) return;
    const withAsks = books.filter((book) => book.bestAsk !== null);
    if (withAsks.length !== 2) return;
    const ranked = [...withAsks].sort(
      (left, right) =>
        (left.bestAsk ?? 1) - (right.bestAsk ?? 1) ||
        left.outcomeIndex - right.outcomeIndex,
    );
    const cheap = ranked[0];
    const favorite = ranked[1];
    if (!cheap || !favorite) return;

    const minimums = new Map<number, number>();
    for (const price of [0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05]) {
      minimums.set(price, cheap.minOrderSize);
    }
    for (const price of [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
      minimums.set(price, favorite.minOrderSize);
    }
    const projected = projectedLadderCapital(
      this.config.ladderSizeScale,
      minimums,
    );
    if (projected <= this.config.ladderLiveMaxUsdcPerMarket + 1e-9) return;

    await this.ladderTracker.blockExposure(event.slug);
    log("Ladder market blocked by live exposure cap", {
      market: event.slug,
      projectedUsdc: projected,
      capUsdc: this.config.ladderLiveMaxUsdcPerMarket,
      reason: "live CLOB minimum size raised projected exposure",
    });
  }
}
