# Enhancement review and implementation decisions

This review includes the user's subsequent multi-timeframe update: 15-minute
default view, independent completed 5/15/60-minute assessments and removal of
one-minute strategy analysis and the optional sizing UI. It keeps user-approved
55/15 confirmation thresholds and the technical/sentiment separation. These changes
are explanatory tools and testing infrastructure; they do not establish better
forecast accuracy or profitability.

| Suggestion | Decision and resulting behavior |
| --- | --- |
| Adaptive ML / learn from recent wins | Add chronological offline replay and descriptive performance monitoring first. Do not automatically fit or retune live rules from a small browser ledger. |
| Dynamic ATR/time-of-day parameters | Existing stops and buffers already scale with ATR/price/tick size. Retain numerical rules until separate unseen-session tests justify a change. |
| Intrabar analysis | Keep existing quote-based entries/exits and add observed 30-second quote context. Do not infer traded volume from quote count or spot-index ticks. |
| Depth and option order flow | SmartAPI supports best-five depth, but the current feed does not validate it for these executable contracts. Do not fabricate a liquidity proxy or add an untested entry veto. |
| Risk-adjusted sizing | The optional calculator UI was removed at the user's request. No position sizing or account-risk input is required by the dashboard. |
| 15-minute/hourly exit override | Each 5/15/60-minute model can automatically confirm an opposite setup. An exit requires its full technical gates, a full post-entry candle and a fresh observed quote. One-minute pressure exits are removed; quote-based stops/targets and ATR trailing remain. |
| Instrument-specific parameters | Keep per-contract ticks, exact futures tokens, MCX hours and ATR normalization. Do not insert arbitrary Gold/Natural Gas multipliers. Replay each instrument separately. |
| Contract expiry/rollover | Existing exact-token rollover is retained. Add reminders within three calendar days, expired-contract notice and held/front-contract distinction. Never migrate a held trade's prices. |
| Signal confidence decay | Display objective remaining entry-window time and percentage. Do not rename it probability or alter technical evidence scores just because time passed. |
| Contrarian guardrails | Existing RSI/volatility/conflict disclosures remain. Do not turn sentiment into a veto, contradicting the agreed technical-only confirmation policy. |
| Granular logs / contribution graphics | Add bounded trade state/reason logs, signal timing, downloadable audit data, and separate bullish/bearish contribution bars with fixed group budgets. |
| Backtesting and shock simulations | Add a bounded offline candle-replay CLI with chronological evaluation, costs/slippage, gap/dual-touch exclusions and index/MCX session tests. Its five-minute baseline does not simulate multi-timeframe selection/exits or unavailable tick protections. |
| More sentiment sources | Retain traceable existing feeds; no social-media or expert score is invented, and no new paid provider is required. Add explicit publication-age weighting to the available sources. |
| Sentiment time decay | Apply declared half-lives to sentiment reference contributions only; fresh fetches never reset observation age or technical OI scores. |
| Continuous performance checks | Compare recent and preceding ten settled tracked trades per instrument and timeframe, with sample/session gates. Show an inline review flag; do not pool intervals, auto-tune the agent or claim measured model degradation. |

## New dashboard controls

The prediction card includes these collapsed controls:

- **Agent monitoring · Freshness, results & decision trail**: original issue time,
  true candle close, anchored deadline, observed state changes and tracked R results.
- **Inputs & confirmation checks** and **Sentiment inputs**: group-budget bars show
  how much each group contributes to bullish and bearish support.

The removed risk-budget calculator is not part of the card. The multi-timeframe
panel identifies each interval's direction and confirmation state, selected signal
interval and separately labelled ATM option VWAP context. There is no one-minute
technical panel or one-minute reversal trigger. Among eligible confirmed signals,
the most recent candle close wins; equal closes prefer 15 minutes, then 5 minutes,
then 1 hour. This is selection priority, not a sum of cross-timeframe votes.

The existing evaluation-log download now exports a versioned object with
`assessments` and `tradeTransitions`. Each memory log is bounded to 400 items and
contains no broker credentials. Quote-only updates are not state-change events.
Pending-level changes, entry pauses, invalidation, expiry, entry and exits include
the observed time, exact contract, live/candle price provenance, reason and relevant levels. Loading records does not generate
new transitions. Reload clears the logs; the saved trade ledger remains local.

The monitoring panel also exports the current chart instrument's completed
five-minute candles and exact contract metadata for offline replay. No historical
news/OI/VIX is attached: current data cannot be substituted for a past observation.
Exports cap at the latest 5,000 candles to match the replay tool's input limit.

Observed intrabar context uses only the existing stream. It retains at most 32
exact token/exchange keys with 180 samples each, and requires at least five seconds
within a current 30-second window. Quotes older than 30 seconds, out-of-order or
over one second in the future are rejected. Volume change is shown only from
actual same-session cumulative counters without a reset or missing counter. Sample
count is not trade volume. This readout supplies no additional technical vote.

## Sentiment age weights

Factor = 2 ** (-age / half-life), based on the original publication/observation time.

| Reference group | Half-life | Existing hard age limit remains |
| --- | --- | --- |
| News | 12 hours | 48 hours, plus assessment/context freshness checks |
| Global observations | 24 hours | 4 days, plus source/context freshness checks |
| Published flows/positions | 3 days | 7 days; separately stored flow-trend reports up to 14 days |
| PCR in sentiment | 15 minutes | 30 minutes |

These are experimental transparent defaults, not learned decay estimates.
Observed coverage remains fixed; lost age-weight is not redistributed. Raw news
+ve/-ve badges remain raw impact labels; their contribution in the sentiment view
is age-adjusted. Each input's detail states its observation time, remaining weight
and half-life. Technical PCR/OI and all entry/exit thresholds are unchanged.

## Performance review flag

Only settled `technical-v2` confirmed trades for the selected instrument and
the panel's analysis timeframe enter the comparison. The default cohort is
15-minute; an active/candidate 5-minute or hourly plan uses its own cohort.
Intervals are never pooled. Ambiguous/unverified outcomes, future exits and
legacy one-minute records are excluded. R is booked underlying/futures points
divided by actual entry-to-original-stop distance. No option premium or broker
fill P/L is inferred, and execution costs are absent from the local ledger.

At least 20 settled trades on that interval across three IST sessions are needed. The latest ten
are compared with the preceding ten; a review flag appears for at least five
consecutive losses or a recent mean at least 1R below the baseline mean. These are
explicit experimental review thresholds, not a statistical accuracy test. The
panel refreshes this comparison at minute boundaries and when opened, rather than
sorting the ledger on each quote. It never changes strategy weights, sends an
external alert or places an order.

## Replay and validation

See [Offline strategy replay](strategy-replay.md) for input, commands, fill
assumptions and limitations. The replay engine receives only completed chronological
prefixes. Costs/slippage are explicit user inputs; zero-cost defaults are disclosed.
Unknown intrabar order, missing observations and end-of-data positions do not
become fabricated wins. This is a five-minute entry/stop/target baseline, not an
exact reproduction of the live multi-timeframe selection, opposite-frame exits
or quote-based protection strategy.

Automatic adaptive parameters would need independent future-session validation.
The need to preserve time order is described in
[scikit-learn's time-series evaluation guidance](https://scikit-learn.org/stable/modules/cross_validation.html#time-series-split).
Depth capability is documented in
[Angel One SmartAPI](https://smartapi.angelone.in/docs); supporting an endpoint does
not mean this app has validated that input or that it improves this strategy.
