import "dotenv/config";
import { projectedLadderCapital } from "./ladder.js";
import type { ExecutionMode, LadderPreset, StrategyMode } from "./types.js";

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

export interface BotConfig {
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
  ladderPreset: LadderPreset;
  ladderSizeScale: number;
  ladderLiveMaxUsdcPerMarket: number;
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
  paperStartingUsdc: number;
  paperStatePath: string;
}

export function loadConfig(): BotConfig {
  const strategyRaw = envString("STRATEGY_MODE", "reverse");
  if (
    strategyRaw !== "reverse" &&
    strategyRaw !== "odahoa_ladder" &&
    strategyRaw !== "odahoa_ladder_2" &&
    strategyRaw !== "odahoa_static_maker" &&
    strategyRaw !== "ladder_v5" &&
    strategyRaw !== "ladder_v6"
  ) {
    throw new Error(
      "STRATEGY_MODE must be reverse, odahoa_ladder, odahoa_ladder_2, odahoa_static_maker, ladder_v5, or ladder_v6",
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
    ladderPreset: ladderPreset as LadderPreset,
    ladderSizeScale: envNumber("LADDER_SIZE_SCALE", 1),
    ladderLiveMaxUsdcPerMarket: envNumber("LADDER_LIVE_MAX_USDC_PER_MARKET", 65),
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
    paperStartingUsdc: envNumber("PAPER_STARTING_USDC", 100),
    paperStatePath: envString("PAPER_STATE_PATH", "./data/paper"),
  };
}

export function validateTradingConfig(config: BotConfig): void {
  if (!Number.isInteger(config.ladderSizeScale) || config.ladderSizeScale < 1) {
    throw new Error("LADDER_SIZE_SCALE must be an integer of at least 1");
  }
  if (!Number.isFinite(config.ladderLiveMaxUsdcPerMarket) || config.ladderLiveMaxUsdcPerMarket <= 0) {
    throw new Error("LADDER_LIVE_MAX_USDC_PER_MARKET must be greater than 0");
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
    config.strategyMode === "ladder_v5" &&
    config.ladderSizeScale > 6
  ) {
    throw new Error(
      "ladder_v5 is limited to LADDER_SIZE_SCALE=1 through 6 during paper validation",
    );
  }
  if (
    config.strategyMode !== "reverse" &&
    (config.marketSlugPrefixes.length !== 1 ||
      config.marketSlugPrefixes[0] !== "btc-updown-15m")
  ) {
    throw new Error(
      "Non-reverse strategies only support MARKET_SLUG_PREFIXES=btc-updown-15m",
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
    config.executionMode !== "paper"
  ) {
    throw new Error(
      "ladder_v5 is paper-only until its forward results are reviewed",
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
  if (!Number.isInteger(config.signatureType) || config.signatureType < 0 || config.signatureType > 3) {
    throw new Error("SIGNATURE_TYPE must be one of 0, 1, 2, or 3");
  }

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
    if (projectedExposure > config.ladderLiveMaxUsdcPerMarket) {
      throw new Error(
        `Ladder projected exposure $${projectedExposure.toFixed(2)} exceeds ` +
          `LADDER_LIVE_MAX_USDC_PER_MARKET=$${config.ladderLiveMaxUsdcPerMarket.toFixed(2)}`,
      );
    }
    if (
      config.ladderLiveAck !==
      "I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY"
    ) {
      throw new Error(
        "Live ladder mode is locked. Set LADDER_LIVE_ACK=I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY only after paper verification.",
      );
    }
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
