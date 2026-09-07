# Ladder V15

V15 is Kalshi paper-only. It opens cheap inventory from 15 minutes until two
minutes before close and purchases the complementary side only after confirmed
fills. It has no independent favorite starter and no learned EV entry gate.

Use `.env.ladder-v15-paper.example` as a separate configuration; supply websocket
credentials through the environment. Launch with `npm start`. Existing `.env`
files and running strategies are not changed by the implementation.

In PowerShell, select the profile with
`$env:DOTENV_CONFIG_PATH = ".env.ladder-v15-paper.example"` before launching.
Set `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` in the process environment or
in your own copy of the profile. Do not launch the placeholder profile without
credentials; Kalshi requires authentication for its market websocket.

## Execution and accounting

The default cheap ceiling is $0.10 for 40 contracts. Partial entries are cancelled
before completion. Immediate completion uses full-depth FOK and a $0.03 minimum
net pair edge; otherwise a maker rests at no more than $0.80 and the fee-safe
remaining-lot limit. The worst remaining lot cost protects expensive residuals.
Four immediate attempts are allowed per price/depth fingerprint, separated by
350 ms. A changed executable book or cleanup phase starts another retry budget.

Cycles can repeat throughout 15–2. Filled residuals and outstanding entry orders
count against the 40-contract market and 120-contract portfolio limits. Cash is
accounting-only; liquidity, queue priority, stale-data checks and fees still apply.
At two minutes, pending entries cancel. At 30 seconds, makers cancel before a
fee-aware comparison of executable residual sale and complementary hedge. The
hedge pair-cost ceiling is $1.02; unavailable quantities remain exposed through
settlement. These controls do not guarantee a maximum realized loss.

Complementary fills immediately reduce both paper positions and credit $1 per
closed pair to theoretical cash. They cannot be sold again. Settlement's `payout`
remains the total economic payout for compatibility with previous reports;
cash receives only the portion not already credited. `v15ClosedPairPayouts`
tracks that credit until settlement. Settled cycle reports are saved atomically
as `v15Cycles` before the executor prunes orders/fills. Active cycles, reservations,
retry fingerprints and timing are reconstructed from checkpointed orders/fills.
Market metadata is also checkpointed so expired windows can settle after a
restart even when the active-market scanner no longer returns them. Restored
books start invalid and cannot place orders until refreshed.

## Timing report

`npm run report:ladder-v15 -- ./data/paper-ladder-v15`

Cycles are attributed to 15–10, 10–5 or 5–2 by the first confirmed entry fill,
with exact timestamp and minutes remaining retained. Late cancellation-race
fills have a separate `late-fill` bucket. Unfilled attempts are separate.
Completion and exit costs remain with the entry cycle. The report includes
realized profit, notional, fees, profit per resolved entry contract, paired-share
completion rate, residual losses and holding duration, grouped by series/bucket.
Unsettled residuals are shown separately; their possible payout is not profit.

Timing comparisons are observational: exposure from an early cycle can prevent
a later entry. The window remains 15–2 throughout the initial experiment.

## Shared-feed experiment

`npm run compare:ladder-v15 -- ./data/v15-comparison-001`

Use a **new** output directory. This command creates isolated V9, V14, V15-40,
V15-160 and V15-640 portfolios. V15 exposure limits scale with cycle size. V9
and V14 keep their configured policies. All variants receive cloned events
from one websocket connection and the same REST book snapshots each scan round.
Depth is consumed independently within each hypothetical portfolio; the variants
do not compete against each other. They share settlement queries as well.

`market-tape.jsonl` records ordered normalized market updates, discovery/book
snapshots and settlement observations. This is not an impact model: large orders
can affect real markets in ways paper execution cannot reproduce.

The runner finishes after seven days and 200 common settled windows per enabled
series. Ctrl+C saves partial results. `results.json` ranks settled net dollars
and includes worst-market losses, settlement-based drawdown and V15 timing data.
The run has not been started automatically. An interrupted experiment is partial;
start another new directory rather than silently mixing tapes/configurations.

## Historical diagnosis

`npm run analyze:ladder-v15-history -- <v9-paper-directory> <v14-paper-directory> <wallet-activity.json>`

This read-only command deduplicates fills/activity and reconciles each market
against its settlement before assigning FIFO paired, sale and directional P&L.
Unreconciled or missing fills do not receive invented attribution. Wallet trade
flow, redemptions and rebates are separated; incomplete wallet activity does not
establish net profitability. Historical diagnosis is not a counterfactual replay.

The checked-in `ladder-v15-historical-results.json` was generated on September 7
from the supplied Downloads artifacts. V9's ledger totals -$208.99 over 284
markets; 263 market histories reconcile. Within that subset, paired P&L is
+$395.92, sale P&L is -$142.55, and residual directional P&L is -$462.36.
The three largest wins reconcile as paired gains, not directional payouts.

The now-current supplied V14 ledger contains 753 markets and -$511.70, a different
snapshot from the earlier September 3 diagnosis. Combining its retained logs
with its checkpoint reconciles 708 markets. Missing/corrupt rotations are listed
in the JSON and are not reconstructed. These subset attributions must not be
presented as full-ledger totals or proof of V15 profitability.
