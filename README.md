# Polymarket / Kalshi Crypto Trading Bot

A TypeScript trading system for short-duration binary crypto markets on Polymarket and Kalshi. The codebase handles market discovery, normalized order books, strategy execution, live and paper trading, position tracking, fee-aware order planning, WebSocket market data, and multiple generations of ladder strategies.

I originally forked this repository to use the existing project as a base, then built substantially on top of it by adding the multi-exchange architecture, Kalshi integration, paper execution engine, market streaming, strategy framework, ladder variants, regime logic, reporting, state management, and expanded test suite.

## What the program does

The bot continuously finds active short-duration Up/Down crypto markets, reads their order books, evaluates the selected strategy, and routes resulting orders through a common execution interface.

The same strategy layer can operate against different execution backends:

- `dry_run` logs intended trades without simulating fills or placing orders.
- `paper` uses a fill-aware simulator with persistent state.
- `live` sends real orders to the selected exchange.

The main runtime flow is:

```text
Environment configuration
        ↓
Market discovery / streaming
        ↓
Normalized Up/Down market + order books
        ↓
Strategy planner
        ↓
Trade opportunities / order instructions
        ↓
PaperTrader | Polymarket Trader | KalshiTrader
        ↓
Order updates, fills, state, telemetry, settlement
```

## Core architecture

### `src/index.ts`

Application entry point.

It loads and validates configuration, selects the appropriate execution backend, creates the bot, initializes persistent state and exchange connections, then starts the trading loop.

```text
loadConfig()
   ↓
validateTradingConfig()
   ↓
PaperTrader / Trader / KalshiTrader
   ↓
ReverseBot
   ↓
init() → run()
```

### `src/bot.ts`

The central coordinator for the application.

`ReverseBot` connects the market scanner, strategies, execution engine, fill callbacks, market queues, ladder state, and regime engines. It is responsible for keeping each market isolated while allowing multiple markets to run concurrently.

The bot supports strategy-specific execution queues so order-book updates and fills can immediately wake the relevant market without allowing overlapping strategy passes to corrupt state.

It also handles:

- market polling
- strategy dispatch
- per-market execution queues
- fill-triggered strategy reevaluation
- settlement callbacks
- persistent ladder state
- market telemetry
- V10 and V11 regime engines
- capital limits per market

## Exchange abstraction

The code normalizes both exchanges into the same internal market structures.

`UpDownEvent` represents a binary market window and `TokenBook` represents one outcome's order book. Strategies operate on those normalized types instead of containing exchange-specific API logic.

### Polymarket

`src/market-scanner.ts`

Discovers eligible Polymarket markets through the Gamma API and converts them into the internal Up/Down event format.

`src/market-stream.ts`

Maintains WebSocket order-book data for Polymarket markets.

`src/trader.ts`

Handles Polymarket CLOB authentication and live order placement using `@polymarket/clob-client-v2`.

### Kalshi

`src/kalshi-api.ts`

Implements Kalshi REST authentication and API requests.

`src/kalshi-market-stream.ts`

Maintains live Kalshi market data and converts Kalshi YES/NO books into the same normalized structure used by the strategy layer.

`src/kalshi-trader.ts`

Handles Kalshi order placement, order state, fills, fees, settlement events, and execution callbacks.

The exchange is selected with:

```env
EXCHANGE=polymarket
```

or:

```env
EXCHANGE=kalshi
```

## Strategy system

Strategies are selected with `STRATEGY_MODE`.

The repository contains the original reversal concept plus several generations of complementary-outcome ladder strategies. Later versions increasingly focus on fill management, inventory imbalance, pair cost, maker/taker execution, rescue behavior, and market-regime filtering.

### `reverse`

The original reversal strategy.

It looks for inexpensive underdog contracts inside a configured price range and can optionally purchase the opposite favorite outcome as a hedge.

Relevant implementation:

- `src/strategy.ts`
- `src/bot.ts`

### `odahoa_static_maker`

Places early two-sided maker liquidity rather than waiting for a later directional setup.

Implementation:

- `src/static-maker.ts`

### `odahoa_ladder`

A timed complementary ladder. Orders are distributed through predefined phases during the market window.

Implementation:

- `src/ladder.ts`

### `odahoa_ladder_2`

Inventory-aware pair locking.

Instead of treating each order independently, the strategy tracks fills on one side and attempts to complete the opposite side while keeping the combined pair cost below a configured threshold.

