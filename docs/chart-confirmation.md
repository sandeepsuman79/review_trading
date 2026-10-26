# Confirmation algorithm: continuation, reversal and transition

Current policy: **adaptive-confirmation-v3**; see [adaptive rules](adaptive-confirmation.md)
for the completed-15-minute regime and bounded score/lead/ADX requirements.
The price-event/indicator rules below remain in effect. The fixed 55/15 and 65/20
figures describe baseline floors, not the actual requirement in every regime.

Preceding policy: `structure-confirmation-v2`. It replaced the earlier
`chart-confirmation-v1` policy for new live setups on Nifty 50, Sensex, Bank Nifty,
Natural Gas, Crude Oil, Gold and Silver. This implements the supplied proposals
as a candidate strategy, not an established improvement in trading returns.

## What changed after reviewing the attachments

The previous policy required EMA20/50 alignment, RSI continuation, ADX/DMI and a
matching higher trend together. It could reject a real reversal while the EMA
crossover, ADX or slower trend lagged. Its ordinary score gate was a support to
opposition ratio, and OI/PCR contributed ten technical points.

The new policy classifies price action first, requires one explicitly configured
indicator, and uses separate score/lead floors. OI/PCR becomes context only.
Changing slope without a confirmed price event remains WAIT.

## Fixed technical score budget

| Technical input | Maximum points |
| --- | ---: |
| RSI level, momentum and confirmed HH/HL/LH/LL swings | 25 |
| Genuine VWAP direction | 25 |
| Completed chart setup, price evidence and structure | 35 |
| Other indicators: SMA, EMA trajectories and Supertrend | 15 |

RSI and VWAP retain exactly 50% together. OI/PCR's former ten points are assigned
to chart/price action as an explicit policy change. This is not redistribution
when a feed is missing. Missing technical inputs still earn no points or coverage.
Other indicators can affect the existing evidence score; only the configured
indicator must pass the additional directional confirmation check.

The legacy no-context scoring API and explicit legacy replay evaluator retain
25 chart / 15 indicators / 50 RSI-VWAP / 10 OI and the old ratio gate for comparison.
The dashboard always supplies the new confirmation context.

## Decision rules

| Rule | Continuation | Early reversal | Transition |
| --- | --- | --- | --- |
| Price event | Accepted two-close range break or genuine EMA20 pullback/reclaim | Confirmed opposing swing structure broken and accepted by two closes | No sufficiently confirmed event |
| Higher timeframe | Fresh, warmed; aligned or neutral, cannot oppose | Fresh, warmed; may oppose | Never substitutes for missing confirmation |
| Selected indicator | Directional confirmation | Momentum/turn confirmation | A turn alone is insufficient |
| ADX14 | At least 20 | No mandatory 20 floor; price structure must prove reversal | Cannot create a setup |
| Supporting score | At least 55 | At least 65 | No trade |
| Lead over opposition | At least 15 points | At least 20 points | No trade |
| VWAP, coverage, risk and live entry checks | All required | All required | WAIT |

The new score/lead gates **replace**, rather than accompany, the old 1.5-times
ratio. For example, 55 support versus 40 opposition passes the continuation
score test, but still needs every price, indicator, VWAP and risk check.
Elevated equity VIX raises continuation floors to at least 65 support / 20 lead;
it never lowers reversal floors or chooses CALL versus PUT.

Five-minute setups use completed 15-minute context; 15-minute setups use hourly
context. Hourly setups use their own completed trend. Higher bias uses EMA20/50,
EMA20 slope and price versus EMA20. A neutral view is not an opposing view, but
missing/stale/insufficient higher history always blocks both setup types.

## Exactly one configured confirmation indicator

`confirmationConfig.indicator` in `src/analysis/confirmationQuality.ts` defaults
to `EMA20_50`. `analyzeMultiTimeframe({ confirmationIndicator: ... })` also accepts
an explicit selection for a caller/test. The dashboard uses the central default;
there is no automatic per-candle search or fallback to another indicator.

- EMA20_50 continuation: price on the trade side of EMA20, EMA20/50 aligned and
  EMA20 slope over three intervals directional. Reversal: price crosses to the
  new side of EMA20 and its three-interval slope turns from flat/opposite to the
  new direction. An EMA20/50 crossover is not required.
- RSI14 continuation: strictly above 50 and rising for CALL; strictly below 50
  and falling for PUT. Reversal: RSI improves versus the previous candle and
  its three-interval momentum turns from flat/opposite to the new direction.
  Crossing 50 is not required for the reversal indicator check.
- SUPERTREND: completed Supertrend direction must agree. If it lags, this mode
  waits; it does not silently substitute EMA or RSI. RSI 70/30 alone never trades.

Indicator comparisons cannot bridge missing candles or session boundaries.
All price-derived indicators still receive their normal warmup for scoring.
When older pattern detectors produce no candidate for a direction, a fully
qualified completed price event can supply its own candidate. This prevents
their older combined-indicator routes from silently vetoing the explicitly
selected mode. Existing rejected side-specific targets are never replaced by
this fallback. New event candidates use their price invalidation and known
opposing levels, or an explicitly labelled 2R projection when no cap exists.

## Price event and entry quality

Only completed candles are used, with 50-bar indicator warmup and at least three
consecutive current-session price bars. Higher views each need their own 50 bars.

