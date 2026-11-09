# Nifty confirmation investigation — 4 November 2026

This report examines the archived adaptive policy. The live policy changed to
[candlestick-only confirmation](candlestick-agent.md) on 5 November. Its original
zero-entry finding should not be interpreted as a result of the new policy.

The supplied `Nifty-50-spot-5min-replay (1).json` contains 1,119 spot OHLCV
candles from 13 October 09:15 to 4 November 11:00 IST. Its SHA256 is
`7a386c6673f0cc69a6324802ff814a6407491a21cc282a9c7a71aa3ce97fd87d`.
It has no observed agent assessments, ledger, stream state, entry quotes, native
15-minute/hourly history or archived ATM CE/PE VWAP snapshots. It is a candle
export, not a complete live execution audit. All spot-volume fields are zero.

## Findings from the supplied data

The chronological adaptive replay evaluates 1,038 eligible completed prefixes,
using up to 1,000 bars per evaluation and only complete higher bars derivable
from those prefixes. It finds 11 CALL and 9 PUT candidates passing the seven
price-quality checks. Those counts do not represent confirmed or entered trades.
The result has zero fully confirmed setups and zero entered trades.

Both directions fail historical VWAP confirmation on every replay evaluation
because the file does not contain archived ATM snapshots. That absence removes
the 25-point VWAP budget and can also push coverage below 70%. It does **not**
prove that the live dashboard's ATM feed was unavailable. Today's option prices
cannot reconstruct earlier option VWAP or repair this historical limitation.

The independent full-prefix price review finds the same 20 price-qualified
candidates. Of these, 18 also fail the 1.20 reward/risk requirement and 19 fall
below their score requirement without the missing VWAP contribution. Blockers
overlap. For example, the 16 October 09:50 CALL candidate has entry 22,983.65,
stop 22,939.22 and reference resistance 22,997.35: approximately 0.31 reward/risk,
which should be rejected. These are point-based reference levels, not option fills.

## Latest morning in the export

Times below identify the five-minute candle's **start**, in IST. Analysis occurs
after its close. These are candle-only reconstructions, not observed live decisions.

- At 09:25 on 4 November, a CALL range break has price acceptance, but the close
  is approximately 4.65 ATR from EMA20 against a 1.50 ATR limit. Five-minute
  ADX is approximately 15.7 against the fallback requirement of 20. It does not
  qualify for confirmation even if current option VWAP supports CALL.
- At 11:00, the raw price engine labels a PUT level break. Its approximately
  1.21 reward/risk passes that individual gate. The stricter price-quality path
  classifies it as TRANSITION: no accepted opposing-structure reversal is proven,
  the required 15-minute EMA context remains CALL, and selected EMA confirmation
  has not passed. Reconstructed chop is 0.8, activating the existing extreme-chop
  block. A downward price move alone does not satisfy those entry conditions.

Historical EMA50/RSI warmup is already available in this file. Waiting for 50
current-date candles is not the cause. Missing intraday observations still affect
trajectory windows and the ability to reconstruct higher bars. Native higher
history in the live application can differ from these reconstructed views.

## Defects repaired

1. An accepted price-event candidate rejected by score, risk or VWAP could be
   discarded from the main result. The card then said "no confirmed pattern"
   even while its independent direction panel contained that candidate. The
   closest rejected accepted-price candidate now remains visible with its actual
   blocking reason. It remains unconfirmed and cannot enter.
2. A direction with no price candidate could lose its confirmation assessment,
   causing diagnostics to show the legacy 1.5× ratio instead of the active
   adaptive score/lead policy. Each direction now keeps its current price,
   regime, momentum and VWAP checks even when the price pattern is missing.
3. The monitoring export previously omitted the observations needed to diagnose
   live entries. **Export candles and agent diagnostics** now includes observed
   CALL/PUT assessments, transitions, saved outcomes, connection/quote state,
   current plan/entry checks and current ATM context. Forming candles and broker
   credentials are excluded. Current context remains separate from archived
   historical replay inputs.
4. A zero-trade replay previously gave little explanation when the evaluator
   returned no plan. Adaptive/fixed replays now report reconstructed failure
   counts by direction and the last 20 assessments, with missing historical ATM
   context explicitly identified. Custom/legacy evaluators do not receive
   invented adaptive diagnostics.

No confirmation weights, score/lead requirements, price acceptance, 70% coverage,
1.20 reward/risk, quote guards or SL/TSL rules are loosened by these repairs.
No broker orders are added. The supplied file does not establish a live execution
failure or demonstrate that a valid fully confirmed trade was missed.

## Reproduce

```
npm run agent:compare -- input.json --output comparison.json
```

Use the supplied candle file as `input.json`; outputs cannot overwrite an existing
file. Inspect the `adaptive` report's `diagnostics.missingRequiredInputs`,
`diagnostics.bySide` and `diagnostics.recentAssessments`. These are reconstructed strategy checks, not
the actual live observations in a monitoring export's top-level `assessments`.
The replay retains fixed-target comparison exits and does not validate live TSL,
option-premium P/L, brokerage execution or profitability.

Validation: 244 targeted tests pass — confirmation/rolling history 44, agent 121,
analysis 42, commodities 25 and replay 12. Build, lint and diff checks pass; Vite
retains its existing large-chunk advisory. The supplied file also completes the
offline replay above. Regressions verify retained rejected candidates, adaptive
diagnostics for both directions, credential-free monitoring exports, reconstructed
zero-entry blockers and exclusion of current ATM context from historical replay.
Actual authenticated feed operation and browser interaction were not tested.
Changes remain local and unpushed.
