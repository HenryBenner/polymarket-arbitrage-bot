export type TradeSide = "BUY" | "SELL";
export type StrategyMode = "reverse" | "odahoa_ladder";
export type ExecutionMode = "dry_run" | "paper" | "live";

export interface GammaMarket {
  id?: string;
  question: string;
  conditionId: string;
  slug: string;
  clobTokenIds: string;
  outcomes: string;
  outcomePrices?: string;
  negRisk: boolean;
  orderPriceMinTickSize: number;
  feesEnabled?: boolean;
  feeSchedule?: {
    exponent?: number;
    rate?: number;
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
  kind: "cheap" | "expensive";
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
}

export interface OrderResult {
  dryRun: boolean;
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
  phaseId?: string;
  pairId?: string;
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
  liquidity: "taker" | "maker";
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
  realizedPnl: number;
  settledAt: string;
}

export interface OrderExecutor {
  init(): Promise<void>;
  placeBuy(opportunity: TradeOpportunity): Promise<OrderResult>;
  observeMarket?(event: UpDownEvent, books: TokenBook[]): Promise<void>;
  reportMarket?(marketSlug: string): void;
  close?(): Promise<void>;
}
