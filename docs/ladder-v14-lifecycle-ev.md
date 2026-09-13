# BTC lifecycle EV gate

Keep `LADDER_V14_VOLUME_FIRST_MODE=true` and enable
`LADDER_V14_LIFECYCLE_EV_ENABLED=true` (the default). The dedicated model applies
only to `KXBTC15M`; ETH/SOL retain their existing execution and conditional models.
The paper example now selects `CRYPTO_MARKETS=KXBTC15M` for validation. Runtime
`.env` files are not changed.

Each near-touch opening candidate uses its fee-inclusive price and the existing
liquidity/exposure-limited baseline quantity. The admission probability is the
minimum of entry-price and baseline-size repair probabilities over the remaining
market horizon. Below break-even it is rejected; between break-even and the safe
threshold it is capped at 10 shares; above the safe threshold it keeps baseline
sizing. A resting probe retains its original baseline size hazard. YES and NO
are admitted independently. Existing $125/250-share caps and execution guards
remain enforced. The conditional model does not supply an additional BTC
opening EV gate.

After the first unmatched fill, all opening orders are cancelled and reconciled
before repair. Exact fee-inclusive profitable taker depth gets priority, even
during final cleanup. Maker repairs must remain profitable for unmatched lots,
including a second check under the executor lock. Residual age, size, adverse
gap, cleanup time and settlement caps cannot force losses in this mode. Normal
economic sales/hedges remain eligible when they beat continuation by the
configured $0.005/share margin. Missing hold estimates do not justify exits.

The first valid normalized post-fill hold estimate freezes the episode's adverse
gap. Its hazard labels the residual healthy, borderline or poor without forcing
an exit. Only a fully flattened profitable pair counts as a repair event. Sales,
negative pairs, side flips and aborts are censored; terminal residuals add
exposure but no event. Same-side cancellation-race fills belong to the episode.

The historical BTC calibration is seeded once under
`btc-20260910-lifecycle-v1`. The optional `lifecycle` field in version-1 V14
history preserves the conditional learner, active/planned order state and old
reports. Existing settled reports are excluded from post-update market counts.
Online sufficient statistics, active episode/fill deduplication metadata and
finalized slugs persist across restart. Economic gain and failure-cost totals
update only from finalized market accounting; forced safeguard pairs and
nonpositive pair matches are excluded from gain totals.

The safe threshold starts at exactly `0.8830523450`, bounded below by the current
break-even probability. After 300 new BTC settlements, and each 50 thereafter,
50,000 valid deterministic market bootstrap resamples recalculate its empirical
97.5th percentile using at most the latest 1,000 compact market summaries. A
window with no residual shares retains the prior threshold because no valid
resample exists. Bootstrap work never occurs on ordinary book ticks.

Normal BTC logging retains actual fills, one compact `v14_ep` record per closed
episode, settled market rows, summary economics and simulator-health counters.
It suppresses residual evaluations and maker submission churn. Debug retains
verbose execution records. Learning uses persisted state, not JSONL replay.
Candidate counters count changed price/baseline/classification states per side,
not repeated evaluations of the same candidate.

Validation: `npm run build`, `npm test`, and `npm run audit`. The attached request
did not include the historical BTC JSONL files, so the 297-market retrospective
classification/P&L replay cannot be reproduced here. Its -$115.54 combined result
is a counterfactual estimate, not a promised live or paper outcome.
