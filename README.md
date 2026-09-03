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

### `ladder_v12`

A scored, cheap-first BTC strategy that recalculates V10's BRTI oscillation score from five through two minutes remaining. The score targets 0, 20, or 40 cheap-side shares at a fixed 10-cent post-only price.

The opposite outcome is ordered only after cheap shares fill. Each completion is an exact-size FOK constrained by visible depth and a fee-adjusted all-in pair-cost cap of `0.95`. V12 revalidates the BRTI state, outcome roles, inventory, completion price, and depth immediately before execution, and never lets either side exceed 40 shares.

Implementation:

- `src/ladder-v12.ts`
- `src/ladder-v12-regime.ts`

### `ladder_v13`

A BTC-specific, direction-agnostic Kalshi pair-arbitrage market maker. V13 enumerates passive YES/NO price combinations from the actual best bids, applies Kalshi's centicent and cent-alignment fee rounding, and selects the highest expected profit rate among combinations with strictly positive pair profit. A cold start chooses the most aggressive profitable pair. Both opening legs are planned from one frozen book and sent through Kalshi's V2 batch-order endpoint.

Quotes are sticky: queue position is retained through small book or microprice changes and replaced only for a material economic improvement or when the pair-safe price envelope is no longer profitable. Opening fill learning is per resting order using queue ahead, tick distance, eligible market-order volume, exposure time, and censored cancellations. Confirmed one-sided fills enter residual management: V13 evaluates profitable FOK completion, maker completion, and (during the final five minutes) selling the surplus.

V13 hunts pairs throughout the full 15-minute market and completed pairs immediately free the strategy to begin another cycle. It has no 40/10/5 lifetime or time-bucket contract limits, no final-minute entry ban, and no generic ladder per-market capital cap; available account cash remains the hard funding constraint. It does not initialize or consult any BRTI direction engine.

Residual liquidation never sells matched inventory: the maximum sale is `abs(YES - NO)`, rechecked inside both paper and live executors. The planner compares exact bid-depth proceeds after SELL fees with the value of an immediate profitable pair and the expected value of waiting. Entry cost is sunk for sell-versus-wait valuation; it still constrains which completions are profitable. Competing V13 orders are cancelled first. Live cancellation acknowledgements and expected fills must reconcile to the fill ledger before a sale; that barrier survives restarts. Exits use FAK/IOC limits, allow partial bid depth, and re-evaluate the remaining inventory.

- At 5:00 remaining, activate the EV comparison. Sell everything if sale value exceeds even optimistic waiting value, nothing if waiting is better, or a proportional slice between those bounds. Fractional sales are limited to one slice per market evaluation.
- At 3:00, prefer liquidation unless an existing maker has strong, mature completion evidence, enough observed flow to clear its queue, and higher waiting EV.
- At 0:30, permit only an immediately profitable FOK completion or a residual sale. Missing bid liquidity is reported as `residual-sale-no-bid-depth` and retried on subsequent updates; the strategy cannot guarantee an exit from an empty book.

A separate completion-only hazard model pools normalized queue/flow, price distance, size, residual age, time remaining, and profitable-price headroom across BTC contracts (no unique-token matching). Fully filled completion orders are events; cancelled orders, including partial fills, contribute censored exposure. Placement contexts and active residual episodes persist in the existing history store; existing opening observations are preserved. Startup completion probabilities and upper bounds use the supplied clean-cohort time table, with Beta(2,2)-smoothed terminal fallback values of `4/23` for entirely one-sided inventory and `12/36` when some shares are paired. These are priors, not a profitability guarantee. Empirical caps stay in place until a comparable group has at least 100 orders, 20 complete fills, and 3,600 exposure seconds; hazard shrinkage uses 120 prior seconds and a conservative one-sided 95% Gamma-posterior bound.

Implementation:

- `src/ladder-v13.ts`
- `src/ladder-v13-history.ts`
- `.env.ladder-v13-paper.example`

### `ladder_v14`

V14 is a Kalshi 15-minute crypto pair-collection and inventory-learning engine.
It can run BTC, ETH, SOL, or any other configured `KX<ASSET>15M` series.

V14 currently defaults to bootstrap collection mode with
`LADDER_V14_VOLUME_FIRST_MODE=true`. In this mode the statistical engine runs
in shadow: it records fill, completion, and failed-exit behavior but does not
gate entries. The live quote policy posts up to four paired, near-touch maker
levels. Their default sizes are 40, 80, 160, and 320 shares, and their combined
raw prices target 99c, 97c, 95c, and 93c. The exact split between Up and Down is
chosen to keep both quotes as close to their respective touches as possible.

Balanced inventory runs that same grid with no additional entry filters.
As soon as `R = abs(YES - NO) > 0`, V14 cancels **all** ordinary opening orders
on both sides, waits for cancellation reconciliation, and recomputes R. It
then buys only the missing side, with no base quantity added and no surplus
orders or additional grid levels during repair.

If buying the missing quantity now locks a positive pair after entry and
taker fees, V14 takes it immediately. Otherwise it posts one repair maker for
exactly R at the most aggressive valid post-only price. The existing
`LADDER_V14_QUOTE_LIFETIME_SECONDS` (default five seconds) is the repair deadline
from the first unpaired fill, including cancellation time; partial fills,
repricing, and restarts do not reset it. A timer wakes repair even on a quiet
book. At the deadline it cancels the maker and compares executable
`1 - opposite all-in ask` with `surplus net bid`, choosing the greater value
(hedge on a tie), even if hedging locks a loss. Entry cost is sunk in this
timeout decision. Partial depth/fills are handled by replanning the actual
remaining quantity after each acknowledgment.

