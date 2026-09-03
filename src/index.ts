import { ReverseBot } from "./bot.js";
import { loadConfig, validateTradingConfig } from "./config.js";
import { logError } from "./logger.js";
import { KalshiTrader } from "./kalshi-trader.js";
import { PaperTrader } from "./paper-trader.js";
import { Trader } from "./trader.js";

async function main(): Promise<void> {
  const config = loadConfig();
  validateTradingConfig(config);

  const executor =
    config.executionMode === "paper"
      ? new PaperTrader(config)
      : config.exchange === "kalshi"
        ? new KalshiTrader(config)
      : new Trader(config);
  const bot = new ReverseBot(config, executor);
  let shutdown: Promise<void> | undefined;
  const stop = (error?: unknown): Promise<void> => {
    if (error !== undefined) logError(error);
    shutdown ??= bot.stop();
    return shutdown;
  };
  const exitAfterSave = (code: number, error?: unknown): void => {
    void stop(error).then(
      () => process.exit(code),
      (saveError) => { logError(saveError); process.exit(1); },
    );
  };
  process.once("SIGINT", () => exitAfterSave(0));
  process.once("SIGTERM", () => exitAfterSave(0));
  process.once("uncaughtException", (error) => exitAfterSave(1, error));
  process.once("unhandledRejection", (error) => exitAfterSave(1, error));
  try {
    await bot.init();
    await bot.run();
  } catch (error) {
    await stop(error);
    throw error;
  }
}

main().catch((error) => {
  logError(error);
  process.exit(1);
});
