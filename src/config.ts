import "dotenv/config";
import type { ExecutionMode, StrategyMode } from "./types.js";

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
  ladderPreset: "odahoa_v1";
  ladderSizeScale: number;
  ladderLiveMaxUsdcPerMarket: number;
  ladderLiveAck?: string;
  paperStartingUsdc: number;
  paperStatePath: string;
}

export function loadConfig(): BotConfig {
  const strategyRaw = envString("STRATEGY_MODE", "reverse");
  if (strategyRaw !== "reverse" && strategyRaw !== "odahoa_ladder") {
    throw new Error("STRATEGY_MODE must be reverse or odahoa_ladder");
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
    ladderPreset,
    ladderSizeScale: envNumber("LADDER_SIZE_SCALE", 1),
    ladderLiveMaxUsdcPerMarket: envNumber("LADDER_LIVE_MAX_USDC_PER_MARKET", 65),
    ladderLiveAck: process.env.LADDER_LIVE_ACK,
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
    config.strategyMode === "odahoa_ladder" &&
    (config.marketSlugPrefixes.length !== 1 ||
      config.marketSlugPrefixes[0] !== "btc-updown-15m")
  ) {
    throw new Error(
      "odahoa_ladder v1 only supports MARKET_SLUG_PREFIXES=btc-updown-15m",
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

  if (config.strategyMode === "odahoa_ladder") {
    const projectedScaleOneExposure = 56.6;
    const projectedExposure = projectedScaleOneExposure * config.ladderSizeScale;
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
