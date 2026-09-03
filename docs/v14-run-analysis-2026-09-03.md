# V14 supplied-run diagnosis — September 3, 2026

Source: the user-provided `paper-ladder-v14-btc-eth/paper-ladder-v14-btc-eth`
folder. The current `paper-state.json` contains the latest settlement ledger.
The current event file, `.1`, and `.2.gz` through `.10.gz` retain events from
05:00–14:33 UTC September 3. Extra uncompressed `.2`–`.4` files belong to the
previous September 2 run and are excluded. Temporary checkpoints are not
merged into the canonical ledger. No input files were changed.

## Results and limits

| Latest settled ledger | BTC | ETH | Total |
|---|---:|---:|---:|
| Markets | 46 | 46 | 92 |
| Net P&L | -$934.09 | -$478.83 | -$1,412.92 |
| Fees | $478.70 | $218.45 | $697.15 |

The loss before fees was approximately $715.77. This is not just a fee-accounting
problem. In the retained event interval there were 26,237.72 taker-repair shares
and 501.63 maker-repair shares: 98.1% of repair volume crossed as a taker. There
were no recorded residual SELL fills in that interval. Choosing a hedge instead
of a sale did not make those completed pairs profitable.

The retained events contain fills in 51 markets. Forty-nine market fill replays
reconcile to settlement P&L within two cents. One market is still unsettled in
the supplied snapshot and one replay does not fully reconcile; the canonical
settlement totals above are not replaced with incomplete replay totals.

## Confirmed failures

1. **A target-order oscillation.** At the lower price boundary, multiple ladder
   levels selected the same outcome and price but different quantities. The
   planner alternately amended the same order to each quantity. Order
   `paper-a60876bc-0ada-4cb8-9441-cb8bf5f0a4ea` in
   `btc-updown-15m-1788438600` was amended 9,536 times; its 0.001-price order
   repeatedly switched between 160 and 320 shares. The retained logs contain
   48,564 amendment events overall.
2. **Loss-making repair policy.** The previous maker repair could itself lock
   a loss because its price ignored residual entry cost. After five seconds,
   the strategy also forced a hedge/sale choice even while a profitable maker
   completion still had time to occur. That was a policy flaw, not evidence
   that the requested five-second branch was absent.
3. **Fresh-trade censorship in paper execution.** A single chronology watermark
   compared book updates with independently timestamped trades. A fresh trade
   could be dropped merely because a newer book arrived first. This is reproduced
   in a regression test. The logs also contain 367,668 genuinely aged trade skips
   (median age 23.2 seconds), but they do not prove how many fresh trades were
   silently censored. Aged trades remain ineligible; they are not retroactively
   counted as profitable fills.
4. **Unnecessary CPU and history growth.** Pair-price selection enumerated the
   YES-by-NO tick cross-product on each pass. History retained 35,301 quote
   contexts, including expired and already-observed amendments. A read-only load
   of the supplied history using the cleanup fix removed all now-expired planned
   contexts while preserving the serialized learned model exactly. Checkpoint
   writes are now coalesced when storage is slow.

## Implemented changes

- Aggregate colliding levels into one quantity per outcome/price; unchanged
  snapshots converge without repeated amendments.
- Solve paired quote prices directly on integer ticks. Normal volume-first
  entries remain available without a new EV, volatility, or trade-count gate.
- Continue repair-only behavior: cancel ordinary opening orders and quote only
  the missing R shares. Take immediately only when the all-in completed pair is
  profitable. Otherwise rest a fee-safe missing-side maker.
- Remove automatic loss-taking at five seconds. At the final cleanup deadline,
  cancel the maker and choose the better executable hedge or net sale, including
  loss-locking hedges. No new opening grids during cleanup.
- Separate trade/book chronology; reject trades predating an order's latest
  amendment. Preserve stale-trade rejection and deduplication.
- Discard expired/orphaned quote contexts without deleting learned statistics;
  avoid a backlog of full history snapshots during slow writes.

## Verification versus profitability

Regression tests cover the actual 0.001-price collision pattern, convergence,
integer-tick pricing, fresh trade/book interleaving, pre-amend fill rejection,
fee-safe repair, no forced five-second loss, cleanup hedges/sales, quiet-book
deadline wakeups, and history persistence. The analysis command is:

`node scripts/analyze-v14-run.mjs <paper-directory>`

The artifacts do not contain a complete reconstructable depth-and-trade tape
for a faithful counterfactual backtest. No positive replacement P&L is claimed.
Longer repair waiting can improve completion opportunity but also increases
exposure to adverse moves and can reduce trade frequency. A fresh paper run is
required to measure whether the corrected policy has positive net expectancy.
