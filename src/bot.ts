import type { BotConfig } from "./config.js";
import {
  findLadderOpportunities,
  ladderPhases,
  LadderTracker,
  projectedLadderCapital,
} from "./ladder.js";
import { planLadderV5 } from "./ladder-v5.js";
import { planLadderV55 } from "./ladder-v5-5.js";
import { planLadderV6 } from "./ladder-v6.js";
import { planLadderV7 } from "./ladder-v7.js";
import { planLadderV8 } from "./ladder-v8.js";
import { planLadderV9 } from "./ladder-v9.js";
import { planLadderV10 } from "./ladder-v10.js";
import { LadderV10RegimeEngine } from "./ladder-v10-regime.js";
import { log, logThrottled } from "./logger.js";
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

export interface MarketSource {
  scan(): Promise<UpDownEvent[]>;
  getTokenBooks(event: UpDownEvent): Promise<TokenBook[]>;
}

export class ReverseBot {
  private readonly scanner: MarketSource;
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
  private readonly ladderV8Events = new Map<string, UpDownEvent>();
  private readonly ladderV7Events = new Map<string, UpDownEvent>();
  private readonly ladderV9Events = new Map<string, UpDownEvent>();
  private readonly ladderV10Events = new Map<string, UpDownEvent>();
  private readonly ladderV55Events = new Map<string, UpDownEvent>();
  private readonly ladderV55Queues = new Map<string, Promise<void>>();
  private readonly ladderV6Queues = new Map<string, Promise<void>>();
  private readonly ladderV8Queues = new Map<string, Promise<void>>();
  private readonly ladderV7Queues = new Map<string, Promise<void>>();
  private readonly ladderV9Queues = new Map<string, Promise<void>>();
  private readonly ladderV10Queues = new Map<string, Promise<void>>();
  private readonly ladderV10WakePending = new Set<string>();
  private readonly marketQueues = new Map<string, Promise<void>>();
  private ladderTickRunning = false;
  private readonly ladderV10Regime: LadderV10RegimeEngine | null;
  private ladderV10SampleTimer: NodeJS.Timeout | null = null;
  private ladderV10SampleRunning = false;

  constructor(
    private readonly config: BotConfig,
    private readonly trader: OrderExecutor,
    scanner?: MarketSource,
  ) {
    this.scanner = scanner ?? new MarketScanner(config);
    this.ladderV10Regime =
      config.strategyMode === "ladder_v10"
        ? new LadderV10RegimeEngine(config)
        : null;
    this.ladderTracker = new LadderTracker(
      config.paperStatePath,
      config.strategyMode === "odahoa_ladder_2"
        ? `pair-lock-${config.executionMode}-ladder-state.json`
        : config.strategyMode === "ladder_v5"
          ? "ladder-v5-state.json"
          : config.strategyMode === "ladder_v5.5"
            ? "ladder-v5-5-state.json"
            : config.strategyMode === "ladder_v6"
              ? "ladder-v6-state.json"
              : config.strategyMode === "ladder_v7"
                ? "ladder-v7-state.json"
                : config.strategyMode === "ladder_v8"
                  ? "ladder-v8-state.json"
                  : config.strategyMode === "ladder_v9"
                    ? "ladder-v9-state.json"
                    : config.strategyMode === "ladder_v10"
                      ? "ladder-v10-state.json"
                    : "ladder-state.json",
    );
    this.trader.setExecutionWakeHandler?.((marketSlug) =>
      this.config.strategyMode === "ladder_v5.5"
        ? this.enqueueLadderV55Market(marketSlug)
        : this.config.strategyMode === "ladder_v6"
          ? this.enqueueLadderV6Market(marketSlug)
          : this.config.strategyMode === "ladder_v7"
            ? this.enqueueLadderV7Market(marketSlug)
            : this.config.strategyMode === "ladder_v9"
              ? this.enqueueLadderV9Market(marketSlug)
              : this.config.strategyMode === "ladder_v10"
                ? this.enqueueLadderV10Market(marketSlug)
              : this.enqueueLadderV8Market(marketSlug),
    );
    if (this.ladderV10Regime) {
      this.trader.setMarketTelemetryHandler?.((event) =>
        this.ladderV10Regime?.ingestTelemetry(event),
      );
      this.trader.setSettlementHandler?.(async (settlement) => {
        await this.ladderV10Regime?.handleSettlement(settlement);
        this.ladderV10Events.delete(settlement.marketSlug);
        this.ladderV10WakePending.delete(settlement.marketSlug);
      });
    }
  }