Continuation accepted break: prior and latest closes beyond the preceding ten-bar
high/low plus 0.05 ATR. Latest retest may penetrate at most 0.25 ATR. Initial
break range must not exceed 2 ATR. Pullback: an actual counter-direction candle
within the previous four bars touches EMA20, holds within 0.25 ATR, then the
latest close breaks the preceding candle's high/low by 0.05 ATR.

Reversal: inspect up to 48 consecutive current-session bars before the two break
candles. A high/low pivot requires two completed bars on either side and must be
known before the first break. CALL requires prior LH/LL (or LH plus a subsequent
HL after a prior LL), then two closes above the known swing high. PUT mirrors
HH/HL and a break of the swing low. The close before the break must not already
be beyond that level; a stale accepted break is not a fresh reversal. The latest
retest must hold within 0.25 ATR. The opposite confirmed swing supplies the
structural invalidation. Merely breaking an arbitrary recent candle is insufficient.

For both types: distance from EMA20 <=1.5 ATR; signal range <=1.8 ATR; opening gap
<=0.5 ATR; directional body >=35% of range; close position >=65% toward the trade
side. A first impulse, wick-only break or changing slope cannot bypass these rules.

MCX requires actual contract volume relative to the previous up-to-20 positive
volume observations, with at least six available: >=1.2x for breaks/reversals,
>=0.8x for pullbacks. This baseline is not adjusted for intraday seasonality.

## VWAP, context and execution boundaries

MCX uses genuine session volume-weighted futures price for the exact contract.
Spot indices have no traded volume: paired current-ATM CE/PE premium VWAP remains
an explicitly labelled option-context proxy, not an underlying index VWAP.
CE above its own VWAP with PE below supports CALL; the inverse supports PUT.
Both types require matching, fresh, full-session option context; mixed, missing,
wrong-strike or stale data blocks entry. A separate genuine underlying/futures
VWAP feed is not connected; no index volume or historical proxy is invented.
The confirmed two-close structure-level acceptance supplies price-level evidence
for reversals; a historical option-VWAP crossing is not claimed.

Equity market context uses FII/DII 40 / GIFT Nifty 30 / global markets 15 / news 15.
GIFT is excluded from the global group. PCR/OI remains reference-only with zero
market-context weight. Observations decay with age and missing context is not
reweighted. Full coverage can reach 100% with all sub-inputs available. Commodity
context retains its previous news/benchmark budgets and does not use GIFT or
equity flows. Context state is SUPPORTIVE_BULLISH, SUPPORTIVE_BEARISH,
MIXED (including insufficient coverage), or HIGH_RISK for fresh elevated equity
VIX. India VIX adds zero directional points. MCX excludes equity flows and VIX.

Technical coverage must be >=70%. Valid structural stops cover at least one ATR;
reversal stops additionally cover the confirmed opposite swing, rounded outward.
Planned and actually observed entry reward/risk must remain >=1.20:1. Targets are
not extended to compensate for widening a stop. Contract tick rounding, current
entry windows, unconsumed signal, stream/quote freshness and one open position
per instrument remain required. No spread feed, monetary risk budget or live
cost estimate is available, so this does not claim spread-aware, budget-aware
or after-cost live approval. Offline comparison accepts explicit point costs.

## Existing positions, history and diagnosis

Open trades retain uncapped profit, initial SL/TSL, +1R break-even, manual and
session/contract exits. A reversal exit requires a fully confirmed opposite setup
whose complete signal candle formed after entry, on the exact same contract.
A slope turn or market-context change alone cannot exit a trade.

New saved snapshots record policy, setup type, selected indicator, structural
levels, base score floors and passed price/VWAP evidence. V1 snapshots and older
records remain readable. Context state is also retained in evidence summaries.
No actual Angel One order placement is present.

Expand **Today's trade quality audit**, then **Review today's trades** and
**Download trade audit** for the current selected instrument. The audit reads
actual browser entries/outcomes and applies the current price policy only to
candles closed at each signal time. Missing history or wrong MCX expiry is
UNAVAILABLE. It does not reconstruct historical ATM/OI, infer unobserved fills,
or count blocked historical losses as avoided losses. Actual browser trade
records were not accessible from this workspace, so today's losses were not
independently attributed to any rule.

`npm run agent:compare -- candles.json --output comparison.json` compares the
explicit legacy and current entries chronologically, with identical supplied
costs and the same fixed-target comparison exits. It does not simulate live
open-profit tick TSL. Index replay needs genuine archived ATM snapshots fetched
by each evaluation time. Future context cannot be substituted.

Validate continuation and reversal separately on development and later holdout
sessions, including costs, drawdown, unknown outcomes, expiry/high-volatility
days and trade counts. Passing synthetic regression tests does not establish
profitability, predictive accuracy or an ability to capture every market move.

## Primary references

- [ChartSchool: technical indicators](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/introduction-to-technical-indicators-and-oscillators): confirmation, sensitivity and lag.
- [ChartSchool: Moving Momentum](https://chartschool.stockcharts.com/table-of-contents/trading-strategies-and-models/trading-strategies/moving-momentum): trend, correction and confirmation stages.
- [ChartSchool: ADX](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/average-directional-index-adx): strength versus direction.
- [ChartSchool: VWAP](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/volume-weighted-average-price-vwap): genuine intraday volume weighting.
- [NSE: India VIX](https://www.nseindia.com/static/products-services/indices-indiavix-index): expected volatility over the next 30 calendar days.

The intraday thresholds, reversal detector, ATM adaptation and technical/context
budgets are this project's design choices, not settings endorsed by these sources.
