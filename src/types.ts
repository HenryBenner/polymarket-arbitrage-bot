export type TradeSide = "BUY" | "SELL";
export type StrategyMode =
  | "reverse"
  | "odahoa_ladder"
  | "odahoa_ladder_2"
  | "odahoa_static_maker"
  | "ladder_v5"
  | "ladder_v5.5"
  | "ladder_v6"
  | "ladder_v7"
  | "ladder_v8"
  | "ladder_v9"
  | "ladder_v10"
  | "ladder_v11"
  | "ladder_v12"
  | "ladder_v13"
  | "ladder_v14";
export type ExecutionMode = "dry_run" | "paper" | "live";
export type ExchangeName = "polymarket" | "kalshi";
export type LadderPreset = "odahoa_v1";
export type PairLockOrderRole =
  | "opening"
  | "completion_maker"
  | "completion_taker";
export type CapitalEffect = "increase" | "reduce";

export interface GammaMarket {
  exchange?: ExchangeName;
  externalMarketId?: string;
  seriesTicker?: string;
  id?: string;
  question: string;
  conditionId: string;
  slug: string;
  clobTokenIds: string;
  outcomes: string;
  outcomePrices?: string;
  negRisk: boolean;
  orderPriceMinTickSize: number;
  orderPriceRanges?: Array<{
    start: number;
    end: number;
    step: number;
  }>;
  feesEnabled?: boolean;
  feeSchedule?: {
    exponent?: number;
    rate?: number;
    makerRate?: number;
    takerOnly?: boolean;
    rebateRate?: number;
  };
  active: boolean;
  closed: boolean;
}

export interface UpDownEvent {
  title: string;
  slug: string;
  market: GammaMarket;
  windowStart: number;
  windowEnd: number;
}

export interface TokenBook {
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  bestBid: number | null;
  bestAsk: number | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  minOrderSize: number;
  hash?: string;
  timestamp?: string;
}

export interface TradeOpportunity {
  kind: "cheap" | "expensive" | "maker";
  event: UpDownEvent;
  token: TokenBook;
  price: number;
  size: number;
  tickSize: string;
  negRisk: boolean;
  tradeKey: string;
  strategyMode?: StrategyMode;
  phaseId?: string;
  pairId?: string;
  orderPolicy?: "gtc" | "post_only" | "fak" | "fok";
  pairLockRole?: PairLockOrderRole;
  pairLockSourceFillId?: string;
  pairLockEntryPrice?: number;
  referenceTokenId?: string;
  referenceAllInPrice?: number;
  plannedAllInPairCost?: number;
  plannedNetEdgePerPair?: number;
  capitalEffect?: CapitalEffect;
}

export interface OrderResult {
  dryRun: boolean;
  accepted?: boolean;
  tokenId: string;
  side: TradeSide;
  price: number;
  size: number;
  response?: unknown;
}

export interface OrderBook {
  bids?: RawOrderBookLevel[];
  asks?: RawOrderBookLevel[];
  min_order_size?: string;
  hash?: string;
  timestamp?: string;
}

export interface RawOrderBookLevel {
  price: string;
  size?: string;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface LadderRung {
  lowPrice: number;
  highPrice: number;
}

export interface LadderPhase {
  id: string;
  minutesLeftMin: number;
  minutesLeftMax: number;
  rungs: LadderRung[];
}

export interface LadderPhaseLock {
  marketSlug: string;
  phaseId: string;
  cheapTokenId: string;
  cheapOutcome: string;
  favoriteTokenId: string;
  favoriteOutcome: string;
  createdAt: string;
}

export type PaperOrderStatus = "open" | "partial" | "filled" | "cancelled";

export interface PaperOrder {
  id: string;
  tradeKey: string;
  marketSlug: string;
  marketTitle: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  limitPrice: number;
  originalSize: number;
  remainingSize: number;
  queueAhead: number;
  status: PaperOrderStatus;
  side?: TradeSide;
  phaseId?: string;
  pairId?: string;
  orderPolicy?: "gtc" | "post_only" | "fak" | "fok";
  pairLockRole?: PairLockOrderRole;
  pairLockSourceFillId?: string;
  pairLockEntryPrice?: number;
  referenceTokenId?: string;
  referenceAllInPrice?: number;
  plannedAllInPairCost?: number;
  plannedNetEdgePerPair?: number;
  createdAt: string;
  submittedMinutesLeft?: number;
}

export interface PaperFill {
  id: string;
  orderId: string;
  marketSlug: string;
  tokenId: string;
  outcome: string;
  price: number;
  size: number;
  fee: number;
  makerFeeEquivalent?: number;
  estimatedMakerRebate?: number;
  liquidity: "taker" | "maker";
  side?: TradeSide;
  timestamp: string;
}

export interface PaperPosition {
  marketSlug: string;
  tokenId: string;
  outcome: string;
  shares: number;
  totalCost: number;
}

export interface PaperSettlement {
  marketSlug: string;
  winningTokenId: string;
  winningOutcome: string;
  payout: number;
  totalCost: number;
  totalFees: number;
  estimatedMakerRebate?: number;
  adjustedPnl?: number;
  realizedPnl: number;
  settledAt: string;
}

export interface MarketExecutionSnapshot {
  marketSlug: string;
  marketDataValid?: boolean;
  executionPending?: boolean;
  /** False for V14 paper trading, where cash is accounting-only. */
  capitalConstraint?: boolean;
  orders: readonly PaperOrder[];
  openOrders: readonly PaperOrder[];
  fills: readonly PaperFill[];
  positions: readonly PaperPosition[];
  books: readonly TokenBook[];
  capitalUsed: number;
  openCommitted: number;
  capitalCommitted: number;
  availableCash: number;
  hypotheticalStartingBalance?: number;
  grossCapitalDeployed?: number;
  theoreticalCash?: number;
  markedInventoryValue?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  totalFees: number;
  estimatedMakerRebate: number;
  takerFeeRate: number;
  makerFeeRate?: number;
  takerFeeExponent: number;
  settledPnl: number | null;
}

export interface OrderExecutor {
  init(): Promise<void>;
  placeBuy(opportunity: TradeOpportunity): Promise<OrderResult>;
  placeBuys?(opportunities: readonly TradeOpportunity[]): Promise<OrderResult[]>;
  placeSell?(opportunity: TradeOpportunity): Promise<OrderResult>;
  amendOrder?(
    orderId: string,
    opportunity: TradeOpportunity,
  ): Promise<OrderResult>;
  setExecutionWakeHandler?(
    handler: (marketSlug: string) => void | Promise<void>,
  ): void;
  setMarketTelemetryHandler?(
    handler: (event: Record<string, unknown>) => void | Promise<void>,
  ): void;
  setSettlementHandler?(
    handler: (settlement: PaperSettlement) => void | Promise<void>,
  ): void;
  observeMarket?(event: UpDownEvent, books: TokenBook[]): Promise<void>;
  getMarketExecutionSnapshot?(
    marketSlug: string,
  ): Readonly<MarketExecutionSnapshot> | null;
  reportMarket?(marketSlug: string): void;
  cancelOrders?(orderIds: string[]): Promise<void>;
  close?(): Promise<void>;
}
