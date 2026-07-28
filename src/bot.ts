import type { BotConfig } from "./config.js";
import {
  findLadderOpportunities,
  ladderPhases,
  LadderTracker,
  projectedLadderCapital,
} from "./ladder.js";
import { planLadderV5 } from "./ladder-v5.js";
import { planLadderV6 } from "./ladder-v6.js";
import { log } from "./logger.js";
import { MarketScanner } from "./market-scanner.js";
import {
  findPairLockOpeningOpportunities,
  planPairLockCompletions,
} from "./pair-lock.js";
import { findStaticMakerOpportunities } from "./static-maker.js";
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
  private readonly pairLockEvents = new Map<
    string,
    { event: UpDownEvent; books: TokenBook[] }
  >();
  private readonly ladderV6Events = new Map<
    string,
    { event: UpDownEvent; books: TokenBook[] }
  >();
  private readonly ladderV6Queues = new Map<string, Promise<void>>();
  private ladderTickRunning = false;

  constructor(
    private readonly config: BotConfig,
    private readonly trader: OrderExecutor,
  ) {
    this.scanner = new MarketScanner(config);
    this.ladderTracker = new LadderTracker(
      config.paperStatePath,
      config.strategyMode === "odahoa_ladder_2"
        ? `pair-lock-${config.executionMode}-ladder-state.json`
        : config.strategyMode === "ladder_v5"
          ? "ladder-v5-state.json"
          : config.strategyMode === "ladder_v6"
            ? "ladder-v6-state.json"
          : "ladder-state.json",
    );
    this.trader.setExecutionWakeHandler?.((marketSlug) =>
      this.enqueueLadderV6Market(marketSlug),
    );
  }

  async init(): Promise<void> {
    await this.trader.init();
    if (
      this.config.strategyMode === "odahoa_ladder" ||
      this.config.strategyMode === "odahoa_ladder_2" ||
      this.config.strategyMode === "ladder_v5" ||
      this.config.strategyMode === "ladder_v6"
    ) {
      await this.ladderTracker.init();
    }
  }

  async run(): Promise<void> {
    log("Reverse bot starting", {
      strategy:
        this.config.strategyMode === "reverse"
          ? "buy cheap reversal tokens on 15m BTC/ETH markets"
          : this.config.strategyMode === "odahoa_ladder"
            ? `${this.config.ladderPreset} timed complementary ladder approximation`
            : this.config.strategyMode === "odahoa_ladder_2"
              ? `${this.config.ladderPreset} post-only inventory pair lock`
              : this.config.strategyMode === "ladder_v5"
                ? "late 10/90 + 15/85 imbalance-capped ladder"
                : this.config.strategyMode === "ladder_v6"
                  ? "competitive paired makers with maker/FOK completion"
                  : "early two-sided static maker ladder",
      strategyMode: this.config.strategyMode,
      executionMode: this.config.executionMode,
      cheapRange: `${this.config.cheapBuyMin}-${this.config.cheapBuyMax}`,
      expensiveHedge: this.config.enableExpensiveHedge
        ? `${this.config.expensiveBuyMin}-${this.config.expensiveBuyMax}`
        : "disabled",
      markets: this.config.marketSlugPrefixes,
      dryRun: this.config.dryRun,
      pollMs: this.config.pollIntervalMs,
      ladderPreset:
        this.config.strategyMode === "odahoa_ladder" ||
        this.config.strategyMode === "odahoa_ladder_2"
          ? this.config.ladderPreset
          : undefined,
      ladderV5MaxImbalance:
        this.config.strategyMode === "ladder_v5"
          ? this.config.ladderV5MaxImbalance
          : undefined,
      ladderV5MaxPairCost:
        this.config.strategyMode === "ladder_v5"
          ? this.config.ladderV5MaxPairCost
          : undefined,
      ladderV6MaxUnmatchedShares:
        this.config.strategyMode === "ladder_v6"
          ? this.config.ladderV6MaxUnmatchedShares
          : undefined,
      ladderV6MinNetEdge:
        this.config.strategyMode === "ladder_v6"
          ? this.config.ladderV6MinNetEdge
          : undefined,
      ladderV6SafetyBuffer:
        this.config.strategyMode === "ladder_v6"
          ? this.config.ladderV6SafetyBuffer
          : undefined,
      ladderV6MaxRescueLoss:
        this.config.strategyMode === "ladder_v6"
          ? this.config.ladderV6MaxRescueLoss
          : undefined,
      staticMakerShares:
        this.config.strategyMode === "odahoa_static_maker"
          ? this.config.staticMakerMaxShares
          : undefined,
      staticMakerMaxUsdc:
        this.config.strategyMode === "odahoa_static_maker"
          ? this.config.staticMakerMaxUsdcPerMarket
          : undefined,
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
      await this.cleanupExpiredPairLockMarkets();
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
      (this.config.strategyMode === "odahoa_ladder" ||
        this.config.strategyMode === "odahoa_ladder_2") &&
      this.config.executionMode === "live"
    ) {
      await this.enforceDynamicLadderCap(event, books);
      if (this.ladderTracker.isExposureBlocked(event.slug)) return;
    }

    if (this.config.strategyMode === "odahoa_ladder_2") {
      this.pairLockEvents.set(event.slug, { event, books });
      await this.processPairLockEvent(event, books);
      return;
    }
    if (this.config.strategyMode === "ladder_v5") {
      await this.processLadderV5Event(event, books);
      return;
    }
    if (this.config.strategyMode === "ladder_v6") {
      this.ladderV6Events.set(event.slug, { event, books });
      await this.enqueueLadderV6Market(event.slug);
      return;
    }

    const opportunities =
      this.config.strategyMode === "reverse"
        ? findOpportunities(this.config, this.tracker, event, books)
        : this.config.strategyMode === "odahoa_static_maker"
          ? findStaticMakerOpportunities(
              this.config,
              this.tracker,
              event,
              books,
            )
          : await findLadderOpportunities(
              this.config,
              this.ladderTracker,
              event,
              books,
            );

    let submitted = 0;
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
      if (await this.executeOpportunity(opportunity)) submitted += 1;
    }

    if (submitted === 0) {
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
    this.trader.reportMarket?.(event.slug);
  }

  private async executeOpportunity(
    opportunity: TradeOpportunity,
  ): Promise<boolean> {
    log("Placing limit order", {
      kind: opportunity.kind,
      market: opportunity.event.title,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      size: opportunity.size,
      potentialReturn: formatReturnPct(opportunity.price),
    });

    const result = await this.trader.placeBuy(opportunity);
    if (result.accepted === false) {
      log("Order rejected", {
        tokenId: result.tokenId,
        price: result.price,
        size: result.size,
        response: result.response,
      });
      return false;
    }
    if (this.config.strategyMode === "odahoa_ladder_2") {
      if (opportunity.pairLockRole === "opening") {
        await this.ladderTracker.mark(opportunity.tradeKey);
      }
    } else if (
      this.config.strategyMode === "odahoa_ladder" ||
      this.config.strategyMode === "ladder_v5" ||
      this.config.strategyMode === "ladder_v6"
    ) {
      await this.ladderTracker.mark(opportunity.tradeKey);
    } else {
      this.tracker.mark(opportunity.tradeKey);
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
    return true;
  }

  private async processPairLockEvent(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    let submitted = 0;
    const snapshot = this.trader.getMarketExecutionSnapshot?.(event.slug);
    if (snapshot) {
      const plan = planPairLockCompletions(this.config, event, snapshot);
      if (plan.cancelOrderIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error(
            "Pair-lock strategy requires executor order cancellation",
          );
        }
        await this.trader.cancelOrders(plan.cancelOrderIds);
      }
      for (const opportunity of plan.opportunities) {
        if (await this.executeOpportunity(opportunity)) submitted += 1;
      }
    }

    const openings = await findPairLockOpeningOpportunities(
      this.config,
      this.ladderTracker,
      event,
      books,
    );
    for (const opportunity of openings) {
      if (await this.executeOpportunity(opportunity)) submitted += 1;
    }

    if (submitted === 0) {
      log("Watching pair-lock market", {
        market: event.title,
        slug: event.slug,
        books: books.map((book) => ({
          outcome: book.outcome,
          bestAsk: book.bestAsk,
        })),
      });
    }
    this.trader.reportMarket?.(event.slug);
  }

  private async processLadderV5Event(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    let submitted = 0;
    let cancelled = 0;
    let lastPlan:
      | Awaited<ReturnType<typeof planLadderV5>>
      | undefined;
    // Re-read the ledger after each order because a crossing GTC can fill
    // immediately and change both the imbalance and the allowable hedge cost.
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const snapshot = this.trader.getMarketExecutionSnapshot?.(event.slug);
      if (!snapshot) {
        throw new Error(
          "ladder_v5 requires a fill-aware executor snapshot",
        );
      }
      const plan = await planLadderV5(
        this.config,
        this.ladderTracker,
        event,
        books,
        snapshot,
      );
      lastPlan = plan;
      if (plan.cancelOrderIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error("ladder_v5 requires executor order cancellation");
        }
        await this.trader.cancelOrders(plan.cancelOrderIds);
        cancelled += plan.cancelOrderIds.length;
        continue;
      }
      const opportunity = plan.opportunities[0];
      if (!opportunity) break;
      if (await this.executeOpportunity(opportunity)) submitted += 1;
    }
    if (submitted === 0 && cancelled === 0) {
      log("Watching ladder_v5 market", {
        market: event.title,
        slug: event.slug,
        filledShares: lastPlan?.filledSharesByOutcome ?? {},
        filledImbalance: lastPlan?.filledImbalance ?? 0,
        imbalanceCap: this.config.ladderV5MaxImbalance,
      });
    }
    this.trader.reportMarket?.(event.slug);
  }

  private enqueueLadderV6Market(marketSlug: string): Promise<void> {
    if (this.config.strategyMode !== "ladder_v6") {
      return Promise.resolve();
    }
    const previous =
      this.ladderV6Queues.get(marketSlug) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const context = this.ladderV6Events.get(marketSlug);
        if (!context) return;
        await this.processLadderV6Event(context.event);
      });
    this.ladderV6Queues.set(marketSlug, queued);
    const cleanup = () => {
      if (this.ladderV6Queues.get(marketSlug) === queued) {
        this.ladderV6Queues.delete(marketSlug);
      }
    };
    void queued.then(cleanup, cleanup);
    return queued;
  }

  private async processLadderV6Event(
    event: UpDownEvent,
  ): Promise<void> {
    let submitted = 0;
    let cancelled = 0;
    let lastPlan:
      | Awaited<ReturnType<typeof planLadderV6>>
      | undefined;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const snapshot = this.trader.getMarketExecutionSnapshot?.(event.slug);
      if (!snapshot) {
        throw new Error(
          "ladder_v6 requires a fill-aware executor snapshot",
        );
      }
      const plan = await planLadderV6(
        this.config,
        this.ladderTracker,
        event,
        snapshot,
      );
      lastPlan = plan;
      if (plan.cancelOrderIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error("ladder_v6 requires executor order cancellation");
        }
        await this.trader.cancelOrders(plan.cancelOrderIds);
        cancelled += plan.cancelOrderIds.length;
        continue;
      }
      const opportunity = plan.opportunities[0];
      if (!opportunity) break;
      const accepted = await this.executeOpportunity(opportunity);
      if (!accepted) break;
      submitted += 1;
    }
    if (submitted === 0 && cancelled === 0) {
      log("Watching ladder_v6 market", {
        market: event.title,
        slug: event.slug,
        cheapFilledShares: lastPlan?.cheapFilledShares ?? 0,
        hedgedShares: lastPlan?.hedgedShares ?? 0,
        pairedShares: lastPlan?.pairedShares ?? 0,
        unmatchedCheapShares: lastPlan?.unmatchedCheapShares ?? 0,
        plannedOpeningBid: lastPlan?.plannedOpeningBid ?? null,
        observedHedgeAllInPerShare:
          lastPlan?.observedHedgeAllInPerShare ?? null,
        plannedAllInPairCost: lastPlan?.plannedAllInPairCost ?? null,
        plannedNetEdgePerPair: lastPlan?.plannedNetEdgePerPair ?? null,
      });
    }
    this.trader.reportMarket?.(event.slug);
  }

  private async cleanupExpiredPairLockMarkets(): Promise<void> {
    if (this.config.strategyMode !== "odahoa_ladder_2") return;
    const now = Date.now() / 1000;
    for (const [slug, context] of this.pairLockEvents) {
      if (now <= context.event.windowEnd) continue;
      await this.trader.observeMarket?.(context.event, context.books);
      const snapshot = this.trader.getMarketExecutionSnapshot?.(slug);
      const completionIds =
        snapshot?.openOrders
          .filter(
            (order) =>
              order.pairLockRole === "completion_maker" ||
              order.pairLockRole === "completion_taker",
          )
          .map((order) => order.id) ?? [];
      if (completionIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error(
            "Pair-lock strategy requires executor order cancellation",
          );
        }
        await this.trader.cancelOrders(completionIds);
      }
      this.pairLockEvents.delete(slug);
    }
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
    for (const phase of ladderPhases(this.config.ladderPreset)) {
      for (const rung of phase.rungs) {
        minimums.set(rung.lowPrice, cheap.minOrderSize);
        minimums.set(rung.highPrice, favorite.minOrderSize);
      }
    }
    const projected = projectedLadderCapital(
      this.config.ladderSizeScale,
      minimums,
      this.config.ladderPreset,
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
