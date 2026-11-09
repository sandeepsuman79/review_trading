# Chart structure for the five-minute agent

Current policy: `five-minute-candles-v2`; saved trade version: `candle-v2`.
This extends the existing candle-only agent with deterministic chart structure
for Nifty 50, Sensex, Bank Nifty and exact supported MCX contracts. It reads OHLC
numbers, not screenshots or an LLM forecast. There is no minimum entry reward/risk
ratio. Quote/session/expiry safeguards, uncapped profit and price-based TSL remain.

## What the sources contributed

The supplied attachment is technical-analysis reference material. Its discussion
of oscillators, volume, other chart types and top-down analysis does not override
the user's completed-five-minute-candle requirement. The linked sources were
reviewed; selected price-action concepts are implemented as follows:

| ChartSchool reference | Application here |
| --- | --- |
| [Chart analysis](https://chartschool.stockcharts.com/table-of-contents/chart-analysis) | Combine candle patterns with explicit chart context. |
| [Support and resistance](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/support-and-resistance) | Reaction-swing zones, repeated touches and confirmed role reversal. |
| [Trend lines](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/trend-lines) | Two anchors are provisional; three touches validate a line. Do not force a fit or infer reversal from a line break alone. |
| [Gaps](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/gaps-and-gap-analysis) | Track observed opening range gaps and actual fill progress; do not assume every gap fills. |
| [Introduction to patterns](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/introduction-to-chart-patterns) | Pattern context and completed price breaks rather than isolated candle names. |
| [Chart patterns](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/chart-patterns) | Bounded double-top/bottom neckline routes and continuation/reversal separation. |
| [Candlestick charts](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/candlestick-charts) | Candles confirm chart-level acceptance; existing engulfing, rejection, inside-bar and range routes remain. |
| [Chart types](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/chart-types) | Retain ordinary OHLC candles; transformed prices are not execution quotes. |
| [Point and figure](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/point-and-figure-charts) | Reviewed as a different, time-independent representation; it is not mixed into the five-minute policy. |
| [Annotation tools](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/chart-annotation-tools) | Automatic trend lines, swing labels and price zones. Fibonacci, pitchfork and other tools are not new confirmation gates. |

This is an implementation of selected ideas, not every chart pattern in the
catalogue. The numerical tolerances below are explicit engineering choices for
this intraday policy, not rules or performance claims supplied by StockCharts.

## Structure without future data

Use at most 80 contiguous completed trading bars for geometry. Regular overnight
and weekend closures can connect observations; missing intraday bars break the
geometry. Unaligned, invalid, future or forming candles cannot establish a line
or confirm a trade. The 20-bar history and three-current-session-bar readiness
requirements remain.

A pivot high/low must exceed/be below two completed neighbouring bars on each
side. Its label is H/L initially, then HH/LH or HL/LL; prices within one tick of
the preceding same-kind pivot are EH/EL. HH plus HL means uptrend; LH plus LL
means downtrend. Conflicting structure is transition/range/undetermined, not a
fabricated directional probability.

Zone clustering tolerance is the greater of two ticks or 15% of the median
high-low range of the latest 20 completed context bars. A cluster cannot widen
beyond this tolerance by chaining nearby prices. Zone edges cover the clustered
pivots plus one tick. A single pivot is displayed as one touch; repeated pivots
provide stronger context. Two closes beyond the far edge plus one tick flip its
role. A wick or a single close does not.

Signal context excludes the two accepting candles. Their new pivots or levels
cannot be used to justify their own break. The full completed assessment is
available for display and TSL; confirmed trailing pivots still need to form after
entry. No candle high/low replaces an actually observed favourable quote.

## Trend lines and completed patterns

Use at most eight recent same-kind pivots per side. Rising support connects
increasing lows; falling resistance connects decreasing highs. Anchors need at
least four bars of separation. Reject a fit if an intervening/current context
close crosses its protected side by more than zone tolerance, its projection is
nonpositive, or its per-bar slope exceeds 75% of median candle range (minimum one
tick). More recent validated candidates are preferred. Two touches draw a dashed
provisional line; three or more pivot touches permit signal use and a solid line.
Lines use observed trading-bar distance on an arithmetic intraday price scale.

New completed-pattern routes:

- A flipped zone with two swing touches can confirm a held retest and subsequent
  directional break of the retest candle.
- A validated line can confirm a trend pullback only with matching HH/HL or LH/LL
  structure, a touch within tolerance and a close beyond the pullback candle.
- A trend reversal requires two accepted closes beyond both a validated opposing
  trend line and the most recent opposing swing. A slope change alone is not a
  reversal signal.
- Two similar highs/lows, at least four bars apart after a preceding opposite
  approach, remain a potential double pattern until two closes break the
  intervening neckline. Latest acceptance must hold within zone tolerance.

Existing candle routes still operate when no new route qualifies. The accepting
candle must retain the existing 35% body and directional outer-35% close tests.
No volume/RSI/VWAP/ADX/EMA/sentiment score or higher-timeframe gate is added.

## Gaps and risk

Gap context requires a fully observed prior regular session and the current
opening bar, with no missing observations between them. An opening bar wholly
above/below that prior session's range establishes an observed opening range gap.
Track OPEN, PARTIAL or FILLED using only subsequent completed bars. This is a
provisional intraday observation, not an assertion that a completed daily gap or
breakaway/runaway/exhaustion classification is already known. Incomplete previous
sessions produce no gap context.

An applicable unfilled gap edge, nearby opposing zone or swing caps the 2R
reference projection. Reward/risk is informational, with no minimum ratio;
nearby chart targets are retained. Double-pattern invalidation includes its second turning point; a zone
retest includes the zone's far edge. A confirmed opposite pattern can close an
existing position independently of whether a new opposite entry is eligible. TSL and session
square-off priority remain unchanged. See [the full entry/exit rules](candlestick-agent.md).

## Chart, storage and evaluation

On the five-minute chart, automatically draw rising support/falling resistance,
nearest price zones and the latest confirmed swing labels. Dashed lines are
provisional; solid lines have at least three touches. The text names trend, line
status and observed gap state. Other chart intervals do not receive five-minute
geometry. CE/PE continue to show underlying price action, not option candles.
Display annotations are computed for the visible historical prefix with up to
80 earlier context bars and a 500-bar display bound. Older uninterrupted sections
keep their own lines and swings if the newest section has a gap; no line bridges
missing trading bars. Panning into history excludes later candles from annotation
confirmation. All visible confirmed swings can be labelled, rather than only the
last eight in the newest section. Zones reflect the latest completed section in
that viewport. Lines stop at their last completed observation, not a forming bar.
The agent's stricter 80-bar contiguous entry context is unchanged.

A blue dashed **recent price trend** now remains available when a swing-based
support/resistance fit is absent. It is a least-squares line through the latest
up to 12 completed closes in each uninterrupted section (minimum two), ending
at the last completed candle. Its up/down/flat direction is chart context only;
it is not validated support/resistance, a forecast, an entry vote or an exit rule.
The strict green/red pivot lines retain their original validation requirements.

The latest section also shows hollow blue H?/L? candidates on the last two
completed bars when they exceed the preceding two highs/lows and have not already
been invalidated by an observed right-hand neighbour. Candidates can disappear;
they become ordinary confirmed swing labels only after two right-hand closes.
Historical sections retain confirmed annotations, while tentative candidates
belong only to the latest section. Neither candidate nor recent-price guide is
passed into confirmation, risk or TSL calculations.

The chart now consumes the existing stable completed-candle snapshot and a
five-minute clock boundary. The page's one-second heartbeat advances the snapshot
at a close, including when no new tick has arrived; later historical corrections
also invalidate it. Forming ticks do not recalculate the guide or confirm a swing.
The summary shows the actual source-candle close time and the automatic update
behaviour. Missing candles are not generated, and lines do not cross data holes.
Panning into a historical prefix continues to exclude all later observations.


Plots are 520 px tall on desktop and 420 px on compact screens, with matching
vertical scrollbars. Auto-fit uses visible candle bodies, ordinary wicks and a current live quote,
with roughly 20px of price headroom per edge. Distant indicators, projected lines
and trade targets do not stretch the domain. Top grid padding is zero and bottom
padding is 4px. A Fit price control recenters manual vertical panning. Tight index
ranges retain their actual bounds, using the native price axis when no strike
multiple fits inside; the chart is not expanded merely to show a strike.

Index charts default to price focus when an isolated long wick would flatten the
main price action. With at least 12 visible bars, a wick tip is eligible only if
it lies beyond the entire body range by more than the maximum of six median
candle ranges, 25% of body-range span, or two ticks. If more than 10% of bars
(minimum one) have such extremes on the same side, keep that side's full range.
Every open, close and live price stays in view; repeated volatility is retained.
An excluded tip remains unchanged in the candle series/tooltip, receives an
edge label with its actual price and a visible disclosure. Show full wicks restores
the complete range; Focus candles restores the focused view. This is a reversible
display choice, not a correction of exchange data or a change to agent analysis.
Commodity charts retain full-wick scaling by default.
The spaced structure summary reports observed rising/falling/flat movement
separately from confirmed swing trend, and explains missing anchors or invalid fits.
Other intervals explicitly direct users to the five-minute view for annotations.

New records persist the versioned pre-signal chart context. Invalid saved evidence
is rejected rather than reinterpreted. Older candle-v1 and indicator-policy records
keep their policy identity and protection parameters. Monitoring tags decisions
with the current policy; performance cohorts separate versions.

The supplied Nifty file contains 1,187 bars through 5 November 10:35 IST. The v2
fixed-target comparison replay produces 70 confirmed candidates, six entries,
three wins/three losses, +33.87 underlying points and about +0.512R at zero costs.
Maximum realised drawdown is 50.21 points. These six model entries neither prove
better predictions nor validate live TSL or opposite-pattern exits. No settings
were optimized against this file; unseen sessions and live quote ordering remain
unvalidated. [Replay assumptions](strategy-replay.md) explain the restricted fills.

Validation: 223 targeted tests pass: 26 candle/structure/UI, 185 agent/history/
storage and 12 replay tests. A final 23-test engine rerun also passes. Tests cover
mirrored trends, provisional/validated lines, invalid fits, role flips, held/failed
retests, neckline acceptance, line breaks without swing confirmation, missing and
forming candles, gap observation/fill states, persisted old/new evidence and chart
series/annotations. Production build, lint and diff checks pass. The existing Vite
large-chunk advisory remains. Authenticated live feeds and broker fills were not
exercised; there is no prediction-accuracy or profitability claim.

Validation: all 38 candle/chart/domain tests pass, including smooth trends in both
directions across all seven markets, Sensex/Crude five-minute close transitions,
forming/future-bar exclusion, swing candidate confirmation/invalidation, corrections
and data gaps. In an isolated real React/ApexCharts Chrome preview, both Sensex and
Crude Oil advanced from the 13:55 source close to 14:05 over two simulated clock
boundaries without a reload; both recent-guide SVG paths changed automatically.
The preview uses synthetic data, not a live authenticated feed. Build, lint and
diff checks pass; the existing Vite chunk advisory remains. Changes are local
and unpushed.