Implementation:

- `src/pair-lock.ts`

### `ladder_v5`

Adds explicit inventory-imbalance controls and pair-cost limits to the ladder model.

Implementation:

- `src/ladder-v5.ts`

### `ladder_v5.5`

Moves toward fill-driven execution. Cheap entries are managed dynamically and confirmed fills can trigger immediate FOK hedge attempts.

Implementation:

- `src/ladder-v5-5.ts`

### `ladder_v6`

Uses competitive paired maker orders with maker or FOK completion logic. It adds controls for unmatched inventory, minimum net edge, safety buffers, and rescue losses.

Implementation:

- `src/ladder-v6.ts`

### `ladder_v7`

A simpler asymmetric structure built around a fixed cheap maker entry and a capped favorite-side purchase.

Implementation:

- `src/ladder-v7.ts`

### `ladder_v8`

Runs a larger complementary post-only maker grid across the market phases while enforcing unmatched-share limits.

Implementation:

- `src/ladder-v8.ts`

### `ladder_v9`

A staged, fill-aware lifecycle.

It starts cheap-side inventory first, progressively completes the complementary side, retries completion when needed, and contains rescue and emergency pair-cost limits near market close.

Implementation:

- `src/ladder-v9.ts`

### `ladder_v10`

Adds a market-regime layer around the V7-style structure.

The strategy combines exchange market telemetry with an external BTC price stream, maintains regime state, scores market conditions, and gates entries based on the resulting regime classification.

Implementation:

- `src/ladder-v10.ts`
- `src/ladder-v10-regime.ts`
- `src/regime-price-stream.ts`
- `src/ladder-v10-report.ts`

### `ladder_v11`

A more constrained BTC-specific regime strategy designed around low-reversal market conditions and a fixed binary ladder structure.

It keeps a rolling market decision state, observes price behavior before the entry period, and uses regime decisions to determine whether the strategy should participate in a market.

Implementation:

- `src/ladder-v11.ts`
- `src/ladder-v11-regime.ts`
- `src/ladder-v11-report.ts`

## Paper trading engine

`src/paper-trader.ts` is a full execution backend rather than a simple log-only mock.

It is designed to let the strategy code operate through the same `OrderExecutor` interface used for live trading while simulating exchange behavior.

The paper engine tracks items such as:

- submitted orders
- fills
- available capital
- positions
- per-market exposure
- maker and taker behavior
- order cancellation
- fees
- settlement
- persistent state
- execution callbacks

State is written under the configured `PAPER_STATE_PATH`, allowing a bot to restart without losing its simulated portfolio.

Each concurrently running strategy should use its own state directory.

## Market data and event-driven execution

The bot does not rely only on slow polling.

The market stream classes maintain live order-book information, while execution backends can wake a strategy when an important event occurs. A fill or book update can therefore cause the relevant market to be reevaluated immediately.

Per-market promise queues in `ReverseBot` serialize those updates so multiple events for the same market cannot execute strategy logic simultaneously.

This is especially important for ladder strategies where the next order depends on the exact quantity and price of previous fills.

## Risk and order controls

The system includes several layers of execution controls rather than allowing strategies to submit arbitrary orders directly.

Examples include:

- maximum USDC allocation per market
- maximum shares per order
- inventory imbalance limits
- pair-cost limits
- minimum locked edge
- maker/taker fee handling
- rescue-loss limits
- market-close cutoffs
- price and size validation
- explicit live-trading acknowledgements
- separate paper and live modes

Shared order validation lives in:

- `src/utils/order-validation.ts`

Price utilities live in:

- `src/utils/prices.ts`

## Configuration

Configuration is environment driven and parsed in `src/config.ts`.

The primary file to start from is:

```bash
.env.example
```

There are also strategy-specific examples such as:

```text
.env.ladder-v5-paper.example
.env.ladder-v5-5-paper.example
.env.ladder-v6-paper.example
.env.ladder-v7-paper.example
.env.ladder-v8-paper.example
.env.ladder-v9-paper.example
.env.ladder-v10-paper.example
.env.ladder-v11-paper.example
.env.kalshi-paper.example
```

Core selectors:

```env
EXCHANGE=kalshi
STRATEGY_MODE=ladder_v11
EXECUTION_MODE=paper
```

For Kalshi, markets are selected through `CRYPTO_MARKETS`:

