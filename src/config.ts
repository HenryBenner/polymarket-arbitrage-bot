import "dotenv/config";
import { projectedLadderCapital } from "./ladder.js";
import type {
  ExchangeName,
  ExecutionMode,
  LadderPreset,
  StrategyMode,
} from "./types.js";

function envString(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for env var ${key}: ${raw}`);
  }
  return parsed;
}

function envBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

function envList(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizedUniqueList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))];
}

function kalshiSeriesFromEnv(): string[] {
  if (process.env.CRYPTO_MARKETS !== undefined) {
    return normalizedUniqueList((process.env.CRYPTO_MARKETS ?? "").split(","));
  }
  return normalizedUniqueList(
    envList("KALSHI_SERIES_TICKERS", ["KXBTC15M"]),
  );
}

export interface KalshiFeeRates {
  takerRate: number;
  makerRate: number;
}

function kalshiFeeOverridesFromEnv(): Record<string, KalshiFeeRates> {
  const raw = process.env.KALSHI_FEE_OVERRIDES;
  if (raw === undefined || raw.trim() === "") return {};
  const overrides: Record<string, KalshiFeeRates> = {};
  for (const item of raw.split(",")) {
    const [rawSeries, rawTaker, rawMaker, ...extra] = item
      .split(":")
      .map((part) => part.trim());
    const series = rawSeries?.toUpperCase();
    const takerRate = Number(rawTaker);
    const makerRate = Number(rawMaker);
    if (
      !series ||
      rawTaker === undefined ||
      rawMaker === undefined ||
      extra.length > 0 ||
      !Number.isFinite(takerRate) ||
      !Number.isFinite(makerRate)
    ) {
      throw new Error(
        `Invalid KALSHI_FEE_OVERRIDES entry: ${item}. ` +
          "Use SERIES:TAKER_RATE:MAKER_RATE",
      );
    }
    overrides[series] = { takerRate, makerRate };
  }
  return overrides;
}

function envNumberWithLegacy(
  key: string,
  legacyKey: string,
  fallback: number,
): number {
  if (process.env[key] !== undefined && process.env[key] !== "") {
    return envNumber(key, fallback);
  }
  return envNumber(legacyKey, fallback);
}

export interface BotConfig {
  exchange: ExchangeName;
  strategyMode: StrategyMode;
  executionMode: ExecutionMode;
  pollIntervalMs: number;
  marketSlugPrefixes: string[];
  cheapBuyMin: number;
  cheapBuyMax: number;
  expensiveBuyMin: number;
  expensiveBuyMax: number;
  enableExpensiveHedge: boolean;
  cheapOrderUsdc: number;
  expensiveOrderUsdc: number;
  maxSharesPerOrder: number;
  minutesBeforeCloseMin: number;
  minutesBeforeCloseMax: number;
  dryRun: boolean;
  liveTradingAck?: string;
  privateKey?: `0x${string}`;
  funderAddress?: `0x${string}`;
  signatureType: number;
  clobHost: string;
  chainId: number;
  clobApiKey?: string;
  clobSecret?: string;
  clobPassphrase?: string;
  gammaApiHost: string;
  kalshiApiHost: string;
  kalshiWsHost: string;
  kalshiApiKeyId?: string;
  kalshiPrivateKeyPem?: string;
  kalshiSeriesTickers: string[];
  kalshiSubaccount: number;
  kalshiTakerFeeRate: number;
  kalshiMakerFeeRate: number;
  kalshiFeeOverrides: Record<string, KalshiFeeRates>;
  ladderPreset: LadderPreset;
  ladderSizeScale: number;
  ladderMaxUsdcPerMarket: number;
  ladderLiveAck?: string;
  staticMakerMaxShares: number;
  staticMakerMaxUsdcPerMarket: number;
  pairLockMaxCost: number;
  pairLockResidualFraction: number;
  pairLockResidualMaxPrice: number;
  ladderV5MaxImbalance: number;
  ladderV5MaxPairCost: number;
  ladderV6MaxUnmatchedShares: number;
  ladderV6MinNetEdge: number;
  ladderV6SafetyBuffer: number;
  ladderV6MaxRescueLoss: number;
  ladderV7CheapPrice: number;
  ladderV7FavoritePrice: number;
  ladderV7MaxShares: number;
  ladderV8SizeScale: number;
  ladderV8MaxSharesPerOrder: number;
  ladderV8MaxUnmatchedShares: number;
  paperStartingUsdc: number;
  paperStatePath: string;
}

export function kalshiFeeRatesForSeries(
  config: BotConfig,
  seriesTicker: string,
): KalshiFeeRates {
  return (
    config.kalshiFeeOverrides[seriesTicker] ?? {
      takerRate: config.kalshiTakerFeeRate,
      makerRate: config.kalshiMakerFeeRate,
    }
  );
}

export function loadConfig(): BotConfig {
  const exchange = envString("EXCHANGE", "polymarket");
  if (exchange !== "polymarket" && exchange !== "kalshi") {
    throw new Error("EXCHANGE must be polymarket or kalshi");
  }
  const strategyRaw = envString("STRATEGY_MODE", "reverse");
  if (
    strategyRaw !== "reverse" &&
    strategyRaw !== "odahoa_ladder" &&
    strategyRaw !== "odahoa_ladder_2" &&
    strategyRaw !== "odahoa_static_maker" &&
    strategyRaw !== "ladder_v5" &&
    strategyRaw !== "ladder_v5.5" &&
    strategyRaw !== "ladder_v6" &&
    strategyRaw !== "ladder_v7" &&
    strategyRaw !== "ladder_v8"
  ) {
    throw new Error(
      "STRATEGY_MODE must be reverse, odahoa_ladder, odahoa_ladder_2, odahoa_static_maker, ladder_v5, ladder_v5.5, ladder_v6, ladder_v7, or ladder_v8",
    );
  }

  const executionRaw = process.env.EXECUTION_MODE;
  const legacyDryRun = envBoolean("DRY_RUN", true);
  const executionMode = (
    executionRaw === undefined || executionRaw === ""
      ? legacyDryRun
        ? "dry_run"
        : "live"
      : executionRaw
  ) as ExecutionMode;
  if (!["dry_run", "paper", "live"].includes(executionMode)) {
    throw new Error("EXECUTION_MODE must be dry_run, paper, or live");
  }

  const ladderPreset = envString("LADDER_PRESET", "odahoa_v1");
  if (ladderPreset !== "odahoa_v1") {
    throw new Error("LADDER_PRESET must be odahoa_v1");
  }

  return {
    exchange,
    strategyMode: strategyRaw,
    executionMode,
    pollIntervalMs: envNumber("POLL_INTERVAL_MS", 5000),
    marketSlugPrefixes: envList("MARKET_SLUG_PREFIXES", [
      "btc-updown-15m",
      "eth-updown-15m",
    ]),
    cheapBuyMin: envNumber("CHEAP_BUY_MIN", 0.07),
    cheapBuyMax: envNumber("CHEAP_BUY_MAX", 0.1),
    expensiveBuyMin: envNumber("EXPENSIVE_BUY_MIN", 0.9),
    expensiveBuyMax: envNumber("EXPENSIVE_BUY_MAX", 0.95),
    enableExpensiveHedge: envBoolean("ENABLE_EXPENSIVE_HEDGE", true),
    cheapOrderUsdc: envNumber("CHEAP_ORDER_USDC", 10),
    expensiveOrderUsdc: envNumber("EXPENSIVE_ORDER_USDC", 50),
    maxSharesPerOrder: envNumber("MAX_SHARES_PER_ORDER", 90),
    minutesBeforeCloseMin: envNumber("MINUTES_BEFORE_CLOSE_MIN", 0),
    minutesBeforeCloseMax: envNumber("MINUTES_BEFORE_CLOSE_MAX", 15),
    dryRun: executionMode !== "live",
    liveTradingAck: process.env.LIVE_TRADING_ACK,
    privateKey: process.env.PRIVATE_KEY as `0x${string}` | undefined,
    funderAddress: process.env.FUNDER_ADDRESS as `0x${string}` | undefined,
    signatureType: envNumber("SIGNATURE_TYPE", 2),
    clobHost: envString("CLOB_HOST", "https://clob.polymarket.com"),
    chainId: envNumber("CHAIN_ID", 137),
    clobApiKey: process.env.CLOB_API_KEY,
    clobSecret: process.env.CLOB_SECRET,
    clobPassphrase: process.env.CLOB_PASSPHRASE,
    gammaApiHost: envString("GAMMA_API_HOST", "https://gamma-api.polymarket.com"),
    kalshiApiHost: envString(
      "KALSHI_API_HOST",
      "https://external-api.kalshi.com/trade-api/v2",
    ),
    kalshiWsHost: envString(
      "KALSHI_WS_HOST",
      "wss://external-api-ws.kalshi.com/trade-api/ws/v2",
    ),
    kalshiApiKeyId: process.env.KALSHI_API_KEY_ID,
    kalshiPrivateKeyPem: process.env.KALSHI_PRIVATE_KEY,
    kalshiSeriesTickers: kalshiSeriesFromEnv(),
    kalshiSubaccount: envNumber("KALSHI_SUBACCOUNT", 0),
    kalshiTakerFeeRate: envNumber("KALSHI_TAKER_FEE_RATE", 0.07),
    kalshiMakerFeeRate: envNumber("KALSHI_MAKER_FEE_RATE", 0),
    kalshiFeeOverrides: kalshiFeeOverridesFromEnv(),
    ladderPreset: ladderPreset as LadderPreset,
    ladderSizeScale: envNumber("LADDER_SIZE_SCALE", 1),
    ladderMaxUsdcPerMarket: envNumberWithLegacy(
      "LADDER_MAX_USDC_PER_MARKET",
      "LADDER_LIVE_MAX_USDC_PER_MARKET",
      65,
    ),
    ladderLiveAck: process.env.LADDER_LIVE_ACK,
    staticMakerMaxShares: envNumber("STATIC_MAKER_MAX_SHARES", 90),
    staticMakerMaxUsdcPerMarket: envNumber(
      "STATIC_MAKER_MAX_USDC_PER_MARKET",
      500,
    ),
    pairLockMaxCost: envNumber("PAIR_LOCK_MAX_COST", 0.985),
    pairLockResidualFraction: envNumber(
      "PAIR_LOCK_RESIDUAL_FRACTION",
      0.1,
    ),
    pairLockResidualMaxPrice: envNumber(
      "PAIR_LOCK_RESIDUAL_MAX_PRICE",
      0.2,
    ),
    ladderV5MaxImbalance: envNumber("LADDER_V5_MAX_IMBALANCE", 70),
    ladderV5MaxPairCost: envNumber("LADDER_V5_MAX_PAIR_COST", 0.98),
    ladderV6MaxUnmatchedShares: envNumber(
      "LADDER_V6_MAX_UNMATCHED_SHARES",
      40,
    ),
    ladderV6MinNetEdge: envNumber("LADDER_V6_MIN_NET_EDGE", 0.01),
    ladderV6SafetyBuffer: envNumber("LADDER_V6_SAFETY_BUFFER", 0.01),
    ladderV6MaxRescueLoss: envNumber("LADDER_V6_MAX_RESCUE_LOSS", 0.02),
    ladderV7CheapPrice: envNumber("LADDER_V7_CHEAP_PRICE", 0.1),
    ladderV7FavoritePrice: envNumber("LADDER_V7_FAVORITE_PRICE", 0.8),
    ladderV7MaxShares: envNumber("LADDER_V7_MAX_SHARES", 40),
    ladderV8SizeScale: envNumber("LADDER_V8_SIZE_SCALE", 1),
    ladderV8MaxSharesPerOrder: envNumber(
      "LADDER_V8_MAX_SHARES_PER_ORDER",
      120,
    ),
    ladderV8MaxUnmatchedShares: envNumber(
      "LADDER_V8_MAX_UNMATCHED_SHARES",
      240,
    ),
    paperStartingUsdc: envNumber("PAPER_STARTING_USDC", 100),
    paperStatePath: envString("PAPER_STATE_PATH", "./data/paper"),
  };
}

export function validateTradingConfig(config: BotConfig): void {
  if (config.exchange !== "polymarket" && config.exchange !== "kalshi") {
    throw new Error("EXCHANGE must be polymarket or kalshi");
  }
  if (!Number.isInteger(config.ladderSizeScale) || config.ladderSizeScale < 1) {
    throw new Error("LADDER_SIZE_SCALE must be an integer of at least 1");
  }
  if (!Number.isFinite(config.ladderMaxUsdcPerMarket) || config.ladderMaxUsdcPerMarket <= 0) {
    throw new Error("LADDER_MAX_USDC_PER_MARKET must be greater than 0");
  }
  if (!Number.isFinite(config.paperStartingUsdc) || config.paperStartingUsdc <= 0) {
    throw new Error("PAPER_STARTING_USDC must be greater than 0");
  }
  if (
    !Number.isInteger(config.staticMakerMaxShares) ||
    config.staticMakerMaxShares <= 0 ||
    config.staticMakerMaxShares > 90
  ) {
    throw new Error(
      "STATIC_MAKER_MAX_SHARES must be a positive integer no greater than 90",
    );
  }
  if (
    !Number.isFinite(config.staticMakerMaxUsdcPerMarket) ||
    config.staticMakerMaxUsdcPerMarket <= 0 ||
    config.staticMakerMaxUsdcPerMarket > 500
  ) {
    throw new Error(
      "STATIC_MAKER_MAX_USDC_PER_MARKET must be greater than 0 and at most 500",
    );
  }
  const staticMakerProjectedCapital = config.staticMakerMaxShares * 4.5;
  if (
    config.strategyMode === "odahoa_static_maker" &&
    staticMakerProjectedCapital > config.staticMakerMaxUsdcPerMarket + 1e-9
  ) {
    throw new Error(
      `Static maker projected exposure $${staticMakerProjectedCapital.toFixed(2)} exceeds ` +
        `STATIC_MAKER_MAX_USDC_PER_MARKET=$${config.staticMakerMaxUsdcPerMarket.toFixed(2)}`,
    );
  }
  if (
    !Number.isFinite(config.pairLockMaxCost) ||
    config.pairLockMaxCost <= 0 ||
    config.pairLockMaxCost >= 1
  ) {
    throw new Error("PAIR_LOCK_MAX_COST must be greater than 0 and less than 1");
  }
  if (
    !Number.isFinite(config.pairLockResidualFraction) ||
    config.pairLockResidualFraction < 0 ||
    config.pairLockResidualFraction > 1
  ) {
    throw new Error(
      "PAIR_LOCK_RESIDUAL_FRACTION must be between 0 and 1",
    );
  }
  if (
    !Number.isFinite(config.pairLockResidualMaxPrice) ||
    config.pairLockResidualMaxPrice <= 0 ||
    config.pairLockResidualMaxPrice >= 1
  ) {
    throw new Error(
      "PAIR_LOCK_RESIDUAL_MAX_PRICE must be greater than 0 and less than 1",
    );
  }
  if (
    !Number.isFinite(config.ladderV5MaxImbalance) ||
    config.ladderV5MaxImbalance <= 0
  ) {
    throw new Error("LADDER_V5_MAX_IMBALANCE must be greater than 0");
  }
  if (
    !Number.isFinite(config.ladderV5MaxPairCost) ||
    config.ladderV5MaxPairCost <= 0 ||
    config.ladderV5MaxPairCost >= 1
  ) {
    throw new Error(
      "LADDER_V5_MAX_PAIR_COST must be greater than 0 and less than 1",
    );
  }
  if (
    !Number.isFinite(config.ladderV6MaxUnmatchedShares) ||
    config.ladderV6MaxUnmatchedShares <= 0
  ) {
    throw new Error("LADDER_V6_MAX_UNMATCHED_SHARES must be greater than 0");
  }
  if (
    !Number.isFinite(config.ladderV6MinNetEdge) ||
    config.ladderV6MinNetEdge <= 0 ||
    config.ladderV6MinNetEdge >= 1
  ) {
    throw new Error(
      "LADDER_V6_MIN_NET_EDGE must be greater than 0 and less than 1",
    );
  }
  if (
    !Number.isFinite(config.ladderV6SafetyBuffer) ||
    config.ladderV6SafetyBuffer < 0 ||
    config.ladderV6SafetyBuffer >= 1
  ) {
    throw new Error(
      "LADDER_V6_SAFETY_BUFFER must be at least 0 and less than 1",
    );
  }
  if (
    !Number.isFinite(config.ladderV6MaxRescueLoss) ||
    config.ladderV6MaxRescueLoss < 0 ||
    config.ladderV6MaxRescueLoss >= 1
  ) {
    throw new Error(
      "LADDER_V6_MAX_RESCUE_LOSS must be at least 0 and less than 1",
    );
  }
  if (
    !Number.isFinite(config.ladderV7CheapPrice) ||
    config.ladderV7CheapPrice <= 0 ||
    config.ladderV7CheapPrice >= 0.5
  ) {
    throw new Error(
      "LADDER_V7_CHEAP_PRICE must be greater than 0 and less than 0.5",
    );
  }
  if (
    !Number.isFinite(config.ladderV7FavoritePrice) ||
    config.ladderV7FavoritePrice <= 0.5 ||
    config.ladderV7FavoritePrice >= 1
  ) {
    throw new Error(
      "LADDER_V7_FAVORITE_PRICE must be greater than 0.5 and less than 1",
    );
  }
  if (
    config.ladderV7CheapPrice + config.ladderV7FavoritePrice >= 1
  ) {
    throw new Error(
      "LADDER_V7_CHEAP_PRICE plus LADDER_V7_FAVORITE_PRICE must be less than 1",
    );
  }
  if (
    !Number.isFinite(config.ladderV7MaxShares) ||
    config.ladderV7MaxShares <= 0
  ) {
    throw new Error("LADDER_V7_MAX_SHARES must be greater than 0");
  }
  if (
    !Number.isFinite(config.ladderV8SizeScale) ||
    config.ladderV8SizeScale <= 0
  ) {
    throw new Error("LADDER_V8_SIZE_SCALE must be greater than 0");
  }
  if (
    !Number.isFinite(config.ladderV8MaxSharesPerOrder) ||
    config.ladderV8MaxSharesPerOrder <= 0
  ) {
    throw new Error(
      "LADDER_V8_MAX_SHARES_PER_ORDER must be greater than 0",
    );
  }
  if (
    !Number.isFinite(config.ladderV8MaxUnmatchedShares) ||
    config.ladderV8MaxUnmatchedShares <= 0
  ) {
    throw new Error(
      "LADDER_V8_MAX_UNMATCHED_SHARES must be greater than 0",
    );
  }
  if (
    (config.strategyMode === "ladder_v5" ||
      config.strategyMode === "ladder_v5.5" ||
      config.strategyMode === "ladder_v7") &&
    config.ladderSizeScale > 6
  ) {
    throw new Error(
      `${config.strategyMode} is limited to LADDER_SIZE_SCALE=1 through 6`,
    );
  }
  if (
    config.exchange === "polymarket" &&
    config.strategyMode !== "reverse" &&
    (config.marketSlugPrefixes.length !== 1 ||
      config.marketSlugPrefixes[0] !== "btc-updown-15m")
  ) {
    throw new Error(
      "Non-reverse Polymarket strategies only support MARKET_SLUG_PREFIXES=btc-updown-15m",
    );
  }
  if (
    config.exchange === "kalshi" &&
    config.strategyMode === "odahoa_static_maker" &&
    (config.kalshiSeriesTickers.length !== 1 ||
      config.kalshiSeriesTickers[0] !== "KXBTC15M")
  ) {
    throw new Error(
      "odahoa_static_maker only supports CRYPTO_MARKETS=KXBTC15M",
    );
  }
  if (
    config.strategyMode === "odahoa_static_maker" &&
    config.executionMode !== "paper"
  ) {
    throw new Error(
      "odahoa_static_maker is paper-only until the paired experiment is reviewed",
    );
  }
  if (
    config.strategyMode === "ladder_v5" &&
    config.executionMode !== "paper" &&
    !(
      config.exchange === "kalshi" &&
      config.executionMode === "live"
    )
  ) {
    throw new Error(
      "ladder_v5 supports paper mode on either venue and live mode on Kalshi",
    );
  }
  if (
    config.strategyMode === "ladder_v5.5" &&
    (config.exchange !== "kalshi" ||
      (config.executionMode !== "paper" && config.executionMode !== "live"))
  ) {
    throw new Error(
      "ladder_v5.5 supports Kalshi paper and live modes only",
    );
  }
  if (
    config.strategyMode === "ladder_v6" &&
    config.executionMode !== "paper"
  ) {
    throw new Error(
      "ladder_v6 is paper-only until its fill-driven FOK results are reviewed",
    );
  }
  if (
    config.strategyMode === "ladder_v7" &&
    (config.exchange !== "kalshi" || config.executionMode !== "paper")
  ) {
    throw new Error(
      "ladder_v7 is Kalshi paper-only until its asymmetric execution is forward-tested",
    );
  }
  if (
    config.strategyMode === "ladder_v8" &&
    (config.exchange !== "polymarket" || config.executionMode !== "paper")
  ) {
    throw new Error(
      "ladder_v8 is Polymarket paper-only until its Odahoa-sized maker grid is forward-tested",
    );
  }
  if (!Number.isInteger(config.signatureType) || config.signatureType < 0 || config.signatureType > 3) {
    throw new Error("SIGNATURE_TYPE must be one of 0, 1, 2, or 3");
  }

  if (config.exchange === "polymarket") {
    if (config.chainId !== 137) {
      throw new Error("CHAIN_ID must be 137 for Polygon mainnet");
    }
    const clobUrl = new URL(config.clobHost);
    const gammaUrl = new URL(config.gammaApiHost);
    if (clobUrl.protocol !== "https:" || clobUrl.hostname !== "clob.polymarket.com") {
      throw new Error("CLOB_HOST must be https://clob.polymarket.com");
    }
    if (gammaUrl.protocol !== "https:" || gammaUrl.hostname !== "gamma-api.polymarket.com") {
      throw new Error("GAMMA_API_HOST must be https://gamma-api.polymarket.com");
    }
  } else {
    const apiUrl = new URL(config.kalshiApiHost);
    const wsUrl = new URL(config.kalshiWsHost);
    const allowedApiHosts = new Set([
      "external-api.kalshi.com",
      "external-api.demo.kalshi.co",
    ]);
    const allowedWsHosts = new Set([
      "external-api-ws.kalshi.com",
      "external-api-ws.demo.kalshi.co",
    ]);
    if (
      apiUrl.protocol !== "https:" ||
      !allowedApiHosts.has(apiUrl.hostname) ||
      !apiUrl.pathname.endsWith("/trade-api/v2")
    ) {
      throw new Error(
        "KALSHI_API_HOST must be an official production or demo /trade-api/v2 endpoint",
      );
    }
    if (
      wsUrl.protocol !== "wss:" ||
      !allowedWsHosts.has(wsUrl.hostname) ||
      !wsUrl.pathname.endsWith("/trade-api/ws/v2")
    ) {
      throw new Error(
        "KALSHI_WS_HOST must be an official production or demo /trade-api/ws/v2 endpoint",
      );
    }
    if (config.kalshiSeriesTickers.length === 0) {
      throw new Error("CRYPTO_MARKETS must contain at least one series");
    }
    for (const series of config.kalshiSeriesTickers) {
      if (!/^KX[A-Z0-9]+15M$/.test(series)) {
        throw new Error(
          `Invalid Kalshi crypto series "${series}"; expected KX<ASSET>15M`,
        );
      }
    }
    if (
      !Number.isInteger(config.kalshiSubaccount) ||
      config.kalshiSubaccount < 0 ||
      config.kalshiSubaccount > 63
    ) {
      throw new Error("KALSHI_SUBACCOUNT must be an integer from 0 through 63");
    }
    for (const [name, value] of [
      ["KALSHI_TAKER_FEE_RATE", config.kalshiTakerFeeRate],
      ["KALSHI_MAKER_FEE_RATE", config.kalshiMakerFeeRate],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new Error(`${name} must be at least 0 and less than 1`);
      }
    }
    for (const [series, rates] of Object.entries(
      config.kalshiFeeOverrides,
    )) {
      if (!/^KX[A-Z0-9]+15M$/.test(series)) {
        throw new Error(
          `Invalid KALSHI_FEE_OVERRIDES series "${series}"`,
        );
      }
      for (const [name, value] of [
        ["taker", rates.takerRate],
        ["maker", rates.makerRate],
      ] as const) {
        if (!Number.isFinite(value) || value < 0 || value >= 1) {
          throw new Error(
            `KALSHI_FEE_OVERRIDES ${series} ${name} rate must be at least 0 and less than 1`,
          );
        }
      }
    }
    const hasKeyId = Boolean(config.kalshiApiKeyId);
    const hasPrivateKey = Boolean(config.kalshiPrivateKeyPem);
    if (hasKeyId !== hasPrivateKey) {
      throw new Error(
        "KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY must be set together",
      );
    }
    if (config.executionMode !== "dry_run" && (!hasKeyId || !hasPrivateKey)) {
      throw new Error(
        "Kalshi paper/live mode requires KALSHI_API_KEY_ID and a private key because its WebSocket requires authentication",
      );
    }
  }

  if (config.executionMode !== "live") return;

  if (
    config.strategyMode === "odahoa_ladder" ||
    config.strategyMode === "odahoa_ladder_2"
  ) {
    const projectedExposure = projectedLadderCapital(
      config.ladderSizeScale,
      new Map(),
      config.ladderPreset,
    );
    if (projectedExposure > config.ladderMaxUsdcPerMarket) {
      throw new Error(
        `Ladder projected exposure $${projectedExposure.toFixed(2)} exceeds ` +
          `LADDER_MAX_USDC_PER_MARKET=$${config.ladderMaxUsdcPerMarket.toFixed(2)}`,
      );
    }
  }
  if (
    config.strategyMode === "odahoa_ladder" ||
    config.strategyMode === "odahoa_ladder_2" ||
    config.strategyMode === "ladder_v5" ||
    config.strategyMode === "ladder_v5.5"
  ) {
    if (
      config.ladderLiveAck !==
      "I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY"
    ) {
      throw new Error(
        "Live ladder mode is locked. Set LADDER_LIVE_ACK=I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY only after paper verification.",
      );
    }
  }

  if (config.exchange === "kalshi") {
    if (config.liveTradingAck !== "I_UNDERSTAND_REAL_MONEY_IS_AT_RISK") {
      throw new Error(
        "Live trading is locked. Set LIVE_TRADING_ACK=I_UNDERSTAND_REAL_MONEY_IS_AT_RISK only after completing paper verification.",
      );
    }
    return;
  }

  const providedApiCreds = [
    config.clobApiKey,
    config.clobSecret,
    config.clobPassphrase,
  ].filter((value) => value !== undefined && value !== "").length;
  if (providedApiCreds !== 0 && providedApiCreds !== 3) {
    throw new Error(
      "CLOB_API_KEY, CLOB_SECRET, and CLOB_PASSPHRASE must either all be set or all be omitted",
    );
  }

  if (config.liveTradingAck !== "I_UNDERSTAND_REAL_MONEY_IS_AT_RISK") {
    throw new Error(
      "Live trading is locked. Set LIVE_TRADING_ACK=I_UNDERSTAND_REAL_MONEY_IS_AT_RISK only after completing dry-run verification.",
    );
  }

  if (!config.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex private key when DRY_RUN=false");
  }
  if (!config.funderAddress || !/^0x[0-9a-fA-F]{40}$/.test(config.funderAddress)) {
    throw new Error(
      config.signatureType === 3
        ? "Type 3 requires FUNDER_ADDRESS to be the deployed 20-byte Polymarket deposit wallet address"
        : "FUNDER_ADDRESS must be a 20-byte hex address when DRY_RUN=false",
    );
  }

}
