# Ladder V7 evidence and design

## Scope

This analysis uses `ladderv5-and-v5-5-logs-20260802T230222Z.tar.gz`.
For Ladder V5, observations before `2026-08-01T18:00:00Z` are excluded so
BTC, ETH, and DOGE all begin at the same concurrent-market cutoff requested by
the operator. Ladder V5.5 begins later and is evaluated from its first event.

The figures below reconstruct cash PnL from append-only fills and settlement
outcomes. That matters because six V5.5 markets had fills that were missing
from the final settlement ledger after repeated process failures.

## What failed

### Ladder V5

After the concurrent-market cutoff, reported V5 PnL was:

| Series | Markets | V5 PnL |
|---|---:|---:|
| BTC | 111 | +$58.73 |
| ETH | 111 | -$39.16 |
| DOGE | 111 | -$123.18 |

The central problem was not that paired fills lacked edge. Across the complete
V5 archive, matched inventory contributed positive modeled value on all three
series: BTC +$193.70, ETH +$225.05, and DOGE +$193.24. Residual one-sided
inventory contributed -$180.59, -$272.45, and -$296.40 respectively. A small
number of directional losses consumed many paired wins.

Execution role was more important than adding more rungs. Cheap orders that
crossed the ask were adversely selected, while resting 10-cent maker fills had
the best cheap-leg behavior. On the favorite side, passive 90-cent orders
tended to fill when the favorite was becoming less likely; immediately
executable favorite fills bought at 80 cents or less behaved better.

### Ladder V5.5

The append-only V5.5 events contain 60 settled markets and 102 fills. The
settlement events reported -$39.02, but fill-and-outcome reconstruction gives
-$55.34 after restoring the six markets whose settlement ledgers omitted
fills. Only 10 of 60 markets acquired both outcomes; those markets made
+$11.97. The 22 one-sided markets lost -$67.31, and 28 markets had no fill.

Every entry phase was negative before the small hedge contribution:

| Entry phase | Reconstructed PnL |
|---|---:|
| 15-10 minutes | -$11.30 |
| 10-5 minutes | -$28.99 |
| 5-2 minutes | -$19.83 |

Opening inventory lost -$70.97 and completion hedges added only +$15.63.
V5.5 therefore fixed the wrong failure mode: dynamically safe pair pricing
reduced fill frequency and still left adverse cheap fills whenever a hedge was
not executable. It also continuously repriced and persisted dynamic keys. The
service restarted 42 times, with repeated Node heap out-of-memory traces and
many abandoned temporary state files. That run is both economically negative
and operationally unreliable.

## Retrospective V7 filter

The simplest rule supported by the V5 sample was:

- use only the 5-2 minute phase;
- keep only the fixed 10-cent cheap bid when it was a maker fill;
- use only the favorite leg when it was immediately executable at 80 cents or
  less; and
- remove the 15/85 pair and every earlier rung.

At the original 40-share size, attributing only those fills across the 111
post-cutoff markets per series produced:

| Series | Retrospective PnL at 40 shares | Worst 40-share market |
|---|---:|---:|
| BTC | +$107.06 | -$30.52 |
| ETH | +$53.23 | -$26.25 |
| DOGE | +$34.40 | -$32.45 |

The supplied paper profile uses the same 40-share exposure as this result. A
20-share limit would mechanically halve both PnL and the single-market tail,
but it is a risk-control variant rather than the maximum-PnL paper baseline.
BTC was the strongest cohort; ETH and DOGE had weak late subsamples, so the
supplied profile starts with BTC only.

## Implemented V7 rule

`STRATEGY_MODE=ladder_v7` is deliberately small and paper-only:

1. At five minutes remaining, lock the current cheap and favorite outcomes.
2. Attempt one 40-share post-only cheap bid at 10 cents.
3. Independently attempt one 40-share favorite FAK with an 80-cent limit. It
   takes available ask depth at 80 cents or better and cancels any remainder.
4. Never reprice or retry either role in that market.
5. Cancel an unfilled cheap maker at two minutes.
6. Use fixed persisted role keys and an isolated `ladder-v7-state.json`.

The favorite attempt intentionally does not wait for a cheap fill. Waiting for
confirmation would recreate V5.5's execution selection, whereas the candidate
was derived from the independent V5 legs. The 80-cent limit bounds the entry
price; the 40-share hard cap preserves the historical paper-test size.

## Interpretation

This is evidence for a forward experiment, not evidence of profitability. The
rule was selected after seeing the same sample, paper fills simplify real queue
behavior, the sample covers roughly a day, and the three series are correlated.
Do not enable real-money execution from these results. A useful next decision
point is at least 300 settled BTC markets with no missing events, no restarts,
and results reported separately for cheap-maker-only, favorite-FAK-only, both,
and neither cohorts.
