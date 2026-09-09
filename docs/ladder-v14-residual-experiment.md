# V14 residual hold experiment

Residual management compares maker waiting, an executable taker hedge, an executable sale, and holding to settlement. Opening price selection and quantity sizing are unchanged.

Hold value is the held midpoint divided by the sum of both outcome midpoints. Missing, nonfinite, or crossed quotes produce an unknown probability, not zero. Unknown probability does not authorize a losing forced exit.

Before cleanup, a profitable taker completion remains available immediately (or a sale if it recovers more). Other immediate exits must beat both hold and wait by `LADDER_V14_REPAIR_EXIT_MARGIN`. Maker waiting uses the time remaining until cleanup, without the old 30-second cap. Its failure branch retains the better of the estimated future executable recovery and current implied hold value. This is a deliberately simple approximation, not a trained settlement predictor.

During the final `LADDER_V14_FINAL_CLEANUP_SECONDS`, new maker waiting is disabled. Hedge and sale are compared with hold; hold wins ties. If hold is selected, outstanding repair orders are cancelled and the residual remains until settlement or a better later evaluation. Normal openings stay blocked while inventory is unpaired. Partial immediate execution causes a fresh evaluation of the remainder.

`LADDER_V14_REPAIR_MAX_WAIT_SECONDS` now only affects the existing maker edge relaxation. Neither its expiry nor `LADDER_V14_VALUE_REPAIR=false` restores forced exits. The value-repair flag still controls the existing maker price relaxation policy.

## Paper evaluation

Restart with a fresh, separately named `PAPER_STATE_PATH` to isolate this experiment. Keep old run directories for comparison. The implementation does not start a bot or change an active run.

Material residual decisions are appended asynchronously to `trades.jsonl`. Records include entry cost, decision quantity, age, time remaining, hold/wait/executable values, selected action, and reason. `markets.jsonl` links the final decision to the winner and actual residual settlement P&L. Counterfactual hold P&L is `(winner === held side ? 1 : 0) - entry`; multiply per-share P&L by decision quantity for its dollar value. These are historical counterfactuals, not a strategy backtest.

Run:

```powershell
npm run report:ladder-v14 -- ./data/paper-ladder-v14
npm run calibrate:ladder-v14 -- ./data/paper-ladder-v14
```

The lifecycle report separates paired profit, sales, held residual settlement results, maker/taker repair quantities, exposure time, P&L per opening share and deployed dollar, and the ten worst markets. All-in costs already include fees; do not subtract fees again.

The calibration report joins shadow decisions with settlement and reports ten probability buckets. It excludes unsettled observations from win rates and P&L averages. Repeated evaluations of one residual are correlated and are **not independent trials**. Action evaluation counts describe decisions, while lifecycle quantities describe realized fills. Do not interpret a million repeated hold decisions as a million residual episodes.

The supplied prior 0-for-92 history is a reason to test calibration, not evidence that midpoint estimates are accurate for new residuals. Holding can remain adversely selected. This experiment measures that risk; it does not establish profitability.

Normal logging produces `trades.jsonl`, `markets.jsonl`, and `run-summary.json`. Equivalent repeated decisions are suppressed; calibration streams the compact files instead of loading them into RAM. Internal checkpoint and learner state remain restart-only implementation data.
