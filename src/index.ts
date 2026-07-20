import { ReverseBot } from "./bot.js";
import { loadConfig, validateTradingConfig } from "./config.js";
import { logError } from "./logger.js";
import { PaperTrader } from "./paper-trader.js";
import { Trader } from "./trader.js";

async function main(): Promise<void> {
  const config = loadConfig();
  validateTradingConfig(config);

  const executor =
    config.executionMode === "paper"
      ? new PaperTrader(config)
      : new Trader(config);
  const bot = new ReverseBot(config, executor);
  await bot.init();
  await bot.run();
}

main().catch((error) => {
  logError(error);
  process.exit(1);
});
