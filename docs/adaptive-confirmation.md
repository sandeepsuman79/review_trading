# Bounded adaptive confirmation

Current policy: `adaptive-confirmation-v3`. The live dashboard uses it for Nifty
50, Sensex, Bank Nifty and all four supported MCX futures. Explicit FIXED mode
retains the preceding structure-confirmation-v2 gates for comparison. V1, v2 and
older trade records remain readable. No broker-order placement is added.

## Decision: adapt the gates, do not remove them

A slope change alone identifies a possible transition. Continuation requires an
accepted price event and the selected indicator. Reversal requires a fresh,
accepted break of known opposing swing structure and a momentum turn. Removing
score/lead gates would allow more weak or conflicting candidates through, without
establishing that those additional trades have positive expectancy.

The previous lower bounds remain: continuation 55 support / 15 lead; reversal 65
support / 20 lead. Requirements increase for volatility/chop, capped at 80 support
and 30 lead. There is no forced trade after a quiet period and no assumption that
any policy can capture the first turn or every price move.

RSI structure 25%, VWAP 25%, chart/price action 35% and other indicators 15% are
unchanged. Market context remains FII/DII 40%, GIFT Nifty 30%, global markets 15%
and news 15% for equity indices. Context does not become a technical directional
vote or reduce the gates after a headline refresh. Existing fresh elevated-equity
VIX protection still requires at least 65 support / 20 lead. MCX excludes equity
VIX, GIFT and equity flows.

## Stable regime inputs

All strategy intervals use the latest completed 15-minute regime candle available
at their signal's close. Five-minute bars can still create five-minute entries;
hourly signals keep their own price/higher-context rules. The regime does not use
forming candles, live tick extrema, current option-VWAP proxies as historical
index volume, or future public context. Between regime closes, the same unchanged
historical data produces the same regime inputs; reload does not invent history.
Feed corrections may change a historical input and therefore its diagnosis.

Features:

- ADX14 and EMA20/50 with EMA20 slope identify strength and direction separately.
- Relative ATR `V = current ATR14 / median(previous 50 valid ATR14 observations)`.
  The current ATR is excluded from the baseline. At least 50 prior valid ATR
  values are required; 50 raw candles alone do not provide that many ATR values.
- Chop `C`, between zero and one: direction-change frequency across up to twelve
  completed current-session close changes. Changes smaller than 0.03 ATR are
  treated as noise. At least six contiguous changes are required; a flat sequence
  is choppy rather than a fabricated directional trend.
- For MCX only, genuine same-session futures-VWAP crossing frequency can raise
  chop. Index spot volume and historical option crossings are never invented.

Regimes: STRONG_TREND, TREND, RANGE, HIGH_VOLATILITY, WARMING_UP or UNAVAILABLE.
A relative ATR at least 1.5 indicates high volatility. Chop at least 0.5 or ADX
below 20 identifies a range. ADX at least 25 and a directional EMA trend identify
a strong trend when the volatility/range conditions do not take priority.

Relative ATR at least 2.5 or chop at least 0.8 blocks new confirmation, regardless
of technical score. Known extremes cannot be ignored while another feature warms
up. A missing or stale regime candle blocks confirmation. An incomplete ATR/chop
baseline uses labelled conservative floors: continuation 60/20, reversal 65/20;
known high volatility raises that fallback to at least 65/20 and continuation
ADX22. Unknown ratios are not shown as zero or one.

## Candidate formulas

Let `X = max(0, V - 1)` and `H = 1` only when the completed higher context supports
the trade and the regime's EMA direction agrees. Hourly setups use their own
context. `ceil` rounds a required score/lead upward and `clip` enforces bounds.

Continuation:

```
score = clip(ceil(60 - 0.4*max(0, ADX-20) + 8*X + 10*C - 5*H), 55, 80)
lead  = clip(15 + ceil(5*C + 3*X + (H ? 0 : 3)), 15, 30)
ADX floor = clip(20 + 2*X + 5*C - (aligned strong trend ? 2 : 0), 18, 25)
```

Range regimes require at least 65 support / 20 lead. High volatility additionally
requires support at least `clip(65 + ceil(4*(V-1.5)), 65, 80)`, lead at least 20
and continuation ADX at least 22. These explicit floors prevent strong ADX from
cancelling the volatility penalty in the linear formula.

Proven reversal:

```
score = clip(65 + ceil(4*X + 5*C), 65, 80)
lead  = clip(20 + ceil(4*C + 2*X), 20, 30)
```

A reversal does not need an EMA20/50 crossover, ADX20 or an aligned slower trend.
It still needs fresh, warmed higher data, a confirmed structure break/retest,
the configured momentum confirmation, genuine VWAP, coverage and risk checks.
A slope-only transition remains WAIT. The stricter score can still reject a weak
or expensive early turn; no claim is made that the first turn will be captured.

These coefficients are transparent experimental settings adapted from the user’s
proposal, not parameters fitted to today's losses or endorsed by an indicator
provider. Score remains an evidence rating, not a probability or expected value.

## Risk and open trades

Technical coverage remains at least 70%. Current price-event, selected-indicator,
VWAP, volume, freshness, entry-window and one-position requirements remain.
The initial stop already varies with structural invalidation and current ATR,
rounded outward, and covers at least one ATR. A reversal also covers the opposite
confirmed swing. Reference targets remain observed levels or explicitly labelled
projections; they are not extended to force approval after a stop widens.

The user's approved minimum reward/risk stays **1.20:1**, rechecked after contract
rounding and at the actual observed entry quote. This is underlying/futures point
risk, not option-premium risk. No option spread/Greek/cost model, account position
sizing, rupee risk budget or daily monetary-loss limit is fabricated. No claim of
after-cost option execution is made. Those controls need their own actual data
and configured monetary limits before broker automation could be considered.

TSL and uncapped profit are unchanged. New-entry WAIT conditions do not disable
existing trade protection, actual stop exits, manual exit or session square-off.
A reversal exit still needs a complete post-entry, fully confirmed opposite setup
and a fresh matching observed quote. Threshold changes alone do not close a trade.

## Review and validation

The card shows regime, regime-candle close, ATR ratio/baseline readiness, chop,
ADX floor and actual score/lead requirement. New trade snapshots persist these
features, base thresholds and actual VIX-adjusted thresholds. Record validation
rejects future/invalid regime metadata while preserving the existing ledger.

```
npm run test:confirmation
npm run agent:compare -- candles.json --output comparison.json
```

The comparison reports legacy, fixed-v2 and adaptive-v3 entries on the same
chronological candles and supplied costs. All three use the same **fixed-target
comparison exits**; this does not simulate live tick TSL or option-premium P/L.
Historical ATM context must have been genuinely archived by each evaluation time.
No current news, VIX or flows are inserted into historical evaluations.

Validate fixed versus adaptive separately on development and later holdout
sessions, including trade counts, expectancy after costs, drawdown, losses,
unknown outcomes, reversals, chop and expiry/volatility conditions. Workspace
regression fixtures cannot establish improved live returns or explain private
browser trades that were not provided.

Primary concepts: [ChartSchool ADX](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/average-directional-index-adx)
distinguishes trend strength from direction; [ChartSchool True Range](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/true-range)
describes the volatility input smoothed into ATR. The intraday formula, bounds
and software policy above are this project's own test settings.