```env
CRYPTO_MARKETS=KXBTC15M,KXETH15M,KXSOL15M
```

For Polymarket, market discovery uses slug prefixes:

```env
MARKET_SLUG_PREFIXES=btc-updown-15m,eth-updown-15m
```

Never commit a populated `.env` file or private exchange credentials.

## Running the project

Requirements:

- Node.js
- npm
- exchange credentials for authenticated or live operation

Install dependencies:

```bash
npm install
```

Create an environment file:

```bash
cp .env.example .env
```

Start the bot:

```bash
npm start
```

Development mode with automatic restart:

```bash
npm run dev
```

Compile TypeScript:

```bash
npm run build
```

## Testing

The repository includes tests for the execution and strategy layers rather than only basic unit tests.

Coverage includes:

- configuration validation
- concurrent markets
- Polymarket market streams
- Kalshi integration behavior
- paper execution
- live trader behavior
- order validation
- pair locking
- static maker logic
- ladder strategies V5 through V11
- multi-market strategy behavior
- regression tests for the original reversal strategy
- rotating JSONL storage
- strategy comparison tooling

Run the suite with:

```bash
npm test
```

Run the full build, test, and dependency audit check:

```bash
npm run check
```

## Strategy analysis and reporting

The codebase also contains tools for comparing strategies and analyzing later ladder versions.

```bash
npm run compare:strategies
npm run report:ladder-v10
npm run report:ladder-v11
```

`src/strategy-comparison.ts` provides shared comparison tooling, while the V10 and V11 report modules analyze their regime and execution records.

Rotating JSONL storage used by telemetry and analysis components is implemented in:

- `src/utils/rotating-jsonl.ts`

## Project structure

```text
src/
├── index.ts                  Application entry point
├── bot.ts                    Main orchestration and strategy dispatch
├── config.ts                 Environment parsing and validation
├── types.ts                  Shared exchange and strategy types
│
├── market-scanner.ts         Polymarket market discovery
├── market-stream.ts          Polymarket streaming data
├── trader.ts                 Polymarket execution
│
├── kalshi-api.ts             Kalshi REST client
├── kalshi-market-stream.ts   Kalshi streaming market data
├── kalshi-trader.ts          Kalshi execution and settlement
│
├── paper-trader.ts           Persistent fill-aware simulator
│
├── strategy.ts               Original reversal strategy
├── static-maker.ts           Static maker strategy
├── ladder.ts                 Base timed ladder framework
├── pair-lock.ts              Complementary inventory locking
├── ladder-v5.ts              V5 strategy
├── ladder-v5-5.ts            V5.5 strategy
├── ladder-v6.ts              V6 strategy
├── ladder-v7.ts              V7 strategy
├── ladder-v8.ts              V8 strategy
├── ladder-v9.ts              V9 strategy
├── ladder-v10.ts             V10 strategy planner
├── ladder-v10-regime.ts      V10 regime engine
├── ladder-v11.ts             V11 strategy planner
├── ladder-v11-regime.ts      V11 regime engine
├── regime-price-stream.ts    External regime price feed
│
├── ladder-v10-report.ts      V10 analysis/reporting
├── ladder-v11-report.ts      V11 analysis/reporting
├── strategy-comparison.ts    Strategy comparison tooling
│
└── utils/
    ├── market.ts
    ├── order-validation.ts
    ├── prices.ts
    └── rotating-jsonl.ts

tests/
└── Strategy, exchange, execution, concurrency, and regression tests
```

## Design goals

The project has evolved around a few core design choices:

1. Keep exchange APIs separate from strategy logic.
2. Normalize Polymarket and Kalshi markets into shared internal types.
3. Make paper and live execution use the same strategy interface.
4. Make later strategies react to actual fills rather than assuming orders execute.
5. Isolate state and execution by market so multiple 15-minute markets can run concurrently.
6. Explicitly model fees, inventory imbalance, pair cost, and end-of-market rescue behavior.
7. Preserve older strategy generations so they can be tested and compared against newer versions.

The result is less a single arbitrage script and more a reusable execution and research framework for testing short-duration binary-market strategies across multiple exchanges.

## Disclaimer

This repository is experimental trading software. Paper results do not guarantee live execution or profitability. Exchange rules, fee schedules, APIs, market mechanics, and availability can change. Use live trading only after reviewing the strategy, configuration, and exchange-specific behavior yourself.