  async init(): Promise<void> {
    await this.trader.init();
    if (
      this.config.strategyMode === "odahoa_ladder" ||
      this.config.strategyMode === "odahoa_ladder_2" ||
      this.config.strategyMode === "ladder_v5" ||
      this.config.strategyMode === "ladder_v5.5" ||
      this.config.strategyMode === "ladder_v6" ||
      this.config.strategyMode === "ladder_v7" ||
      this.config.strategyMode === "ladder_v8" ||
      this.config.strategyMode === "ladder_v9" ||
      this.config.strategyMode === "ladder_v10"
    ) {
      await this.ladderTracker.init();
    }
    await this.ladderV10Regime?.init();
  }

  async run(): Promise<void> {
    log("Reverse bot starting", {
      exchange: this.config.exchange,
      strategy:
        this.config.strategyMode === "reverse"
          ? "buy cheap reversal tokens on 15m BTC/ETH markets"
          : this.config.strategyMode === "odahoa_ladder"
            ? `${this.config.ladderPreset} timed complementary ladder approximation`
            : this.config.strategyMode === "odahoa_ladder_2"
              ? `${this.config.ladderPreset} post-only inventory pair lock`
              : this.config.strategyMode === "ladder_v5"
                ? "late 10/90 + 15/85 imbalance-capped ladder"
                : this.config.strategyMode === "ladder_v5.5"
                  ? "phased dynamic cheap entries with confirmed-fill FOK hedges"
                : this.config.strategyMode === "ladder_v6"
                  ? "competitive paired makers with maker/FOK completion"
                : this.config.strategyMode === "ladder_v7"
                  ? "fixed cheap maker plus capped one-shot favorite taker"
                  : this.config.strategyMode === "ladder_v8"
                    ? "Odahoa-sized all-phase complementary post-only maker ladder"
                    : this.config.strategyMode === "ladder_v9"
                      ? "staged cheap-first entry with fill-aware completion and rescue"
                      : this.config.strategyMode === "ladder_v10"
                        ? "regime-gated V7 with strict cheap-fill completion"
                      : "early two-sided static maker ladder",
      strategyMode: this.config.strategyMode,
      executionMode: this.config.executionMode,
      cheapRange: `${this.config.cheapBuyMin}-${this.config.cheapBuyMax}`,
      expensiveHedge: this.config.enableExpensiveHedge
        ? `${this.config.expensiveBuyMin}-${this.config.expensiveBuyMax}`
        : "disabled",
      markets:
        this.config.exchange === "kalshi"
          ? this.config.kalshiSeriesTickers
          : this.config.marketSlugPrefixes,
      ladderMaxUsdcPerMarket:
        this.config.strategyMode === "reverse" ||
        this.config.strategyMode === "odahoa_static_maker"
          ? undefined
          : this.config.ladderMaxUsdcPerMarket,
      kalshiFeeOverrides:
        this.config.exchange === "kalshi"
          ? this.config.kalshiFeeOverrides
          : undefined,
      dryRun: this.config.dryRun,
      pollMs: this.config.pollIntervalMs,
      ladderPreset:
        this.config.strategyMode === "odahoa_ladder" ||
        this.config.strategyMode === "odahoa_ladder_2"
          ? this.config.ladderPreset
          : undefined,
      ladderV5MaxImbalance:
        this.config.strategyMode === "ladder_v5" ||
        this.config.strategyMode === "ladder_v5.5"
          ? this.config.ladderV5MaxImbalance
          : undefined,
      ladderV5MaxPairCost:
        this.config.strategyMode === "ladder_v5" ||
        this.config.strategyMode === "ladder_v5.5"
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
      ladderV7CheapPrice:
        this.config.strategyMode === "ladder_v7"
          ? this.config.ladderV7CheapPrice
          : undefined,
      ladderV7FavoritePrice:
        this.config.strategyMode === "ladder_v7"
          ? this.config.ladderV7FavoritePrice
          : undefined,
      ladderV7MaxShares:
        this.config.strategyMode === "ladder_v7"
          ? this.config.ladderV7MaxShares
          : undefined,
      ladderV8SizeScale:
        this.config.strategyMode === "ladder_v8"
          ? this.config.ladderV8SizeScale
          : undefined,
      ladderV8MaxSharesPerOrder:
        this.config.strategyMode === "ladder_v8"
          ? this.config.ladderV8MaxSharesPerOrder
          : undefined,
      ladderV8MaxUnmatchedShares:
        this.config.strategyMode === "ladder_v8"
          ? this.config.ladderV8MaxUnmatchedShares
          : undefined,
      ladderV9TargetShares:
        this.config.strategyMode === "ladder_v9"
          ? this.config.ladderV9TargetShares
          : undefined,
      ladderV9InitialFavoriteShares:
        this.config.strategyMode === "ladder_v9"
          ? this.config.ladderV9InitialFavoriteShares
          : undefined,
      ladderV9MinLockedEdge:
        this.config.strategyMode === "ladder_v9"
          ? this.config.ladderV9MinLockedEdge
          : undefined,
      ladderV10ScoreBands:
        this.config.strategyMode === "ladder_v10"
          ? [this.config.ladderV10ScoreLow, this.config.ladderV10ScoreHigh]
          : undefined,
      ladderV10BurnInMarkets:
        this.config.strategyMode === "ladder_v10"
          ? this.config.ladderV10BurnInMarkets
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

    await this.runOnce();
    if (this.ladderV10Regime && !this.ladderV10SampleTimer) {
      this.ladderV10SampleTimer = setInterval(
        () => void this.sampleLadderV10(),
        this.config.ladderV10SnapshotIntervalMs,
      );
    }
    setInterval(() => void this.scheduledTick(), this.config.pollIntervalMs);
  }

  async runOnce(): Promise<void> {
    await this.scheduledTick();
  }

  private async sampleLadderV10(): Promise<void> {
    if (!this.ladderV10Regime || this.ladderV10SampleRunning) return;
    this.ladderV10SampleRunning = true;
    try {
      await this.ladderV10Regime.sampleAll(
        (slug) => this.trader.getMarketExecutionSnapshot?.(slug) ?? null,
      );
    } catch (error) {
      log("Ladder V10 sample cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.ladderV10SampleRunning = false;
    }
  }

  private async scheduledTick(): Promise<void> {
    if (this.config.strategyMode === "reverse") {
      // Preserve the original reverse-mode scheduling and lifecycle exactly.
      await this.tick();
      return;
    }
    if (this.ladderTickRunning) {
      logThrottled(
        "Ladder scan skipped because the previous scan is still running",
        "global",
      );
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
      this.cleanupExpiredEventReferences();
      if (events.length === 0) {
        logThrottled("No active markets in window", "global");
        return;
      }

      if (this.config.strategyMode === "reverse") {
        for (const event of events) {
          await this.processEvent(event);
        }
        return;
      }
      await Promise.all(
        events.map((event) => this.enqueueMarket(event)),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Scan error", { error: message });
    }
  }

  private enqueueMarket(event: UpDownEvent): Promise<void> {
    const previous =
      this.marketQueues.get(event.slug) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.processEvent(event))
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : String(error);
        log("Market processing error", {
          market: event.slug,
          series: event.market.seriesTicker,
          error: message,
        });
      });
    this.marketQueues.set(event.slug, queued);
    const cleanup = () => {
      if (this.marketQueues.get(event.slug) === queued) {
        this.marketQueues.delete(event.slug);
      }
    };
    void queued.then(cleanup, cleanup);
    return queued;
  }

  private async processEvent(event: UpDownEvent): Promise<void> {
    const books = await this.scanner.getTokenBooks(event);
    await this.trader.observeMarket?.(event, books);
    if (
      this.trader.getMarketExecutionSnapshot?.(event.slug)
        ?.marketDataValid === false
    ) {
      return;
    }

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
    if (this.config.strategyMode === "ladder_v5.5") {
      this.ladderV55Events.set(event.slug, event);
      await this.enqueueLadderV55Market(event.slug);
      return;
    }
    if (this.config.strategyMode === "ladder_v6") {
      this.ladderV6Events.set(event.slug, { event, books });
      await this.enqueueLadderV6Market(event.slug);
      return;
    }
    if (this.config.strategyMode === "ladder_v7") {
      this.ladderV7Events.set(event.slug, event);
      await this.enqueueLadderV7Market(event.slug);
      return;
    }
    if (this.config.strategyMode === "ladder_v8") {
      this.ladderV8Events.set(event.slug, event);
      await this.enqueueLadderV8Market(event.slug);
      return;
    }
    if (this.config.strategyMode === "ladder_v9") {
      this.ladderV9Events.set(event.slug, event);
      await this.enqueueLadderV9Market(event.slug);
      return;
    }
    if (this.config.strategyMode === "ladder_v10") {
      this.ladderV10Events.set(event.slug, event);
      this.ladderV10Regime?.registerMarket(event, books);
      await this.enqueueLadderV10Market(event.slug);
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
      logThrottled("Watching market", event.slug, {
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
      logThrottled("Watching market", event.slug, {
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

    const preparedOpportunity = this.withCapitalEffect(opportunity);
    const result = await this.trader.placeBuy(preparedOpportunity);
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
      this.config.strategyMode === "ladder_v5.5" ||
      this.config.strategyMode === "ladder_v6" ||
      this.config.strategyMode === "ladder_v7" ||
      this.config.strategyMode === "ladder_v8" ||
      this.config.strategyMode === "ladder_v9" ||
      this.config.strategyMode === "ladder_v10"
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

  private withCapitalEffect(
    opportunity: TradeOpportunity,
  ): TradeOpportunity {
    if (
      opportunity.strategyMode === undefined ||
      opportunity.strategyMode === "reverse" ||
      opportunity.strategyMode === "odahoa_static_maker"
    ) {
      return opportunity;
    }
    if (
      opportunity.pairLockRole === "completion_maker" ||
      opportunity.pairLockRole === "completion_taker"
    ) {
      return { ...opportunity, capitalEffect: "reduce" };
    }
    const snapshot = this.trader.getMarketExecutionSnapshot?.(
      opportunity.event.slug,
    );
    if (!snapshot) {
      return { ...opportunity, capitalEffect: "increase" };
    }
    const tokenShares =
      snapshot.positions.find(
        (position) => position.tokenId === opportunity.token.tokenId,
      )?.shares ?? 0;
    const oppositeShares = Math.max(
      0,
      ...snapshot.positions
        .filter(
          (position) =>
            position.tokenId !== opportunity.token.tokenId,
        )
        .map((position) => position.shares),
    );
    return {
      ...opportunity,
      capitalEffect:
        tokenShares + 1e-8 < oppositeShares ? "reduce" : "increase",
    };
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
      logThrottled("Watching pair-lock market", event.slug, {
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
      if (snapshot.marketDataValid === false) return;
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
      if (!(await this.executeOpportunity(opportunity))) break;
      submitted += 1;
    }
    if (submitted === 0 && cancelled === 0) {
      logThrottled("Watching ladder_v5 market", event.slug, {
        market: event.title,
        slug: event.slug,
        filledShares: lastPlan?.filledSharesByOutcome ?? {},
        filledImbalance: lastPlan?.filledImbalance ?? 0,
        imbalanceCap: this.config.ladderV5MaxImbalance,
      });
    }
    this.trader.reportMarket?.(event.slug);
  }

  private async processLadderV7Event(
    event: UpDownEvent,
  ): Promise<void> {
    let submitted = 0;
    let cancelled = 0;
    let lastPlan:
      | Awaited<ReturnType<typeof planLadderV7>>
      | undefined;
    // V7 has two stable attempts: the cheap post-only bid and the favorite
    // FAK. Re-read after each so an immediate favorite fill is reflected in
    // the report without creating a second exposure attempt.
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const snapshot = this.trader.getMarketExecutionSnapshot?.(event.slug);
      if (!snapshot) {
        throw new Error(
          "ladder_v7 requires a fill-aware executor snapshot",
        );
      }
      if (snapshot.marketDataValid === false) return;
      const plan = await planLadderV7(
        this.config,
        this.ladderTracker,
        event,
        [...snapshot.books],
        snapshot,
      );
      lastPlan = plan;
      if (plan.cancelOrderIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error("ladder_v7 requires executor order cancellation");
        }
        await this.trader.cancelOrders(plan.cancelOrderIds);
        cancelled += plan.cancelOrderIds.length;
        continue;
      }
      const opportunity = plan.opportunities[0];
      if (!opportunity) break;
      if (!(await this.executeOpportunity(opportunity))) break;
      submitted += 1;
    }
    if (submitted === 0 && cancelled === 0) {
      logThrottled("Watching ladder_v7 market", event.slug, {
        market: event.title,
        slug: event.slug,
        filledShares: lastPlan?.filledSharesByOutcome ?? {},
        pairedShares: lastPlan?.pairedShares ?? 0,
        unmatchedShares: lastPlan?.unmatchedShares ?? 0,
        cheapMakerPrice: this.config.ladderV7CheapPrice,
        favoriteFakLimit: this.config.ladderV7FavoritePrice,
        maxShares: this.config.ladderV7MaxShares,
      });
    }
    this.trader.reportMarket?.(event.slug);
  }

  private enqueueLadderV7Market(marketSlug: string): Promise<void> {
    if (this.config.strategyMode !== "ladder_v7") {
      return Promise.resolve();
    }
    const previous = this.ladderV7Queues.get(marketSlug) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const event = this.ladderV7Events.get(marketSlug);
        if (!event) return;
        await this.processLadderV7Event(event);
      });
    this.ladderV7Queues.set(marketSlug, queued);
    const cleanup = () => {
      if (this.ladderV7Queues.get(marketSlug) === queued) {
        this.ladderV7Queues.delete(marketSlug);
      }
    };
    void queued.then(cleanup, cleanup);
    return queued;
  }

  private enqueueLadderV9Market(marketSlug: string): Promise<void> {
    if (this.config.strategyMode !== "ladder_v9") {
      return Promise.resolve();
    }
    const previous = this.ladderV9Queues.get(marketSlug) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const event = this.ladderV9Events.get(marketSlug);
        if (!event) return;
        await this.processLadderV9Event(event);
      });
    this.ladderV9Queues.set(marketSlug, queued);
    const cleanup = () => {
      if (this.ladderV9Queues.get(marketSlug) === queued) {
        this.ladderV9Queues.delete(marketSlug);
      }
    };
    void queued.then(cleanup, cleanup);
    return queued;
  }

  private async processLadderV9Event(event: UpDownEvent): Promise<void> {
    let submitted = 0;
    let cancelled = 0;
    let amended = 0;
    let flattened = 0;
    let lastPlan: Awaited<ReturnType<typeof planLadderV9>> | undefined;
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const snapshot = this.trader.getMarketExecutionSnapshot?.(event.slug);
      if (!snapshot) {
        throw new Error("ladder_v9 requires a fill-aware executor snapshot");
      }
      if (snapshot.marketDataValid === false) return;
      const plan = await planLadderV9(
        this.config,
        this.ladderTracker,
        event,
        [...snapshot.books],
        snapshot,
      );
      lastPlan = plan;
      if (plan.cancelOrderIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error("ladder_v9 requires executor order cancellation");
        }
        await this.trader.cancelOrders(plan.cancelOrderIds);
        cancelled += plan.cancelOrderIds.length;
        continue;
      }
      const amendment = plan.amendments[0];
      if (amendment) {
        if (!this.trader.amendOrder) {
          throw new Error("ladder_v9 requires executor order amendment");
        }
        const result = await this.trader.amendOrder(
          amendment.orderId,
          amendment.opportunity,
        );
        if (result.accepted === false) break;
        amended += 1;
        continue;
      }
      const opportunity = plan.opportunities[0];
      if (opportunity) {
        if (!(await this.executeOpportunity(opportunity))) break;
        submitted += 1;
        continue;
      }
      const flatten = plan.flattenOpportunities[0];
      if (flatten) {
        if (!(await this.executeSellOpportunity(flatten))) break;
        flattened += 1;
        continue;
      }
      break;
    }
    if (submitted === 0 && cancelled === 0 && amended === 0 && flattened === 0) {
      logThrottled("Watching ladder_v9 market", event.slug, {
        market: event.title,
        slug: event.slug,
        stage: lastPlan?.managementStage,
        filledShares: lastPlan?.filledSharesByOutcome ?? {},
        pairedShares: lastPlan?.pairedShares ?? 0,
        unmatchedCheapShares: lastPlan?.unmatchedCheapShares ?? 0,
        unmatchedFavoriteShares: lastPlan?.unmatchedFavoriteShares ?? 0,
        completionAttempts: lastPlan?.completionAttempts ?? 0,
        maximumCompletionPrice: lastPlan?.maximumCompletionPrice ?? null,
      });
    }
    this.trader.reportMarket?.(event.slug);
  }

