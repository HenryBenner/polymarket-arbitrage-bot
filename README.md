# Polymarket Reverse Arbitrage Bot

TypeScript automation for my Polymarket reverse strategy on **15-minute BTC/ETH Up or Down** markets.

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
`STRATEGY_MODE=odahoa_ladder` is a separate BTC-only mode; it does not alter
the reverse strategy's prices, tracker keys, order submission, or GTC lifecycle.

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

### Ladder V5 paper candidate

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
| Scale | Paper validation is restricted to 1-6 |

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
post-hoc result will repeat. Keep it paper-only until it has a meaningful
out-of-sample settlement count.

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

Startup rejects non-integer scales, non-BTC ladder markets, and projected
scale exposure above `LADDER_LIVE_MAX_USDC_PER_MARKET` (default `$65`). If a
larger live CLOB minimum pushes the projection over that cap, that market is
blocked rather than silently resized.

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
