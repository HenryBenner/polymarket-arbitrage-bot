import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ApiKeyCreds,
  ClobClient,
  OrderType,
  Side,
  type MakerOrder,
  type Trade,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { BotConfig } from "./config.js";
import type {
  MarketExecutionSnapshot,
  OrderExecutor,
  OrderResult,
  PaperFill,
  PaperOrder,
  PaperPosition,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";

interface LiveState {
  version: 1;
  orders: PaperOrder[];
  fills: PaperFill[];
}

interface LiveMarketContext {
  event: UpDownEvent;
  books: TokenBook[];
  feeRate: number;
  feeExponent: number;
}

export interface TraderOptions {
  client?: ClobClient;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function feeRateFromBps(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 10_000 : fallback;
}

function responseRecord(response: unknown): Record<string, unknown> {
  return response && typeof response === "object"
    ? (response as Record<string, unknown>)
    : {};
}

function responseOrderId(response: unknown): string {
  const record = responseRecord(response);
  return String(record.orderID ?? record.orderId ?? record.id ?? "");
}

function responseAccepted(response: unknown): boolean {
  const record = responseRecord(response);
  return record.success !== false && responseOrderId(response) !== "";
}

function takerFee(
  size: number,
  price: number,
  rate: number,
  exponent: number,
): number {
  return round(
    size * rate * Math.pow(price * (1 - price), exponent),
    5,
  );
}

function timestamp(value: string): string {
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return new Date(
      numericValue > 10_000_000_000 ? numericValue : numericValue * 1_000,
    ).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

export class Trader implements OrderExecutor {
  private client: ClobClient | null;
  private readonly statePath: string;
  private state: LiveState = { version: 1, orders: [], fills: [] };
  private readonly contexts = new Map<string, LiveMarketContext>();

  constructor(
    private readonly config: BotConfig,
    options: TraderOptions = {},
  ) {
    this.client = options.client ?? null;
    this.statePath = join(config.paperStatePath, "live-execution-state.json");
  }

  async init(): Promise<void> {
    if (this.config.dryRun) return;
    this.client ??= await createTradingClient(this.config);
    if (this.config.strategyMode !== "odahoa_ladder_2") return;
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as LiveState;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported live execution state: ${parsed.version}`);
      }
      this.state = parsed;
      this.state.orders ??= [];
      this.state.fills ??= [];
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  async observeMarket(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    if (this.config.strategyMode !== "odahoa_ladder_2") return;
    const existing = this.contexts.get(event.slug);
    const scheduledRate = event.market.feeSchedule?.rate;
    const fallbackRate =
      scheduledRate === undefined
        ? event.slug.startsWith("btc-updown-15m")
          ? 0.07
          : 0
        : numeric(scheduledRate) / (numeric(scheduledRate) > 1 ? 10_000 : 1);
    const context: LiveMarketContext = {
      event,
      books: books.map((book) => ({
        ...book,
        bids: book.bids.map((level) => ({ ...level })),
        asks: book.asks.map((level) => ({ ...level })),
      })),
      feeRate: existing?.feeRate ?? fallbackRate,
      feeExponent:
        existing?.feeExponent ?? event.market.feeSchedule?.exponent ?? 1,
    };
    this.contexts.set(event.slug, context);
    if (this.config.dryRun || !this.client) return;

    const tokenId = books[0]?.tokenId;
    if (tokenId) {
      try {
        const [feeRateBps, exponent] = await Promise.all([
          this.client.getFeeRateBps(tokenId),
          this.client.getFeeExponent(tokenId),
        ]);
        context.feeRate = numeric(feeRateBps) / 10_000;
        context.feeExponent = numeric(exponent, 1);
      } catch {
        // The market payload fallback above is sufficient for the next retry.
      }
    }
    await this.reconcileMarket(context);
  }

  async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
    if (this.config.dryRun) {
      return {
        dryRun: true,
        accepted: true,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
      };
    }
    if (!this.client) throw new Error("Trading client not initialized");

    if (this.config.strategyMode !== "odahoa_ladder_2") {
      const response = await this.client.createAndPostOrder(
        {
          tokenID: opportunity.token.tokenId,
          price: opportunity.price,
          side: Side.BUY,
          size: opportunity.size,
        },
        {
          tickSize: opportunity.tickSize as
            | "0.1"
            | "0.01"
            | "0.005"
            | "0.0025"
            | "0.001"
            | "0.0001",
          negRisk: opportunity.negRisk,
        },
        OrderType.GTC,
      );
      return {
        dryRun: false,
        accepted: true,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
        response,
      };
    }

    const existing = this.state.orders.find(
      (order) => order.tradeKey === opportunity.tradeKey,
    );
    if (existing) {
      return {
        dryRun: false,
        accepted: true,
        tokenId: existing.tokenId,
        side: "BUY",
        price: existing.limitPrice,
        size: existing.originalSize,
        response: { duplicate: true, orderID: existing.id },
      };
    }

    const options = {
      tickSize: opportunity.tickSize as
        | "0.1"
        | "0.01"
        | "0.005"
        | "0.0025"
        | "0.001"
        | "0.0001",
      negRisk: opportunity.negRisk,
    };
    let response: unknown;
    try {
      if (opportunity.orderPolicy === "fak") {
        response = await this.client.createAndPostMarketOrder(
          {
            tokenID: opportunity.token.tokenId,
            amount: round(opportunity.size * opportunity.price, 6),
            price: opportunity.price,
            side: Side.BUY,
            orderType: OrderType.FAK,
          },
          options,
          OrderType.FAK,
        );
      } else {
        response = await this.client.createAndPostOrder(
          {
            tokenID: opportunity.token.tokenId,
            price: opportunity.price,
            side: Side.BUY,
            size: opportunity.size,
          },
          options,
          OrderType.GTC,
          opportunity.orderPolicy === "post_only",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        opportunity.orderPolicy === "post_only" &&
        /post.?only|would cross|cross.*book/i.test(message)
      ) {
        return {
          dryRun: false,
          accepted: false,
          tokenId: opportunity.token.tokenId,
          side: "BUY",
          price: opportunity.price,
          size: opportunity.size,
          response: { status: "rejected", reason: message },
        };
      }
      throw error;
    }

    const accepted = responseAccepted(response);
    const orderId = responseOrderId(response);
    if (accepted) {
      const now = new Date().toISOString();
      this.state.orders.push({
        id: orderId,
        tradeKey: opportunity.tradeKey,
        marketSlug: opportunity.event.slug,
        marketTitle: opportunity.event.title,
        conditionId: opportunity.event.market.conditionId,
        tokenId: opportunity.token.tokenId,
        outcome: opportunity.token.outcome,
        limitPrice: opportunity.price,
        originalSize: opportunity.size,
        remainingSize: opportunity.size,
        queueAhead: 0,
        status:
          opportunity.orderPolicy === "fak" ? "cancelled" : "open",
        phaseId: opportunity.phaseId,
        pairId: opportunity.pairId,
        orderPolicy: opportunity.orderPolicy ?? "gtc",
        pairLockRole: opportunity.pairLockRole,
        pairLockSourceFillId: opportunity.pairLockSourceFillId,
        pairLockEntryPrice: opportunity.pairLockEntryPrice,
        createdAt: now,
        submittedMinutesLeft:
          (opportunity.event.windowEnd - Date.now() / 1000) / 60,
      });
      await this.persist();
    }

    return {
      dryRun: false,
      accepted,
      tokenId: opportunity.token.tokenId,
      side: "BUY",
      price: opportunity.price,
      size: opportunity.size,
      response,
    };
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0 || this.config.dryRun) return;
    if (!this.client) throw new Error("Trading client not initialized");
    const response = await this.client.cancelOrders(orderIds);
    const record = responseRecord(response);
    const explicitlyCancelled = Array.isArray(record.canceled)
      ? new Set(record.canceled.map(String))
      : new Set(orderIds);
    for (const order of this.state.orders) {
      if (
        explicitlyCancelled.has(order.id) &&
        (order.status === "open" || order.status === "partial")
      ) {
        order.status = "cancelled";
      }
    }
    await this.persist();
  }

  getMarketExecutionSnapshot(
    marketSlug: string,
  ): Readonly<MarketExecutionSnapshot> | null {
    const context = this.contexts.get(marketSlug);
    if (!context) return null;
    const orders = this.state.orders.filter(
      (order) => order.marketSlug === marketSlug,
    );
    const openOrders = orders.filter(
      (order) => order.status === "open" || order.status === "partial",
    );
    const fills = this.state.fills.filter(
      (fill) => fill.marketSlug === marketSlug,
    );
    const positions = this.derivePositions(fills);
    const capitalUsed = fills.reduce(
      (sum, fill) => sum + fill.price * fill.size + fill.fee,
      0,
    );
    const openCommitted = openOrders.reduce(
      (sum, order) => sum + order.limitPrice * order.remainingSize,
      0,
    );
    return structuredClone({
      marketSlug,
      orders,
      openOrders,
      fills,
      positions,
      books: context.books,
      capitalUsed: round(capitalUsed),
      openCommitted: round(openCommitted),
      capitalCommitted: round(capitalUsed + openCommitted),
      availableCash: Number.MAX_SAFE_INTEGER,
      totalFees: round(fills.reduce((sum, fill) => sum + fill.fee, 0)),
      estimatedMakerRebate: 0,
      takerFeeRate: context.feeRate,
      takerFeeExponent: context.feeExponent,
      settledPnl: null,
    });
  }

  private async reconcileMarket(context: LiveMarketContext): Promise<void> {
    if (!this.client) return;
    const conditionId = context.event.market.conditionId;
    const [openOrders, trades] = await Promise.all([
      this.client.getOpenOrders({ market: conditionId }),
      this.client.getTrades({ market: conditionId }),
    ]);
    const localOrders = this.state.orders.filter(
      (order) => order.conditionId === conditionId,
    );
    const localById = new Map(localOrders.map((order) => [order.id, order]));

    for (const trade of trades) {
      const taker = localById.get(trade.taker_order_id);
      if (taker && trade.side === Side.BUY) {
        this.addTradeFill(
          taker,
          trade,
          numeric(trade.size),
          numeric(trade.price),
          "taker",
          feeRateFromBps(trade.fee_rate_bps, context.feeRate),
          context.feeExponent,
        );
      }
      for (const maker of trade.maker_orders ?? []) {
        const localMaker = localById.get(maker.order_id);
        if (!localMaker || maker.side === Side.SELL) continue;
        this.addMakerFill(localMaker, trade, maker, context);
      }
    }

    const openIds = new Set(openOrders.map((order) => order.id));
    for (const order of localOrders) {
      const filled = this.state.fills
        .filter((fill) => fill.orderId === order.id)
        .reduce((sum, fill) => sum + fill.size, 0);
      order.remainingSize = round(
        Math.max(0, order.originalSize - filled),
      );
      if (order.remainingSize <= 1e-8) {
        order.status = "filled";
      } else if (openIds.has(order.id)) {
        order.status =
          order.remainingSize < order.originalSize ? "partial" : "open";
      } else if (
        order.orderPolicy === "fak" ||
        Date.now() - Date.parse(order.createdAt) > 2_000
      ) {
        order.status = "cancelled";
      }
    }
    await this.persist();
  }

  private addMakerFill(
    order: PaperOrder,
    trade: Trade,
    maker: MakerOrder,
    context: LiveMarketContext,
  ): void {
    this.addTradeFill(
      order,
      trade,
      numeric(maker.matched_amount),
      numeric(maker.price),
      "maker",
      feeRateFromBps(maker.fee_rate_bps, context.feeRate),
      context.feeExponent,
    );
  }

  private addTradeFill(
    order: PaperOrder,
    trade: Trade,
    size: number,
    price: number,
    liquidity: "taker" | "maker",
    feeRate: number,
    feeExponent: number,
  ): void {
    const id = `${trade.id}:${order.id}`;
    if (
      size <= 0 ||
      price <= 0 ||
      this.state.fills.some((fill) => fill.id === id)
    ) {
      return;
    }
    this.state.fills.push({
      id,
      orderId: order.id,
      marketSlug: order.marketSlug,
      tokenId: order.tokenId,
      outcome: order.outcome,
      price,
      size,
      fee:
        liquidity === "taker"
          ? takerFee(size, price, feeRate, feeExponent)
          : 0,
      liquidity,
      timestamp: timestamp(trade.match_time),
    });
  }

  private derivePositions(fills: PaperFill[]): PaperPosition[] {
    const positions = new Map<string, PaperPosition>();
    for (const fill of fills) {
      const existing = positions.get(fill.tokenId);
      if (existing) {
        existing.shares = round(existing.shares + fill.size);
        existing.totalCost = round(
          existing.totalCost + fill.price * fill.size,
        );
      } else {
        positions.set(fill.tokenId, {
          marketSlug: fill.marketSlug,
          tokenId: fill.tokenId,
          outcome: fill.outcome,
          shares: fill.size,
          totalCost: round(fill.price * fill.size),
        });
      }
    }
    return [...positions.values()];
  }

  private async persist(): Promise<void> {
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
  }
}

async function createTradingClient(config: BotConfig): Promise<ClobClient> {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required for live trading");
  }
  const account = privateKeyToAccount(config.privateKey);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  let creds: ApiKeyCreds | undefined;
  if (config.clobApiKey && config.clobSecret && config.clobPassphrase) {
    creds = {
      key: config.clobApiKey,
      secret: config.clobSecret,
      passphrase: config.clobPassphrase,
    };
  }

  const bootstrap = new ClobClient({
    host: config.clobHost,
    chain: config.chainId,
    signer,
  });
  const apiCreds = creds ?? (await bootstrap.createOrDeriveApiKey());
  return new ClobClient({
    host: config.clobHost,
    chain: config.chainId,
    signer,
    creds: apiCreds,
    signatureType: config.signatureType,
    funderAddress: config.funderAddress,
    throwOnError: true,
  });
}