  private enqueueLadderV10Market(marketSlug: string): Promise<void> {
    if (this.config.strategyMode !== "ladder_v10") {
      return Promise.resolve();
    }
    const active = this.ladderV10Queues.get(marketSlug);
    if (active) {
      this.ladderV10WakePending.add(marketSlug);
      return active;
    }
    const queued = this.drainLadderV10Market(marketSlug);
    this.ladderV10Queues.set(marketSlug, queued);
    const cleanup = () => {
      if (this.ladderV10Queues.get(marketSlug) === queued) {
        this.ladderV10Queues.delete(marketSlug);
      }
    };
    void queued.then(cleanup, cleanup);
    return queued;
  }

  private async drainLadderV10Market(marketSlug: string): Promise<void> {
    do {
      this.ladderV10WakePending.delete(marketSlug);
      const event = this.ladderV10Events.get(marketSlug);
      if (!event) return;
      await this.processLadderV10Event(event);
      // Keep only the newest state while execution is active. This bounds an
      // arbitrarily fast book stream to one additional per-market pass.
    } while (this.ladderV10WakePending.delete(marketSlug));
  }

  private async processLadderV10Event(event: UpDownEvent): Promise<void> {
    if (!this.ladderV10Regime) {
      throw new Error("ladder_v10 requires its regime engine");
    }
    let submitted = 0;
    let cancelled = 0;
    let lastPlan: Awaited<ReturnType<typeof planLadderV10>> | undefined;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const snapshot = this.trader.getMarketExecutionSnapshot?.(event.slug);
      if (!snapshot) {
        throw new Error("ladder_v10 requires a fill-aware executor snapshot");
      }
      if (snapshot.marketDataValid === false) return;
      const decision = await this.ladderV10Regime.decisionFor(event, snapshot);
      const plan = await planLadderV10(
        this.config,
        this.ladderTracker,
        event,
        snapshot,
        decision,
      );
      lastPlan = plan;
      if (plan.cancelOrderIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error("ladder_v10 requires executor order cancellation");
        }
        await this.trader.cancelOrders(plan.cancelOrderIds);
        cancelled += plan.cancelOrderIds.length;
        continue;
      }
      const opportunity = plan.opportunities[0];
      if (!opportunity) break;
      if (!(await this.executeOpportunity(opportunity))) break;
      submitted += 1;
    }
    if (submitted === 0 && cancelled === 0) {
      logThrottled("Watching ladder_v10 market", event.slug, {
        market: event.title,
        slug: event.slug,
        stage: lastPlan?.managementStage,
        score: lastPlan?.decision?.score ?? null,
        scoreSource: lastPlan?.decision?.source ?? "none",
        decisionReason: lastPlan?.decision?.decisionReason ?? "observing",
        favoriteTargetShares:
          lastPlan?.decision?.favoriteTargetShares ?? null,
        pairedShares: lastPlan?.pairedShares ?? 0,
        unmatchedCheapShares: lastPlan?.unmatchedCheapShares ?? 0,
        unmatchedFavoriteShares: lastPlan?.unmatchedFavoriteShares ?? 0,
        maximumCompletionPrice: lastPlan?.maximumCompletionPrice ?? null,
      });
    }
    this.trader.reportMarket?.(event.slug);
  }

  private async executeSellOpportunity(
    opportunity: TradeOpportunity,
  ): Promise<boolean> {
    if (!this.trader.placeSell) {
      throw new Error("ladder_v9 requires executor sell support");
    }
    log("Flattening residual position", {
      market: opportunity.event.title,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      size: opportunity.size,
    });
    const result = await this.trader.placeSell(opportunity);
    if (result.accepted === false) return false;
    await this.ladderTracker.mark(opportunity.tradeKey);
    return true;
  }

  private enqueueLadderV8Market(marketSlug: string): Promise<void> {
    if (this.config.strategyMode !== "ladder_v8") {
      return Promise.resolve();
    }
    const previous =
      this.ladderV8Queues.get(marketSlug) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const event = this.ladderV8Events.get(marketSlug);
        if (!event) return;
        await this.processLadderV8Event(event);
      });
    this.ladderV8Queues.set(marketSlug, queued);
    const cleanup = () => {
      if (this.ladderV8Queues.get(marketSlug) === queued) {
        this.ladderV8Queues.delete(marketSlug);
      }
    };
    void queued.then(cleanup, cleanup);
    return queued;
  }

  private async processLadderV8Event(
    event: UpDownEvent,
  ): Promise<void> {
    let submitted = 0;
    let cancelled = 0;
    let lastPlan:
      | Awaited<ReturnType<typeof planLadderV8>>
      | undefined;
    // A full complementary grid can contain eighteen distinct legs. Re-read
    // after each accepted order so the paper capital cap and fill-driven
    // imbalance guard see the latest state.
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const snapshot = this.trader.getMarketExecutionSnapshot?.(event.slug);
      if (!snapshot) {
        throw new Error(
          "ladder_v8 requires a fill-aware executor snapshot",
        );
      }
      if (snapshot.marketDataValid === false) return;
      const plan = await planLadderV8(
        this.config,
        this.ladderTracker,
        event,
        [...snapshot.books],
        snapshot,
      );
      lastPlan = plan;
      if (plan.cancelOrderIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error("ladder_v8 requires executor order cancellation");
        }
        await this.trader.cancelOrders(plan.cancelOrderIds);
        cancelled += plan.cancelOrderIds.length;
        continue;
      }
      const opportunity = plan.opportunities[0];
      if (!opportunity) break;
      if (!(await this.executeOpportunity(opportunity))) break;
      submitted += 1;
    }
    if (submitted === 0 && cancelled === 0) {
      logThrottled("Watching ladder_v8 market", event.slug, {
        market: event.title,
        slug: event.slug,
        filledShares: lastPlan?.filledSharesByOutcome ?? {},
        pairedShares: lastPlan?.pairedShares ?? 0,
        unmatchedShares: lastPlan?.unmatchedShares ?? 0,
        scheduledShares: lastPlan?.scheduledShares ?? 0,
        maxUnmatchedShares: this.config.ladderV8MaxUnmatchedShares,
        flipLocked: lastPlan?.flipLocked ?? false,
      });
    }
    this.trader.reportMarket?.(event.slug);
  }

  private enqueueLadderV55Market(marketSlug: string): Promise<void> {
    if (this.config.strategyMode !== "ladder_v5.5") {
      return Promise.resolve();
    }
    const previous = this.ladderV55Queues.get(marketSlug) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const event = this.ladderV55Events.get(marketSlug);
        if (!event) return;
        await this.processLadderV55Event(event);
      });
    this.ladderV55Queues.set(marketSlug, queued);
    const cleanup = () => {
      if (this.ladderV55Queues.get(marketSlug) === queued) {
        this.ladderV55Queues.delete(marketSlug);
      }
    };
    void queued.then(cleanup, cleanup);
    return queued;
  }

  private async processLadderV55Event(event: UpDownEvent): Promise<void> {
    let submitted = 0;
    let cancelled = 0;
    let lastPlan: Awaited<ReturnType<typeof planLadderV55>> | undefined;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const snapshot = this.trader.getMarketExecutionSnapshot?.(event.slug);
      if (!snapshot) {
        throw new Error("ladder_v5.5 requires a fill-aware executor snapshot");
      }
      if (snapshot.marketDataValid === false) return;
      const plan = await planLadderV55(
        this.config,
        this.ladderTracker,
        event,
        snapshot,
      );
      lastPlan = plan;
      if (plan.cancelOrderIds.length > 0) {
        if (!this.trader.cancelOrders) {
          throw new Error("ladder_v5.5 requires executor order cancellation");
        }
        await this.trader.cancelOrders(plan.cancelOrderIds);
        cancelled += plan.cancelOrderIds.length;
        continue;
      }
      const opportunity = plan.opportunities[0];
      if (!opportunity) break;
      if (!(await this.executeOpportunity(opportunity))) break;
      submitted += 1;
    }
    if (submitted === 0 && cancelled === 0) {
      logThrottled("Watching ladder_v5.5 market", event.slug, {
        market: event.title,
        slug: event.slug,
        entryFilledShares: lastPlan?.entryFilledShares ?? 0,
        hedgedShares: lastPlan?.hedgedShares ?? 0,
        pairedShares: lastPlan?.pairedShares ?? 0,
        unmatchedCheapShares: lastPlan?.unmatchedCheapShares ?? 0,
        observedHedgeAllInPerShare:
          lastPlan?.observedHedgeAllInPerShare ?? null,
        plannedAllInPairCost: lastPlan?.plannedAllInPairCost ?? null,
        plannedNetEdgePerPair: lastPlan?.plannedNetEdgePerPair ?? null,
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
      if (snapshot.marketDataValid === false) return;
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
      logThrottled("Watching ladder_v6 market", event.slug, {
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

  private cleanupExpiredEventReferences(): void {
    const now = Date.now() / 1_000;
    const prune = (events: Map<string, UpDownEvent>): void => {
      for (const [slug, event] of events) {
        if (event.windowEnd <= now) events.delete(slug);
      }
    };
    prune(this.ladderV55Events);
    prune(this.ladderV7Events);
    prune(this.ladderV8Events);
    prune(this.ladderV9Events);
    prune(this.ladderV10Events);
    for (const [slug, context] of this.ladderV6Events) {
      if (context.event.windowEnd <= now) this.ladderV6Events.delete(slug);
    }
    for (const slug of this.ladderV10WakePending) {
      if (!this.ladderV10Events.has(slug)) this.ladderV10WakePending.delete(slug);
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
    if (projected <= this.config.ladderMaxUsdcPerMarket + 1e-9) return;

    await this.ladderTracker.blockExposure(event.slug);
    log("Ladder market blocked by live exposure cap", {
      market: event.slug,
      projectedUsdc: projected,
      capUsdc: this.config.ladderMaxUsdcPerMarket,
      reason: "live CLOB minimum size raised projected exposure",
    });
  }
}
