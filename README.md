# Polymarket / Kalshi Reverse Arbitrage Bot

TypeScript automation for the reverse and paired-ladder strategies on binary
crypto markets. Set `EXCHANGE=polymarket` or `EXCHANGE=kalshi`; the strategy
layer consumes the same normalized Up/Down books on either venue.

---

## My Polymarket account
<img width="815" height="291" alt="image" src="https://github.com/user-attachments/assets/0971eb6d-de7e-4f9a-82a1-14a2163db209" />


| | |
|---|---|
| **Profile** | [@odahoa](https://polymarket.com/@odahoa?tab=activity) |
| **Username** | `odahoa` |
| **Proxy wallet** | `0xe2511c9e41c5e762887e538b1d6e7221807aa237` |
| **Markets** | `btc-updown-15m`, `eth-updown-15m` |

All activity, positions, and PnL live on my profile:  
**https://polymarket.com/@odahoa?tab=activity**

This bot trades **from that account** — it automates what I already do manually. It is not copy trading and does not watch any other wallet.

---

## Overview

Polymarket runs 15-minute windows like:

> **Bitcoin Up or Down — 1:45PM–2:00PM ET**

Each window has two tokens:

| Token | Wins when |
|-------|-----------|
| **Up** | Price at end ≥ price at start |
| **Down** | Price at end < price at start |

Winning tokens pay **$1.00**. Losing tokens pay **$0.00**.

My strategy — the **reverse bot** — posts limit **BUY** orders on **both sides** every window:

1. **Cheap reversal side (7–10¢)** on the underdog outcome  
2. **Expensive hedge side (90–95¢)** on the favorite outcome  

Round price levels resembling those visible on the
[@odahoa activity tab](https://polymarket.com/@odahoa?tab=activity) motivated
the optional timed ladder described below. Public fills cannot reveal private
order logic, so the ladder is an approximation rather than a clone.

---

## Why "reverse"?

Early in a window, price often trends one way:

```
BTC pumps in first 10 minutes
  → Up token   ~90–97¢  (favorite)
  → Down token ~3–10¢   (underdog)
```

The crowd prices the underdog as nearly dead. The **reverse bet** is: *it flips before the window closes*.

| Leg | Outcome | Entry | If it wins |
|-----|---------|-------|------------|
| **Reverse** | Underdog | 7–10¢ | ~10–14× |
| **Hedge** | Favorite | 90–95¢ | ~5–11% |

Only one side pays $1 per window. I run both legs because:

- Cheap fills are rare but pay huge when they hit.
- Hedge fills are smaller profit but hit more often.
- Over hundreds of windows, a few reversals cover many losses.

---

## How I trade (manual → bot)

From my account history:

| Pattern | Detail |
|---------|--------|
| Markets | BTC & ETH 15m Up/Down only |
| Order type | Limit BUY only — never sell |
| Cheap leg | Fills at 7–10¢ (sometimes 5–25¢) on underdog |
| Hedge leg | Fills at 90–95¢ on favorite |
| Both sides | Same window — e.g. Down @ 95¢ and Up @ 15¢ |
| Size | 20–90 shares per order |

The bot replaces hand-placing every limit order each window.

---

## Bot logic

Every **5 seconds** (configurable):

```
1. Scan active btc-updown-15m / eth-updown-15m markets
2. Load Up & Down order books (CLOB API)
3. Underdog  = outcome with lower best ask
4. Favorite  = the other outcome
5. Post limit BUYs on underdog  @ 7¢, 8¢, 9¢, 10¢
6. Post limit BUYs on favorite  @ 90¢–95¢  (if hedge enabled)
7. Skip price levels already posted this session
```

### Cheap leg — underdog @ 7–10¢

```
Down best ask = 4¢  →  bot bids 7¢, 8¢, 9¢, 10¢ on Down
```

If Down reverses and wins:

```
90 shares × 8¢  =  $7.20 in
90 shares × $1  =  $90.00 out   →  +$82.80 (~1,150%)
```

### Hedge leg — favorite @ 90–95¢

```
Up best ask = 97¢  →  bot bids 90¢–95¢ on Up
```

If Up holds and wins:

```
52 shares × 95¢  =  $49.40 in
52 shares × $1   =  $52.00 out  →  +$2.60 (~5%)
```

---

## Example window

**Market:** Bitcoin Up or Down — 1:45–2:00 PM ET  
**BTC pumped early** → Up favored, Down cheap

| Token | Book | Bot posts |
|-------|------|-----------|
| Up (favorite) | ask 97¢ | BUY limits @ 90–95¢ |
| Down (underdog) | ask 4¢ | BUY limits @ 7–10¢ |

| Result | Cheap leg | Hedge leg |
|--------|-----------|-----------|
| Up wins | Down → $0 | Up → small profit |
| Down reverses | Down → big profit | Up → $0 |

---

## Return table

| Buy price | Payout | Return if win |
|-----------|--------|---------------|
| 7¢ | $1.00 | +1,329% |
| 8¢ | $1.00 | +1,150% |
| 9¢ | $1.00 | +1,011% |
| 10¢ | $1.00 | +900% |
| 95¢ | $1.00 | +5% |

Most 7–10¢ bets go to zero. Edge comes from occasional reversals at high multiples.

---

## Quick start

```bash
git clone https://github.com/KadamParikhe/polymarket-arbitrage-bot
cd reverse-bot
npm install
cp .env.example .env
npm start          # dry-run: logs orders, no submission
```

### Run the same strategy across Kalshi crypto markets

Choose any supported 15-minute crypto series with `CRYPTO_MARKETS`. The one
selected `STRATEGY_MODE` runs concurrently across every configured series:

```env
CRYPTO_MARKETS=KXADA15M,KXBCH15M,KXBNB15M,KXBTC15M,KXDOGE15M,KXETH15M,KXHYPE15M,KXNEAR15M,KXSOL15M,KXTON15M,KXXRP15M,KXZEC15M
LADDER_MAX_USDC_PER_MARKET=65
```

`CRYPTO_MARKETS` supersedes the legacy `KALSHI_SERIES_TICKERS` variable. The
adapter maps Kalshi YES to Up and NO to Down, reconstructs asks from the
complementary bid book, and preserves the strategy's existing order policies
(`post_only`, IOC/FAK, FOK, and GTC).

```bash
cp .env.kalshi-paper.example .env
# Fill in KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY
npm start
```

The Kalshi market-data WebSocket requires an authenticated handshake even in
paper mode, so paper mode needs a Kalshi API key ID and RSA private key. Public
REST discovery does not. Put the PEM in `KALSHI_PRIVATE_KEY`, surrounded by
double quotes, with literal `\n` between lines:

Kalshi book subscriptions explicitly use unified YES-price semantics. Incoming
messages are processed in order and each update publishes YES and NO books as
one atomic market snapshot. A sequence gap invalidates affected books and
pauses strategy wakes until the stream obtains fresh snapshots. Live Kalshi
execution also consumes `fill` and `user_orders` updates, with REST
reconciliation retained for startup and reconnect recovery.

```env
KALSHI_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Never commit a populated `.env`.

Production endpoints:

```env
KALSHI_API_HOST=https://external-api.kalshi.com/trade-api/v2
KALSHI_WS_HOST=wss://external-api-ws.kalshi.com/trade-api/ws/v2
```

Demo endpoints:

```env
KALSHI_API_HOST=https://external-api.demo.kalshi.co/trade-api/v2
KALSHI_WS_HOST=wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2
```

Kalshi fees can differ by series. `KALSHI_TAKER_FEE_RATE` and
`KALSHI_MAKER_FEE_RATE` are the coefficients in
`contracts × rate × price × (1-price)`. Confirm them against the current fee
disclosure before trusting paper P/L. Defaults are `0.07` taker and `0` maker.
Series-specific overrides use `SERIES:TAKER:MAKER`:

```env
KALSHI_FEE_OVERRIDES=KXBTC15M:0.07:0,KXETH15M:0.07:0
```

All markets share one account balance. New exposure is capped independently
per market, while profitable completion and risk-reducing hedge orders may
finish a pair above the cap when shared cash is available. Five active markets
at the default cap can commit up to `$325`; twelve can commit up to `$780`.

For live Kalshi orders, switch to `EXECUTION_MODE=live` and set:

```env
LIVE_TRADING_ACK=I_UNDERSTAND_REAL_MONEY_IS_AT_RISK
KALSHI_SUBACCOUNT=0
```

Polymarket wallet and CLOB credentials are ignored in Kalshi mode.

### Type 3 (`POLY_1271`) deposit wallet setup

```env
DRY_RUN=true
PRIVATE_KEY=0x...             # owner or approved session-signer key
FUNDER_ADDRESS=0x...          # deployed Polymarket deposit wallet
SIGNATURE_TYPE=3
CLOB_API_KEY=...
CLOB_SECRET=...
CLOB_PASSPHRASE=...
```

| `SIGNATURE_TYPE` | Use for |
|------------------|---------|
| `0` | EOA / MetaMask |
| `1` | Existing Polymarket proxy wallet |
| `2` | Existing Gnosis Safe wallet |
| `3` | POLY_1271 deposit wallet |

Changing only `SIGNATURE_TYPE` is not sufficient for Type 3:

1. `FUNDER_ADDRESS` must be the deployed deposit wallet address that holds the
   trading funds. It is not the owner EOA address.
2. `PRIVATE_KEY` must belong to the deposit wallet owner or an approved session
   signer. A deposit wallet address does not have an exportable private key.
3. The deposit wallet must be funded and its exchange allowance must be set
   through Polymarket's deposit-wallet flow.
4. CLOB API credentials are optional. If all three values are blank, the bot
   calls `createOrDeriveApiKey()` using the configured signer. If supplied,
   all three values must be present.
5. Keep `DRY_RUN=true` until startup, market discovery, and order sizing have
   been verified. Live mode additionally requires:

```env
DRY_RUN=false
LIVE_TRADING_ACK=I_UNDERSTAND_REAL_MONEY_IS_AT_RISK
```

Use a dedicated session signer or dedicated low-balance trading owner. Do not
put the private key for a primary wallet holding unrelated assets into this bot.

---

## Config

### Strategy

| Variable | Default | Description |
|----------|---------|-------------|
| `CHEAP_BUY_MIN` | `0.07` | Low end of reversal bids |
| `CHEAP_BUY_MAX` | `0.10` | High end of reversal bids |
| `CHEAP_ORDER_USDC` | `10` | USDC per cheap limit order |
| `ENABLE_EXPENSIVE_HEDGE` | `true` | Post 90–95¢ favorite bids |
| `EXPENSIVE_BUY_MIN` | `0.90` | Low end of hedge bids |
| `EXPENSIVE_BUY_MAX` | `0.95` | High end of hedge bids |
| `EXPENSIVE_ORDER_USDC` | `50` | USDC per hedge limit order |
| `MAX_SHARES_PER_ORDER` | `90` | Max shares per order |

### Markets & timing

| Variable | Default | Description |
|----------|---------|-------------|
| `MARKET_SLUG_PREFIXES` | `btc-updown-15m,eth-updown-15m` | Markets to scan |
| `CRYPTO_MARKETS` | `KXBTC15M` | Kalshi 15-minute crypto series to run concurrently |
| `LADDER_MAX_USDC_PER_MARKET` | `65` | Independent paper/live opening-exposure cap per ladder market |
| `POLL_INTERVAL_MS` | `5000` | Scan interval |
| `MINUTES_BEFORE_CLOSE_MIN` | `0` | Start trading N min into window |
| `MINUTES_BEFORE_CLOSE_MAX` | `15` | Stop trading N min before close |

Trade only late window (when cheap tokens show up):

```env
MINUTES_BEFORE_CLOSE_MIN=3
MINUTES_BEFORE_CLOSE_MAX=12
```

### Safety

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | Log only — no real orders |

### Timed ladder paper mode

The original strategy remains the default under `STRATEGY_MODE=reverse`.
`STRATEGY_MODE=odahoa_ladder` is a separate mode; it remains BTC-only on
Polymarket and can run across all configured `CRYPTO_MARKETS` on Kalshi. It
does not alter the reverse strategy's prices, tracker keys, order submission,
or GTC lifecycle.

Start from the dedicated paper example:

```powershell
Copy-Item .env.ladder-paper.example .env
npm start
```

Do not overwrite an existing `.env` containing wallet credentials unless you
have saved it securely. Paper mode needs no private key or CLOB API credential.

The `odahoa_v1` phases are:

| Minutes left | Complementary pairs |
|---|---|
| 15–10 | 45¢/55¢, 40¢/60¢ |
| 10–5 | 35¢/65¢, 30¢/70¢, 25¢/75¢ |
| 5–2 | 20¢/80¢, 15¢/85¢, 10¢/90¢ |
| 2–0 | 5¢/95¢ |

At the first complete book in a phase, the cheaper and favorite outcomes are
locked for that phase. Each pair is submitted once as GTC; there is no
in-phase reclassification, cancellation, replenishment, or backfill of an
earlier phase. A restart reloads phase locks and submission keys from
`PAPER_STATE_PATH`.

Scale 1 independently chooses the smallest equal share count that makes both
sides of each pair valid:

```text
ceilTo0.01(max(CLOB minimum shares, 1.00 / price))
```

The maximum if every scale-1 pair fills at its limit is approximately `$56.60`
before fees. This is capital used, not expected profit. Since each
pair totals exactly `$1.00`, a fully filled pair returns principal before fees;
profit is not guaranteed.

`EXECUTION_MODE=paper` consumes visible asks for immediate fills, limits fills
to displayed depth, tracks same-price queue ahead for resting fills, charges
taker fees on crossing fills, persists orders/fills/balances, and listens for
market resolution. Cycle summaries report committed/used capital, fill status,
outcome inventory, fees, estimated maker rebates, payout shape, and settled
P/L.

### Ladder V5 paper and Kalshi live mode

`STRATEGY_MODE=ladder_v5` is the isolated forward-test candidate produced by
the 179-session audit. It does not change V1, pair-lock, static-maker, or
reverse mode.

| Guard | V5 behavior |
|---|---|
| Entry window | More than 2 and at most 5 minutes left |
| Active rungs | 10 cents/90 cents and 15 cents/85 cents only |
| Filled-share imbalance | At most 70 shares |
| Deficient-side pair cost | At most `$0.98`, including worst-case taker fee |
| Order style | Ordinary GTC; taker fills remain allowed |
| Scale | Validation is restricted to 1-6 |

Filled positions are the only hedge credit. An opposite resting order never
reduces measured imbalance. Resting V5 orders are counted as additional
same-side risk, cancelled if later fills make them violate the imbalance or
pair-cost limit, and cancelled when the 5-2 window ends. The planner refreshes
the paper ledger after every submitted order instead of approving a batch from
one stale inventory snapshot.

V5 uses separate files under `PAPER_STATE_PATH`, including
`ladder-v5-state.json`. Use a new directory; do not point it at an earlier
paper run. The supplied profile starts at scale 4 so both selected rungs fit
under 70 shares without being truncated.

For Command Prompt:

```bat
set "DOTENV_CONFIG_PATH=.env.ladder-v5-paper.example"
npm.cmd start
```

The dedicated profile writes to `./data/paper-ladder-v5` with a `$2,000`
starting paper balance. This is a forward test, not evidence that the
post-hoc result will repeat.

V5 live execution is supported on Kalshi. Polymarket V5 remains paper-only
because its general live executor does not yet maintain the fill-aware ledger
that V5 requires. Start from the conservative single-market live profile:

```bat
set "DOTENV_CONFIG_PATH=.env.ladder-v5-kalshi-live.example"
npm.cmd start
```

Fill in the Kalshi API key and private key before starting. Live V5 requires
both live acknowledgements, uses authenticated fills for inventory, checks the
available Kalshi balance before every order, and applies
`LADDER_MAX_USDC_PER_MARKET` independently to each configured series. Add
markets to `CRYPTO_MARKETS` only after validating them in paper mode.

### Ladder V5.5 cheap-first paper/live mode

`STRATEGY_MODE=ladder_v5.5` makes the VPS-observed downside protection an
explicit Kalshi state machine shared by paper and live execution:

1. Reuse the V1 entry phases and low-side ceilings: `45/40` cents at 15-10
   minutes, `35/30/25` cents at 10-5 minutes, and `20/15/10` cents at 5-2
   minutes. The risky 5-cent final rung is excluded.
2. Before each entry, walk enough opposite-side ask depth to cover the entire
   rung and include the configured taker fee.
3. Calculate the highest post-only cheap bid that keeps the projected all-in
   pair cost at or below `LADDER_V5_MAX_PAIR_COST`. A rung price is a ceiling,
   so the submitted bid may be lower.
4. Keep at most one cheap order open per market. Cancel it at a phase boundary
   or whenever current opposite depth no longer makes its remaining quantity
   safe.
5. On every confirmed cheap fill update, FOK-buy exactly the newly unmatched
   opposite shares when their actual fee-adjusted pair cost passes the cap.
6. If a confirmed fill cannot be hedged profitably, cancel the unfilled cheap
   remainder immediately so the directional position cannot keep growing.
7. Open the next rung only after prior filled inventory is paired and its entry
   order is finished or cancelled.
8. At two minutes, cancel all entry remainders. Profitable hedges remain allowed
   until close; V5.5 never submits a loss-making rescue hedge.

The V1 sizing curve makes early exposure smaller and late exposure larger. At
scale 4 the nominal rung sizes are approximately 8.9, 10, 11.4, 13.3, 16, 20,
26.7, and 40 shares. `LADDER_V5_MAX_IMBALANCE` remains the hard per-market
unmatched-share ceiling. Each market has isolated state and cap while all
markets share the account balance. Set `MINUTES_BEFORE_CLOSE_MAX=15` or the
scanner will not expose the early phases to the planner.

V5.5 uses `ladder-v5-5-state.json` under its dedicated `PAPER_STATE_PATH`.
Never reuse a V5, V6, paper, or live state directory.

Paper mode for Command Prompt:

```bat
set "DOTENV_CONFIG_PATH=.env.ladder-v5-5-paper.example"
npm.cmd start
```

Kalshi live mode for Command Prompt:

```bat
set "DOTENV_CONFIG_PATH=.env.ladder-v5-5-kalshi-live.example"
npm.cmd start
```

The live profile intentionally starts at scale 1. Both explicit live-risk
acknowledgements are required. Live fills are accepted only after authenticated
Kalshi reconciliation; the same planner then makes the hedge decision used in
paper mode.

### Ladder V6 paper candidate

`STRATEGY_MODE=ladder_v6` is an inventory-controlled, two-sided maker strategy:

1. During the 5-2 minute window, post one competitive post-only quote on each
   outcome when their combined price is no more than the configured pair cap.
2. Allocate available price slack across both quotes so they join or improve
   the current best bids instead of waiting at fixed 10/15-cent rungs.
3. Limit each side to the configured 40-share cap and stop opening new
   inventory after the first fill.
4. Preserve the opposite opening quote when it is already the correct
   profitable completion order, retaining its queue priority.
5. If the opposite executable asks can complete the filled inventory with the
   required edge after fees, submit an exact-share FOK immediately.
6. Otherwise, post the highest profitable completion-maker price and keep
   repricing it as the book changes.
7. At two minutes, cancel resting quotes and permit an exact-share FOK rescue
   only when it caps the locked loss at `LADDER_V6_MAX_RESCUE_LOSS` or less.

The opening maker-pair cap is:

```text
$1 - required net edge - safety buffer
```

The default profile targets two cents of maker-pair edge, requires at least
one cent on taker completions, and caps a cutoff rescue at two cents:

```env
LADDER_V6_MAX_UNMATCHED_SHARES=40
LADDER_V6_MIN_NET_EDGE=0.01
LADDER_V6_SAFETY_BUFFER=0.01
LADDER_V6_MAX_RESCUE_LOSS=0.02
```

Set the edge to `0.02` for the conservative experiment or `0.005` for the
aggressive experiment. A larger safety buffer increases locked maker-pair
profit but reduces quote competitiveness. Always use a separate
`PAPER_STATE_PATH`.

V6 is paper-only. Its paper executor uses the market WebSocket to wake the
planner immediately after simulated maker fills and relevant book changes;
it does not wait for the scanner poll. Real-money V6 remains disabled pending
forward paper evidence even though the Kalshi executor now has authenticated
fill and order-state streams.

For Command Prompt:

```bat
set "DOTENV_CONFIG_PATH=.env.ladder-v6-paper.example"
npm.cmd start
```

For Linux or a VPS:

```bash
DOTENV_CONFIG_PATH=.env.ladder-v6-paper.example npm start
```

The isolated ledger is `./data/paper-ladder-v6`.

### Ladder V7 evidence-filtered paper candidate

`STRATEGY_MODE=ladder_v7` is the narrower candidate derived from the combined
V5/V5.5 log review. The V5 sample starts at `2026-08-01T18:00:00Z`, when BTC,
ETH, and DOGE were all running concurrently; the earlier BTC-only setup is not
included.

The result was not "more rungs." V5's matched inventory was profitable, but
large one-sided positions erased it. V5.5 then made entry and hedging dynamic,
yet reconstructed PnL was -$55.34 over 60 settlements: just 10 markets paired
for +$11.97 while 22 one-sided markets lost -$67.31. It also suffered 42
service restarts with repeated heap out-of-memory failures.

V7 keeps only the execution combination that survived the retrospective
filters:

1. Trade only from five to two minutes before close.
2. Attempt one fixed 10-cent cheap-side post-only maker for at most 40 shares.
3. Independently attempt one favorite-side FAK for at most 40 shares, capped
   at 80 cents. Unavailable quantity is cancelled, never left resting.
4. Do not reprice or retry either role; cancel an unfilled cheap maker at two
   minutes.
5. Persist two stable role keys per market in an isolated V7 state file.

Across 111 post-cutoff markets per series, the same filter at V5's original
40-share size retrospectively attributed +$107.06 to BTC, +$53.23 to ETH, and
+$34.40 to DOGE. V7's paper profile uses that same 40-share size; a smaller
cap is available only for a risk-limited experiment. This is an in-sample
attribution, not a forward result, and BTC is the only default market because
its result was the strongest and most stable.

V7 is Kalshi paper-only. Its per-market execution queue wakes once after each
atomic two-outcome book update or simulated fill instead of waiting for the
polling interval. Fill in the Kalshi credentials required by its market
WebSocket, then run the supplied BTC profile.

For Command Prompt:

```bat
set "DOTENV_CONFIG_PATH=.env.ladder-v7-paper.example"
npm.cmd start
```

For Linux or a VPS:

```bash
DOTENV_CONFIG_PATH=.env.ladder-v7-paper.example npm start
```

The profile writes paper state to `./data/paper-ladder-v7-btc`. See
[`LADDER_V7_ANALYSIS.md`](LADDER_V7_ANALYSIS.md) for the reconstructed PnL,
failure analysis, caveats, and the forward-test acceptance criteria.

### Ladder V8 Odahoa BTC 15-minute paper candidate

`STRATEGY_MODE=ladder_v8` models the recurring structure observed in Odahoa's
public BTC 15-minute maker fills on August 3-4, 2026. It is intentionally
Polymarket paper-only: the public record reveals fills, not every submitted or
cancelled order, so this is an evidence-based reconstruction rather than an
exact copy of private intent.

V8 applies these rules throughout the 15-to-2-minute entry window:

1. Lock the cheap and favorite outcomes on the first V8 planning decision for
   the market. A later favorite reversal permanently flip-locks that market.
2. Offer all nine complementary 5-cent pairs: 45/55 through 5/95.
3. Submit every leg post-only, below the current ask, with one stable key per
   market, outcome, and price. A submitted leg is never replenished.
4. On a favorite reversal, cancel the entire resting opening grid and never
   build another stack. The flip lock is persisted across restarts. V8 may
   submit only one deficient-side completion maker, sized no larger than the
   actual unmatched inventory and priced for a maximum 99-cent pair cost.
5. At two minutes, cancel open orders that would add to the heavier filled
   outcome while retaining completion orders on the deficient outcome.
6. Once V8's filled imbalance reaches 240 shares, cancel and block additional
   orders on the heavy outcome. This guard reacts after confirmed fills and
   cannot prevent several simultaneously resting orders from filling together.

The default order size is selected from the BTC market's start time in New
York, matching the strongest recurring share tiers in the audit:

| Market start (ET) | Shares per leg |
| --- | ---: |
| 00:00-05:59 | 5 |
| 06:00-08:59 | 16 |
| 09:00-14:59 | 120 |
| 15:00-17:59 | 32 |
| 18:00-23:59 | 8 |

`LADDER_V8_SIZE_SCALE` scales those tiers, while
`LADDER_V8_MAX_SHARES_PER_ORDER` is a hard per-leg ceiling. At the default
daytime tier, one complete nine-pair grid can commit up to $1,080, so the
sample profile sets `LADDER_MAX_USDC_PER_MARKET=1100` and uses an isolated
$25,000 paper ledger. These values emulate the observed sizing; they are not
a recommendation for live risk.

For Command Prompt:

```bat
set "DOTENV_CONFIG_PATH=.env.ladder-v8-paper.example"
npm.cmd start
```

For PowerShell:

```powershell
$env:DOTENV_CONFIG_PATH = ".env.ladder-v8-paper.example"
npm start
```

The profile writes paper state to `./data/paper-ladder-v8-btc`.

### Odahoa pair-lock V2

`STRATEGY_MODE=odahoa_ladder_2` keeps V1's BTC market selection, phases,
low-price rungs, sizing, and exposure safeguards. Its openings are post-only
GTC bids on the phase's cheap outcome. A maker fill creates a priced inventory
lot; the strategy then:

- naturally pairs profitable opposite opening lots, highest entry cost first;
- reserves at most 10% of eligible fills at 20 cents or less on the first
  eligible outcome only;
- posts a post-only completion bid at the highest profitable passive tick;
- cancels or resizes stale completion orders as fills and phases change; and
- uses a limit-priced FAK only for visible depth whose blended pair cost,
  including the taker fee, is at most `PAIR_LOCK_MAX_COST`.

Maker rebates are excluded from pair approval. Paper and live use the same
planner and the same post-only, cancellation, and FAK semantics. Live mode
reconciles the bot's order IDs against authenticated CLOB open orders and
trades, and persists that mapping in
`PAPER_STATE_PATH/live-execution-state.json` for restart recovery.

The three pair-lock settings are:

```env
PAIR_LOCK_MAX_COST=0.985
PAIR_LOCK_RESIDUAL_FRACTION=0.10
PAIR_LOCK_RESIDUAL_MAX_PRICE=0.20
```

For Command Prompt, run the paper implementation with:

```bat
set STRATEGY_MODE=odahoa_ladder_2
set EXECUTION_MODE=paper
npm start
```

Live mode uses the same strategy and also requires the existing wallet
configuration, exposure cap, and both live acknowledgements:

```bat
set STRATEGY_MODE=odahoa_ladder_2
set EXECUTION_MODE=live
set LIVE_TRADING_ACK=I_UNDERSTAND_REAL_MONEY_IS_AT_RISK
set LADDER_LIVE_ACK=I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY
npm start
```

### Static maker A/B paper mode

`STRATEGY_MODE=odahoa_static_maker` is a paper-only candidate based on the
observed maker-heavy, two-sided behavior. During the first two minutes of each
BTC window it places 90-share BUY orders at 45, 40, 35, 30, 25, 20, 15, 10,
and 5 cents on both outcomes. A level is eligible only while it is below both
current asks. Orders are ordinary GTC limits, so a book move between the
eligibility check and submission can still produce a taker fill.

The complete candidate ladder commits `$405`, below
`STATIC_MAKER_MAX_USDC_PER_MARKET=500`. It never classifies an underdog,
reprices, replenishes, or submits after 13 minutes remain.

Run V1 and the candidate in separate PowerShell terminals so both observe the
same windows:

```powershell
$env:DOTENV_CONFIG_PATH=".env.ladder-paper.example"
npm start
```

```powershell
$env:DOTENV_CONFIG_PATH=".env.paper-ab-static-maker.example"
npm start
```

After at least 100 common settlements, compare the isolated ledgers:

```powershell
npm run compare:strategies -- ./data/paper-odahoa-v1 ./data/ab-static-maker
```

The comparison ranks the strategies by estimated rebate-adjusted settled P/L
and also reports capital, ROI, payoff ratio, maker/taker execution, two-sided
participation, drawdown, the worst market, and a paired bootstrap interval.
The rebate is an estimate; actual wallet payouts are authoritative.

Before considering live ladder mode, observe at least three complete BTC
scale-1 paper cycles and inspect:

```text
data/paper/paper-state.json
data/paper/paper-events.jsonl
data/paper/ladder-state.json
```

Live ladder mode requires the ordinary live acknowledgement plus:

```env
EXECUTION_MODE=live
LIVE_TRADING_ACK=I_UNDERSTAND_REAL_MONEY_IS_AT_RISK
LADDER_LIVE_ACK=I_UNDERSTAND_LADDER_MODE_CAN_LOSE_REAL_MONEY
```

Startup rejects non-integer scales, non-BTC Polymarket ladder markets, malformed
Kalshi series, and projected scale exposure above
`LADDER_MAX_USDC_PER_MARKET` (default `$65`). The deprecated
`LADDER_LIVE_MAX_USDC_PER_MARKET` remains a fallback when the new variable is
unset. If a larger live minimum pushes the projection over the cap, only that
market is blocked.

---

## Project layout

```
reverse-bot/
├── src/
│   ├── index.ts           # main loop
│   ├── market-scanner.ts  # active 15m markets + books
│   ├── strategy.ts        # underdog/favorite + limit prices
│   ├── trader.ts          # CLOB order submission
│   └── config.ts
├── .env.example
└── package.json
```

---

## Commands

```bash
npm start      # run bot
npm run dev    # run with hot reload
npm run build  # compile TypeScript
npm test       # regression, ladder, paper-fill, and safety tests
npm run compare:strategies -- <baseline-dir> <candidate-dir>
npm run check  # build, tests, and high-severity dependency audit
```

---

## Risks

- **Most cheap bids lose.** 7–10¢ tokens frequently expire worthless.
- **Limits may not fill.** Bidding 7¢ when ask is 4¢ waits for sellers.
- **Both legs can't both win.** One side always goes to $0.
- **Real money.** Test with `DRY_RUN=true` first.

---

## Links

- My profile: https://polymarket.com/@odahoa  
- My activity: https://polymarket.com/@odahoa?tab=activity  
- Polymarket settings: https://polymarket.com/settings  