When R returns to zero, normal volume-first quoting resumes immediately.
During the final cleanup window no new grids or maker waits start; remaining
residuals use the same hedge-versus-sale comparison. These rules reduce
intentional surplus accumulation, but cannot guarantee fills, profitability,
or complete cleanup when executable liquidity is absent. Strict EV mode below
is unchanged.

Set `LADDER_V14_VOLUME_FIRST_MODE=false` to enable the stricter marginal-EV
entry and residual optimizer. For every passive price and economically distinct
quantity breakpoint that optimizer estimates the conditional lifecycle value

```text
P(fill) * [P(pair) * (1 - entry - E[opposite cost | pair])
           + (1 - P(pair)) * (E[net exit | failed pair] - entry)]
```

Only positive posterior-mean marginal segments are selected. Deeper layers are
evaluated as if all more-aggressive layers filled in one sweep. The planner
maintains at most one aggregate order at each market/outcome/price and amends
that order when its optimal quantity changes. Quantity comes from actual book,
queue, flow, fee, completion, recovery, and inventory breakpoints; there is no
fixed 20-share size or strategy-level contract cap. Every cumulative quantity
must add strictly positive marginal EV. A flow-and-queue reachability horizon
prevents unlimited paper capital from producing physically unreachable sizes.

Zero modeled flow can produce exactly zero fill probability. Until qualifying
flow is observed, cold start converts a configurable fraction of displayed
touch depth into conservative pseudo-flow and then applies
`flow / (queue + alpha * quantity)` plus a distance penalty. Opening fills use
a configurable quote lifetime (five seconds by default), not the entire time
left in the market. Only selected, simultaneously resting aggressive levels
enter deeper-layer sweep exposure.

In strict EV mode, a one-sided fill stops ordinary opening accumulation and V14
compares marginal `hedge`, `sell`, and `wait` value on every update. A hedge may
deliberately make the accounting pair cost exceed $1 when it preserves more
value than selling or waiting.

The learner stores indexed conditional sufficient statistics, so the trading
hot path performs no history scan or disk read. Completion prices are learned
only from successful completions, while exit recovery is learned only from
failed-completion residual sales. Series and paper/live observations remain
separate; live mode can use paper data only as a weak prior capped at five
equivalent observations. Cold start otherwise uses general queue/flow and
current-book analytical formulas rather than copying V13's unconditional BTC
or ETH pairing rates.

Paper mode sets `capitalConstraint=false`: normal cash never becomes negative,
while theoretical cash, gross deployment, marked inventory, and realized and
unrealized P&L remain explicit metrics. One global acknowledgement-driven
allocator places the most aggressive bootstrap levels first. In strict EV mode
the allocator instead ranks positive segments by expected profit per
capital-exposure second.

Implementation:

- `src/ladder-v14.ts`
- `src/ladder-v14-model.ts`
- `src/ladder-v14-history.ts`
- `src/ladder-v14-inventory.ts`
- `.env.ladder-v14-paper.example`

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

RAM is the active trading state. Book updates, maker fills, positions, and strategy
wakes do not await disk writes. Dirty state is checkpointed to `paper-state.json`
under `PAPER_STATE_PATH` every five seconds; a quiet account is not rewritten.
Changes arriving during a checkpoint remain dirty for the next one, and a failed
write is retried at the next interval.

`paper-events.jsonl` uses one buffered, append-only stream for submitted, amended,
and cancelled orders, fills, settlements, stale trades, and errors. V14 paper
evaluation/candidate/status messages are suppressed. One `health` record every
30 seconds reports `processingLagMs`, `averageLag`, `maxLag` (milliseconds),
`openOrders`, `fillsProcessed`, `eventsProcessed`, `staleEventsSkipped`,
`logQueueSize` (pending records), and `stateDirty`. Lag averages/maxima reset each
report; event/fill/stale counters cover the current process lifetime.

Trades more than 1,000 ms old by their exchange timestamp cannot generate maker
fills or consume queue position. The normal operating target is processing lag
below 100 ms, with essentially no events above one second.

Settlement flushes the event log and saves immediately, lets strategy history
consume the settled fills, then removes the market's orders, fills, positions,
and fee accumulators and saves the compact checkpoint. Settlement summaries and
active markets remain. Older checkpoints are compacted on startup too. Detailed
history lives in the append-only log, which is no longer automatically rotated
or deleted by the paper trader.

Manual stop, SIGINT/SIGTERM, and fatal-error shutdown drain pending work, flush the
log stream, and save a final checkpoint. An abrupt kill or power loss can lose
changes since the last checkpoint; the event log is historical output and is not
automatically replayed into the checkpoint on startup.

Each concurrently running strategy should use its own state directory.

## Market data and event-driven execution

The bot does not rely only on slow polling.

The market stream classes maintain live order-book information, while execution backends can wake a strategy when an important event occurs. A fill or book update can therefore cause the relevant market to be reevaluated immediately.

Per-market promise queues in `ReverseBot` serialize those updates so multiple events for the same market cannot execute strategy logic simultaneously.

V14 uses a single global acknowledgement-driven queue instead, because live
cash allocation and marginal order ranking span every active configured market.

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
.env.ladder-v12-paper.example
.env.ladder-v14-paper.example
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
- ladder strategies V5 through V12
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
├── ladder-v12.ts             V12 strategy planner
├── ladder-v12-regime.ts      V12 regime engine
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
