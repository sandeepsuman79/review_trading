# Trading Prediction Agent: rules to verify

This describes the implementation in this checkout, including the late-entry
fixes, the multi-timeframe update from 16 October 2026 and the RSI/VWAP weighting
and ATM display fixes from 22 October 2026. It applies to Nifty 50, Sensex, Bank Nifty, Natural Gas,
Crude Oil, Silver and Gold. It does not certify the version currently deployed on
Render or establish prediction accuracy.

## 1. What the agent actually does

It is a deterministic rules engine. Gemini provides optional commentary and news
assessment; it does not decide a technical entry or protective exit. Bullish and
bearish scores are evidence ratings, not probabilities.

- The chart and default technical review use **5 minutes**. Changing the displayed interval changes
  the view, not which intervals the agent evaluates.
- The agent independently evaluates completed **5-minute, 15-minute and 1-hour
  candles** for each instrument. Either direction can confirm automatically on any
  eligible interval; scores are not added across intervals and agreement from all
  three is not required.
- There is no one-minute strategy analysis, background candle sync or one-minute
  signal-based protective exit. Old one-minute ledger records remain readable.
- Actual stream quotes check entry eligibility, stops and trailing protection.
  Targets remain entry reward/risk references; open trades have no fixed profit cap.
- Forming candle extremes can cancel an invalid/finished entry idea. A forming
  candle cannot confirm a new entry.
- The dashboard must remain running. Trade tracking is browser-local and sends no
  broker orders. Index setups track underlying points, not option premium P/L;
  commodities track the resolved MCX futures contract's price points.

A 09:55–10:00 five-minute candle can confirm only after 10:00; a 10:00–10:15
fifteen-minute candle only after 10:15. Waiting for the selected signal candle to
close is intentional. Among eligible confirmed setups, the most recently closed
signal wins. Equal close times prefer 5 minutes, then 15 minutes, then 1 hour.
The setup and ledger retain that signal's actual timeframe.

## 2. Candle data, structure and levels

`priceAction.ts` excludes forming candles, calculates indicators from saved completed
history, and uses the latest 180 bars for short-term structure. Session levels use
full saved history. Swings require two bars on each side; they are not known at the
pivot's own timestamp.

- Higher high + higher low: uptrend.
- Lower high + lower low: downtrend.
- Higher high without a higher low, or lower low without a lower high: transition.
- Otherwise: range or insufficient structure.
- Support/resistance combine confirmed swings with eligible previous-session levels.
- Level tolerance = max(25% of the last-ten-bar mean range, price × 0.00015).
- Pattern buffer = max(8% of that mean range, price × 0.00003).
- Location records near support, near resistance, between levels or no nearby level.
- Candle behavior describes body, wick and close location. For example, a body at
  most 10% of range is doji/indecision. That alone is not a CALL or PUT signal.

## 3. Completed price setups

Both directions are evaluated independently. An eligible original chart selection
retains priority; otherwise an eligible alternate candidate can be selected. All
families still need the technical gates in section 6.

| Family | Bullish event | Bearish event |
| --- | --- | --- |
| Breakout/breakdown retest | Previous close above prior range; latest retests and closes bullish above it | Mirrored below the range |
| False break | Previous breaks below support and recovers; latest closes above its high | Previous breaks above resistance and fails; latest closes below its low |
| Support/resistance rejection | Lower-wick rejection plus higher bullish close, or bullish engulfing near support | Upper-wick rejection plus lower bearish close, or bearish engulfing near resistance |
| Trend pullback | Uptrend, near support, bullish close above previous high | Downtrend, near resistance, bearish close below previous low |
| Range rejection | Range, near support, bullish close above previous high | Range, near resistance, bearish close below previous low |
| Compression break | Bullish close above the prior range after compression | Bearish close below it |
| Momentum break | Directional close beyond the preceding three-bar high | Directional close beyond the preceding three-bar low |
| EMA pullback reclaim | Prior candle touches EMA20; latest breaks its high with an EMA route | Mirrored reclaim downward |
| Opening range | First completed close through the actual first 15-minute range high | First close through its low |
| Level break/reversal | Current support reaction or resistance break route | Current resistance reaction or support break route |
| Local trend continuation | Fresh close through the previous high with continuing upward progress, RSI and an eligible route | Mirrored fresh break through the previous low |
| Directional impulse | Strong completed expansion through the prior three-bar high, with improving directional RSI and an eligible route | Mirrored break below the prior three-bar low |
| Three-candle reversal | Strong opposing first body, small middle at support, upward confirmation through first-body midpoint and middle high | Mirrored at resistance |

The prior range for the original families is `slice(-22, -2)`. Compression means
last-five average range ≤70% of the preceding-ten average; expansion means latest
range ≥1.35 times the preceding-ten average.

The five added momentum/reclaim/opening-range/level/three-candle families require
50 bars, ATR/RSI/ADX/DMI/EMA readiness and three consecutive same-session bars.
The three-bar range break separately requires all four input bars in this session;
each alignment route retains its own continuity requirement. These five families
reject range >2 ATR, body <40% of range, or distance from EMA20 >1.8 ATR. The close
must be in the directional 65% of the candle range. Their break buffer is
max(0.05 ATR, price × 0.00003). Opening bars must actually be present: 09:15–09:30
for indices, 09:00–09:15 for MCX.

Internal pattern-ranking scores are distinct from the technical evidence scores.
Exact predicates and ranking adjustments: [priceAction.ts](../src/analysis/priceAction.ts)
and [momentumSetups.ts](../src/analysis/momentumSetups.ts).

The continuation and impulse families additionally use four consecutive completed
same-session bars. Both reject an opening gap greater than 0.5 ATR or distance
from EMA20 greater than 3 ATR, and require a current matching alignment route.
Continuation needs a fresh break of the previous candle high/low, a directional
body ≥35% of range, directional close location ≥65%, range ≤1.5 ATR, RSI on the
matching side of 50, ≥0.25 ATR progress across three intervals, and at least two
directional close improvements. EMA20 must progress with the move or Supertrend
must hold on the correct side across all four bars.

Impulse requires range >1.5 and ≤3 ATR, body ≥65% of range, a close in the
directional 80% of range, RSI on the matching side of 50 and improving from the
previous bar, and a fresh break beyond the prior three-bar range. Stops cover the
local structural extremes and at least 1 ATR. Eligible observed targets remain
caps; only an absent target permits a labelled 2R projection. All existing score,
coverage, freshness, entry-window and reward/risk checks still apply. Source:
[trendSetups.ts](../src/analysis/trendSetups.ts).

## 4. Directional alignment: OR between routes

At least one route must match the completed pattern's direction:

- EMA20/50 crossover, or a three-bar trajectory with EMA50 flat/moving compatibly.
- Fast EMA20 turn: preceding three-bar slope opposes the direction, current
  three-bar slope turns with it, and price breaks EMA20 and the preceding high/low
  with improving RSI. Requires seven consecutive same-session bars.
- Supertrend flip, a three-bar trajectory with price on its indicated side, or
  four completed bars holding the same Supertrend side with directional RSI, a
  fresh break of the previous high/low and ≥0.15 ATR net price progress. A flat
  Supertrend band does not by itself cancel an otherwise qualified continuation.
- Break through a previously known resistance/support, or a confirmed reaction at
  support/resistance. Reactions require price improvement and a close in the
  directional 55% of range, no farther than 1.5 ATR from the level.

Trajectory noise band: **0.03 ATR**. Price-break buffer:
max(0.05 ATR, price × 0.00003). No route compares across missing bars or sessions.
EMA, Supertrend and DMI do not all have to agree. A crossover alone cannot enter.
Source: [directionalAlignment.ts](../src/analysis/directionalAlignment.ts).

## 5. Bullish/bearish score calculation

Each signed input is clipped to [-1, +1]. A positive contribution goes to bullish
support, a negative one to bearish support; neutral is zero. Missing input earns
no coverage or points and its weight is not redistributed. Scores round to one decimal.

| Technical input | Maximum points out of 100 | Vote |
| --- | ---: | --- |
| Completed price setup | 11.25 | CALL +1; PUT -1; WAIT 0 |
| Non-indicator chart evidence | 8.75 | Split proportionally between bullish/bearish evidence counts |
| Price market structure | 5 | Uptrend +1; downtrend -1; other 0 |
| Price vs SMA20 | 1 | Sign of price minus SMA20 |
| Price vs EMA20 | 1 | Sign of price minus EMA20 |
| EMA20/50 alignment and EMA20 slope | 5 | Mean of alignment and latest slope signs |
| EMA20/50 trajectories | 2 | Mean of three-bar trajectory signs |
| Other turns/crossovers | 1 | Mean direction of detected non-RSI/non-VWAP turns; no turn 0 |
| RSI14 | 8 | (RSI − 50) / 20 |
| RSI momentum | 7 | (current RSI − RSI three bars ago) / 8 |
| RSI swing structure | 10 | HH/HL +1; LH/LL −1; mixed 0; confirmed break overrides prior trend |
| Supertrend(10,3) | 5 | UP +1; DOWN -1 |
| Session VWAP | 25 | Indices: paired default ATM CE/PE direction; MCX: sign of price minus futures VWAP |
| PCR | 6 | (PCR − 1) / 0.5 |
| Call/put OI change balance | 4 | (put change − call change) / (absolute changes total), using 1 if that total is zero |

**RSI including its swing structure is 25%; VWAP is 25%: together exactly 50%.**

This changes each input's contribution to the existing 100-point evidence score.
It does not set confirmation to 50 points, lower a score/lead cutoff, or award
50 points automatically. RSI can contribute up to 25 points and VWAP up to 25;
actual support/opposition depends on their observed signals. The other inputs
share the remaining 50 points, and all existing confirmation checks still apply.
For example, if a rule requires support ≥55 and lead ≥15, those cutoffs remain
55 and 15 after increasing RSI/VWAP weights. In this checkout, STANDARD confirmed
setups already use positive support ≥1.5× opposition; EARLY ideas retain 55/15,
and elevated India VIX retains 65/20. The weighting change does not alter any of
these rules.

The four group budgets are **chart 25, other indicators 15, RSI structure + VWAP 50,
OI/PCR 10**. Index ATM validation uses the fresh request’s reference index quote,
so an older 15-minute/hourly close cannot reject the current ATM strike. RSI swings use the existing same-session confirmed indicator pivots
(up to 32 completed bars; one-point RSI noise). Missing pivots earn no structure
coverage or points. A break below the last HL votes bearish; a break above the
last LH votes bullish. Forming candles cannot change this vote. The same fixed
weights apply on 5/15/60-minute setups and fully confirmed opposite setups used
for reversal exits. Stops, ATR trailing protection and scheduled exits
continue independently of directional scores.

OI must be fresh, match the underlying and have an unexpired expiry. OI totals,
walls and max pain are context; OI change alone does not prove option writing.

ADX/DMI describe trend strength/direction and participate in setup readiness,
risk disclosures and historical matching. They do not have another independent
technical score allocation. ATR and India VIX are risk inputs, not directional votes.

Indices default to nearest-expiry ATM CE/PE VWAP for their 25-point VWAP allocation.
CE above its own VWAP and PE below supports bullish analysis; the inverse supports
bearish analysis; mixed legs are neutral. Premiums are never compared with spot points.
MCX uses actual futures volume; equity option-chain OI/PCR is not connected for MCX
and contributes no points. FII/DII and India VIX are excluded for commodities.
Source: [tradingEvidence.ts](../src/analysis/tradingEvidence.ts).

## 6. All requirements for a fully confirmed setup

1. Completed price pattern and a matching alignment route.
2. At least 50 completed bars, warmed EMA20/50, RSI/momentum and Supertrend.
3. Latest completed candle is current; final two bars are consecutive in the current
   IST session. New setups cannot be produced from an old saved chart.
4. Technical coverage ≥70%.
5. STANDARD: positive supporting score ≥1.5× the opposing score. This replaces the normal 55-score / 15-point lead floors; 15 versus 10 qualifies directionally. Zero versus zero never qualifies.
6. STRONG classification: support ≥60 and lead ≥20; it does not bypass other gates.
7. If equity India VIX ≥25 or its daily change ≥+10%, require support ≥65 and lead ≥20.
   Missing VIX is disclosed; it does not manufacture a low-volatility reading.
8. Positive valid entry/stop/target in the correct directional order.
9. Stop covers structural invalidation and at least 1 ATR14, rounded outward.
10. Planned reward/risk ≥1.20 after ATR adjustment and broker tick rounding. An observed
    opposing level remains a target cap; it is not moved farther to force approval.
11. Entry hours: indices weekdays 09:15–15:15 IST (application cutoff); MCX weekdays
    09:00–23:30 or 23:55 IST according to configured US daylight-saving handling.
12. Valid exact, unexpired MCX futures contract for a commodity.

These requirements apply independently to each of the three analysis intervals.
There must be at least 50 completed bars on that interval; 50 five-minute bars do
not warm up the hourly model. The visible seven-check count groups these
conditions. Four out of seven cannot create a fully confirmed trade by itself.

## 7. Entry is separate from setup confirmation

A confirmed setup first becomes PENDING. It becomes ACTIVE only on an eligible
observed quote after issue. Entry requires a connected stream, quote ≤30 seconds
old, matching instrument/contract, current revalidation checked ≤30 seconds ago,
identical signal/side/levels, trigger reached, no invalidation and actual-quote
reward/risk ≥1.20. Revalidation must match the chosen signal's actual timeframe.
One open position per instrument is permitted across all intervals; it must close
before another can enter. A chart interval change cannot reopen an old signal.
After an agent-confirmed reversal exit, the exited side cannot reopen from another
timeframe's candle that closed at or before that exit. This prevents an older
bullish frame from immediately reopening a CALL after a confirmed bearish exit,
and applies symmetrically to PUT/SHORT. An eligible opposite-side replacement may
proceed immediately; a newly completed candle can qualify the previously exited
side again. The guard is signal-time based, not a fixed cooldown or direction ban.

Late-entry protections added in this review:

- Technical entry expiry is anchored to the **next candle close**, not repeatedly
  extended from the render time. For a 09:55–10:00 signal, entry must occur before
  10:05, and before the relevant session/contract cutoff. A 10:00–10:15
  fifteen-minute signal has a 10:30 deadline; hourly signals use their own next
  close. These are signal-specific deadlines, not a universal five-minute window.
- A pending setup is retired if its target is reached before entry, including when
  entry was paused. It cannot enter when price later retraces to its trigger.
- Post-signal OHLC extremes, including observed forming-bar extremes, retire an
  already-finished/invalidated pending setup even after reconnect or late loading.
- The signal candle itself is excluded from this post-signal invalidation scan.
- Finished, expired, ambiguous and unverified ledger signals do not appear as fresh
  confirmed cards. The same signal cannot be reopened.
- The displayed pending setup time uses its original issue time. “Candle closed”
  displays the candle's close time, rather than its opening timestamp.
- A reconstructed historical entry cannot issue a fresh “confirmed trade” alert.
  If replay discovers an entry and exit together, only its recorded outcome is
  announced. Live entry alerts require a still-open trade, an actual live entry
  and an entry timestamp no more than 30 seconds old. A later live quote cannot
  relabel a candle-reconstructed entry as a newly observed live entry.

Sources: [setupTiming.ts](../src/analysis/setupTiming.ts),
[predictionHistory.ts](../src/analysis/predictionHistory.ts),
[tradeEntry.ts](../src/analysis/tradeEntry.ts).

## 8. Exits and booked points

Existing positions continue monitoring even while the entry model says WAIT.

- Original stop and scheduled square-off take priority. Crossed stops use
  actual observed quotes. The setup target remains an entry reward/risk reference;
  reaching it after entry never closes the trade or caps booked points.
- A current fully confirmed opposite 5-minute, 15-minute or 1-hour plan can exit,
  without first opening its replacement. A full candle formed after entry,
  correct contract and fresh live quote after its close are required.
- Each reversal candidate passes its own full pattern, coverage, score, ATR and
  reward/risk gates. A direction vote, developing candle or disagreement between
  intervals alone cannot close a trade. The one-minute pressure exit is removed.
- ATR trail: initialize automatically at observed confirmed entry, keeping the initial
  stop. Tighten after observed favourable movement; distance is
  max(1.5 × eligible timeframe ATR, 0.35R, two ticks). Use a current matching
  completed-frame assessment, then the saved protective ATR, entry ATR or initial
  risk when unavailable. At 1R the stop cannot stay behind entry.
  It only tightens and never invents an unobserved favourable extreme.
- Reversal revalidation and the matching live quote must be current (≤30 seconds
  old). The confirmed candle must remain current for its own interval and be
  wholly after entry. The price can gap beyond a protective stop.
- Gaps/missing observations are replayed conservatively. Saved stops are checked
  before each completed close can tighten the trail for the next bar. Unknown
  entry/stop ordering is AMBIGUOUS or UNVERIFIED, not an invented winning fill.
- Points = (exit − entry) for CALL/LONG, (entry − exit) for PUT/SHORT. These are
  underlying/futures points; no option premium return or broker execution is inferred.

The entry-active TSL, 1R break-even and ATR parameters are experimental, not an established optimum.
Sources: [predictionHistory.ts](../src/analysis/predictionHistory.ts),
[tradeProtection.ts](../src/analysis/tradeProtection.ts).

## 9. ATM CE/PE VWAP context

For Nifty 50, Sensex and Bank Nifty, resolve actual nearest-expiry CE/PE tokens at
**the current ATM strike** (50-point Nifty steps, 100-point Sensex/Bank Nifty steps).
Refresh the pair every ten seconds using SmartAPI FULL quotes: each leg's broker
session average price (`avgPrice`), cumulative traded volume (`tradeVolume`), LTP
and IST exchange trade timestamp. Polls never count as trades or add volume.
CE above its own average plus PE below its own average supports upward context;
the inverse supports downward context; disagreement is mixed.

If a broker average is absent, load sum(HLC3 × actual one-minute volume) /
sum(volume) separately, from 09:15 through the latest available completed minute.
Fallback candle requests share the history queue, overlap the last saved minute
and run at most once per minute for each session/contract pair. They never block
subsequent quote heartbeats. Live LTP can update against the saved candle VWAP;
its exchange timestamp is checked independently from the VWAP timestamp.

Both legs need positive volume, current expiry, the exact current ATM strike,
and current-session data younger than two minutes. A candle-derived average also
requires contiguous coverage from open. Partial/stale data supplies no points.
The display identifies the source, strike, expiry, LTPs and timestamps. Before
open, after close and on weekends, the latest available session can remain visible
but cannot earn current-session points. Chart and agent consumers share pending
requests across heartbeat/minute boundaries, scoped by login, index and strike.
Missing contracts, volume and broker outages cannot produce an invented VWAP.
Raw one-minute option candles are volume input, not a strategy timeframe. This
paired direction supplies the existing 25-point technical VWAP allocation on each
strategy timeframe; confirmation thresholds and the RSI 25-point budget are unchanged.
Sources: [atmVwap.js](../server/atmVwap.js), [atmVwap.ts](../src/api/atmVwap.ts),
[SmartAPI market data](https://smartapi.angelone.in/docs).

Index spot candles report no traded volume, so option-premium prices and VWAP
must use their own price axis. A single chart area uses the existing
**CE / expiry / PE** switch: CE shows the current ATM call; PE shows the current
ATM put; the expiry button returns to the index chart (the initial view). There
is no separate ATM panel. Option views use the selected 5/15/60-minute interval,
actual option candles, per-candle volume bars, candle-volume VWAP and
EMA/RSI/Supertrend metrics. The index VWAP control selects the ATM CE view. The ATM card
and chart header show the separate CE and PE cumulative session volumes.
The displayed option VWAP line is the HLC3 candle estimate, while the live card
can use the broker session average; these sources are labeled separately.

Only the visible ATM chart requests option history, once per minute with a
publication grace. Requests share pending work across minute boundaries, scope
caches by login/index/strike/expiry/token/interval, overlap the last broker bar,
and accept corrections without adding the same volume twice. Switching ATM
strike loads that contract's actual history; charts never splice different
strikes together. History reads cannot block the ten-second live quote feed.
Chart warmup uses only available history for that actual contract.

An unavailable ATM feed removes the 25-point VWAP input from evidence coverage;
with missing OI/PCR or RSI structure this can prevent reaching 70% coverage even
in a strong price trend. The agent now shows specific missing/old CE/PE values,
volume, expiry or timestamp reasons alongside its existing setup diagnostics.
Tests confirm that all three zero-volume spot indices can produce bullish and
bearish confirmed setups with current ATM volume context, without lowering any
confirmation, freshness, risk or coverage requirement. Option-chart indicators
are display context; they do not create an additional strategy or independent
entry/exit score.
Sources: [IndexOptionChart.tsx](../src/components/IndexOptionChart.tsx),
[atmOptionCandles.ts](../src/api/atmOptionCandles.ts),
[CandleVolume.tsx](../src/components/CandleVolume.tsx),
[tradingEvidence.ts](../src/analysis/tradingEvidence.ts).

Historical chart sync now checks every 15 seconds while visible and on focus,
reconnection and authentication changes. During exchange hours, a completed
5/15/60-minute candle becomes due after a five-second publication grace; the
shortened final bar is also reconciled after close. Only successful broker
responses advance the incremental cursor; live ticks cannot conceal unsynced
history. An individual request timeout cancels that request and permits retries
and subsequent instruments to continue. The selected chart shows its latest
successful historical response time and the returned candle coverage time. Authentication failures pause automatic
retries until credentials change or a manual refresh is requested.
Sources: [historySync.ts](../src/analysis/historySync.ts),
[PredictionPage.tsx](../src/pages/PredictionPage.tsx).

## 10. Sentiment, early ideas, history and gap outlook

Sentiment remains separate: flows 30%, news 30%, global 30%, PCR reference 10%.
It requires ≥40% coverage and a sufficiently observed non-PCR group; a lead below
15 is neutral. It cannot create, veto or close a technical trade. Sources retain
publication times; polling each minute does not mean new news/flow reports exist.
MCX uses commodity-specific news/global benchmarks and excludes equity flows.

EARLY candidates need 30 bars, 60% coverage, initial EMA20/RSI/Supertrend readiness,
55 support/15 lead (high-VIX limits still apply), route, freshness, ATR and hours.
RISKY ideas require ≥4/7 checks, 50-bar warmup, level touch within 1.5 ATR, matching
route, ≥40 support/10 lead and valid ATR/RR levels. Both remain conditional ideas;
neither enters confirmed history or opens a trade until full confirmation.

Historical comparison uses similar candle/indicator conditions and three-bar,
same-session outcomes, excludes overlapping outcome windows and uses an embargo.
At least 30 cases over three sessions are required for displayed rates. They cannot
override a missing current pattern, expired setup or invalid risk/quote. They do
not establish real-time trade accuracy.

The separate equity-index next-session gap outlook is available any time after
15:00 IST and updates from current external sentiment: FII/DII, news, global
markets including GIFT Nifty, and available PCR reference. No completed index
chart is required. It refreshes overnight until the next weekday open, uses
publication-age and coverage checks, and cannot enter, veto or close an intraday trade. Full sentiment component formulas, freshness windows, historical
sampling and gap-outlook rules are in [trading-agent.md](trading-agent.md).

## 11. What this review verified

The timing tests first reproduced failures in the previous code, then
passed after the fix: paused target/retracement, an old extended deadline, a
post-signal extreme missed by a retraced quote, and replay announcing a new entry
after that trade had already ended. Tests also use the full pattern and
score pipeline in both directions for all seven instruments, check terminal ledger
signals, exclude signal/future candles and retain normal active-trade management.

Multi-timeframe tests cover independent indicator warmup, missing/stale/gapped
history, completed-candle exclusion and 5/15/60-minute signal selection and
reversals. MCX hourly bars release at their 09:00-aligned close; index hourly
bars retain the 09:15 alignment. Equal closes now prefer 5 minutes; a newer eligible
close can select another interval, and an opposite view does not borrow or veto
another timeframe's confirmation. Reversal checks retain full post-entry candle,
freshness and exact-contract requirements; old other-frame signals cannot reopen
the exited side immediately after an agent reversal.

Earlier mocked mobile and desktop browser checks covered Nifty CALL/PUT and MCX Crude Oil
LONG/SHORT with the former 15-minute default; all three timeframe reviews remain visible,
the mobile row scrolls horizontally, and the removed sizing and one-minute panels
are absent. Changing the chart to hourly does not disable independent analysis
or prevent automatic pending-to-active entry from a fresh observed quote on the
selected 15-minute signal. Captured underlying historical jobs contain no
one-minute requests. Broker endpoints and WebSocket quotes are mocked for these
checks; no real broker order or live market accuracy is validated.

These are controlled OHLC/quote replays and browser checks, not a backtest claiming
profitable market predictions. This repository does not contain the user's actual
browser-local candle cache, saved trade ledger or tick log. The precise reported
live incident cannot be attributed to a timestamp/price without those observations.
Candles alone cannot recover unknown intrabar event order.

To inspect the running agent, review its per-timeframe analysis and expand
**CALL / PUT decisions** (LONG / SHORT for MCX), **Confirmation checks** and
**Inputs & confirmation checks**. “Download evaluation log” exports changed current-session
assessments; saved tracked outcomes remain in Today's confirmed trades.

## 12. Reviewed enhancements

The subsequent [Enhancement review](agent-enhancement-review.md) records which
suggestions were implemented, already covered, or deferred. Current additions are
bounded quote context, entry-window
freshness display, contribution graphics, trade state/reason audit, expiry notices,
tracked-result review and sentiment publication-age weights. These tools do not
retune the technical strategy or turn sentiment into an entry veto. The optional
risk-budget calculator UI was removed at the user's request.

The monitoring panel exports completed five-minute candles for the separate
[offline replay tool](strategy-replay.md). Replay uses chronological history only,
declares absent historical context and remains a five-minute baseline. It does
not simulate multi-timeframe selection, opposite-frame exits or tick protection.
The local trade ledger remains distinct from simulated replay outcomes.


## 13. October 19 enhancements

The default chart/review and equal-close signal preference are five minutes.
The other intervals remain independent. Normal confirmation uses positive support
at least 1.5 times opposition; elevated VIX retains the 65-support/20-lead risk
floors. Pattern, route, warmup, coverage, quote freshness, ATR and reward/risk gates
still apply. This app tracks local CALL/PUT ideas and observed entries; it does
not submit broker orders.

Completed-score samples persist by instrument, contract, timeframe and IST session.
Three or more consecutive samples show opposing pressure when one score rises
while the other falls. Score pressure prompts indicator review, not an independent
entry or exit. Indicator turn evidence now includes RSI declining from its recent
peak/recovering from its trough and shrinking Supertrend price cushion before
its label flips. EMA trajectories already compare current and previous slopes.
ATR expansion is risk context; VIX remains a volatility gate.

Saved confirmations and entries survive refresh/login in the same browser. A
reconnect waits for complete candle history rather than immediately terminating
an entry as unverified. An overlapping completed bar that touches no exit level
can advance recovery. A touched level with unknown timing or a missing next-day
square-off remains unverified; entry records are preserved and excluded from
verified outcome statistics. Browser storage cannot recover unseen tick ordering.

The after-market panel automatically saves a report after 15:15 IST for indices,
or the actual MCX session cutoff for commodities, while the dashboard is open.
It refreshes as late outcomes arrive. It counts confirmed signals, entered trades,
verified wins/losses/flat outcomes, expired and unresolved signals separately, and
reports underlying/futures points before costs. It analyses all available saved
five-minute chart candles with the historical analogue evaluator.

A separate local supervised logistic classifier learns from saved support,
opposition and coverage features. It needs at least 40 verified trades, trains on
the oldest 75%, excludes training trades not closed before the test period, and
compares against a training-majority baseline on the newest 25%. This is a small
experimental model, not the existing FinBERT news classifier or a validated live
trade predictor. The optional Gemini button reviews report statistics and returns
code improvement hypotheses. Reports and Gemini commentary are saved locally and
can be downloaded; neither edits live rules or code. No analysis runs with the
browser closed, and no unseen broker history is claimed.


## 14. Compact next-session outlook display

The card shows a prediction for its index, relative up/down evidence percentages,
and one colored summary row per external input group. Global markets and GIFT
Nifty share their existing group; FII/DII, news and PCR reference have separate
rows. Detailed source explanations remain in the saved background assessment.
Relative percentages are bullish / (bullish + bearish) and bearish /
(bullish + bearish), not calibrated opening-gap probabilities. Zero total evidence
shows no percentage. A directional bias requires availability ≥60% and signed
lead ≥+15 for up or ≤−15 for down. A stale saved card cannot display a current
threshold confirmation. These display changes do not alter the outlook rules.


## 15. Per-timeframe trajectory display

The horizontally scrolling timeframe panel can be collapsed. Each five-minute,
fifteen-minute and hourly card includes its own bullish/bearish scores, score
changes and collapsible indicator trajectory details. The trackers are mounted
for every instrument before the visibility check and remain independent of
panel expansion. Current completed observations are saved under separate
instrument/contract/timeframe keys; stale chart readings do not overwrite them.
The duplicate standalone ATM/trajectory cards were removed. ATM CE/PE VWAP remains
in the existing chart indicator card and continues feeding background analysis.


## 16. Candle-by-candle indicator trajectories

Each timeframe card now lists EMA20/50, RSI14, Supertrend level and direction,
ATR14, ADX/DMI and SMA20. Rows compare the current completed candle with the
previous consecutive completed candle, and show recent seven-bar extrema and
local turns. Actual saved candle history supplies these indicator comparisons
without waiting for three live score samples. Score trajectories still require
observed score snapshots; historical OI/news/VIX scores are never fabricated.
India VIX is one market-wide risk quote sampled separately at each timeframe's
observations, not three independently calculated indicators. Missing VIX history
remains unavailable. Comparisons never bridge missing candles or IST sessions.
The existing technical engine already evaluates indicator slopes, turns and
risk gates independently per timeframe; the display does not add another vote.


## 17. Swing structure in indicator trajectories

The trajectory title includes a colored direction arrow and the timeframe's
bullish/bearish scores, including while observations are warming up. Indicator
rows show low-to-high/high-to-low movement and HH/HL or LH/LL structure when enough
confirmed swings exist. A pivot needs one completed candle on each side and must
exceed the configured noise threshold. Break levels are known before the break
candle closes. Structures use up to 32 contiguous same-session observations;
missing values/bars reset the comparison. Unfinished swings do not repaint prior
trade decisions.

The technical engine applies the same swing evaluator to EMA20/50, RSI and the
price-to-Supertrend cushion. RSI structure and its breaks use the dedicated
10-point RSI structure allocation. Other indicator turns share a 1-point budget. A new alignment route requires an EMA break plus an RSI
or Supertrend-cushion break, improving RSI, a directional completed body, a close
through the previous price high/low, and price on the matching side of EMA20.
Other setup, warmup, coverage, ratio, ATR and reward/risk checks still apply.
Reversal exits consume the resulting fully confirmed opposite-timeframe plan;
they retain fresh live quote and fully post-entry candle requirements. ATR,
India VIX and ADX are risk/strength context and cannot create directional routes.

Noise thresholds are implementation parameters, not fitted performance claims:
EMA/Supertrend 0.03 ATR and RSI 1 point. UI-only risk/strength structures use their
own units. A direction change or broken indicator structure does not guarantee
a market reversal or protect a particular amount of profit. References:
[StockCharts RSI and failure swings](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/relative-strength-index-rsi),
[Fidelity technical analysis overview](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/what-is-technical-analysis).


## 18. Storage and instrument-master recovery

Trade history now uses IndexedDB read/write transactions, isolated from the small
localStorage quota used by refetchable chart caches. The existing version-1 ledger
is validated and migrated without pruning trade records. Its localStorage key is
removed only after the database commits; malformed history is preserved. Native
transactions serialize updates across tabs, with broadcast notifications to refresh
their displays. Queued updates recheck the actual current time for quote freshness.

If storage fails after a ledger is loaded, the tab retains observed trade state
and continues monitoring, retries persistence with a 15-second cooldown and shows
one persistent saving warning plus a JSON backup action. A failed write cannot
restore a stopped position as a later winning trade. Unsaved state requires keeping
the tab open or downloading the backup; it cannot survive a reload by itself.

Refetchable chart caches are bounded to 1,200 candles and 90,000 characters each,
with an aggregate target of 700,000 characters. On quota pressure only owned candle
cache keys are evicted, prioritizing the selected index. Full in-memory candles,
trade records, credentials and saved analysis reports are not deleted. All indices
continue background analysis. Score sample persistence retains the last 64
observations, enough for the 32-observation trajectory window.

Instrument metadata downloads are shared by quotes, ATM VWAP and option-premium
requests. Compact last-good metadata is saved server-side and reused after refresh
failures, with exponential retry delays of 15 seconds to 5 minutes. Cold-start
index quotes can use the three existing fixed spot-index tokens. No option/futures
tokens or expiries are invented; expired option contracts remain unavailable.
Valid browser-cached MCX metadata is reused if the public master fails, with
contract expiry checked by the existing resolver. Disk-cache write failures do not
invalidate a successful in-memory master. On hosts with ephemeral disks, a new
instance may still need to download contract metadata again.


## 15. Trend opportunity detection and visible rejection reasons (22 October)

A directional market view is separate from an eligible entry. Earlier momentum
filters rejected all five event families beyond 1.8 ATR from EMA20, and required
seven bars in the current session on every interval. A regular index session
cannot supply seven completed hourly bars. Setup-specific three/four-bar checks
now allow eligible hourly and early-session patterns; seven-bar EMA turn routes
still need all their original inputs. The local continuation and impulse families
cover fresh completed events with bounded extension, rather than repeatedly
promoting a trend label to an entry.

The main agent card shows failed checks for the dominant direction. When no price
pattern is detected, diagnostics also explain EMA distance, excessive candle
range, weak candle body, missing routes or interrupted session data. This makes a
bearish view with no SHORT setup explainable without expanding the diagnostic log.
The RSI/VWAP 50-point allocation and confirmation thresholds are unchanged.
Confirmed opposite setups continue to use existing post-entry/fresh-quote reversal
checks; stops, targets, trailing protection and one-open-trade tracking remain in
force.

Regression tests exercise generated, timezone-aware session histories for all
seven instruments in both directions, all three intervals and three dates, plus
negative cases and reversal exits. These are scenario checks, not a replay of the
user's screenshots or evidence of profitability. The reference photos describe
price action, indicators and news; news remains separate sentiment context and
introduces no automatic blackout or entry rule from image text.


## 19. Requested 1.20 reward/risk floor and automatic TSL

The minimum planned and actual-entry reward/risk is **1.20:1**, changed from
1.50:1 at the user's request. One shared constant and comparison are used by
price-action candidate selection, ATR-adjusted evidence, conditional ideas,
plan generation, entry diagnostics, live/candle entry and offline replay.
Targets remain based on the original setup; neither stops nor targets are moved
to manufacture eligibility. A slipped/gapped entry must independently retain
1.20:1 at the observed fill. RSI/VWAP weights, the 1.5× directional score ratio,
70% coverage, ATR minimum risk and VIX floors are unchanged.

TSL initializes on observed entry of a confirmed CALL/PUT or MCX LONG/SHORT,
with the initial stop unchanged. Favourable observed quotes subsequently tighten
it using max(1.5 × eligible ATR, 0.35 × initial risk, two ticks), rounded outward
to the contract tick. It never loosens, even when ATR increases. At +1R observed
movement the stop is at entry or better. A fresh quote crossing TSL closes the
local tracked trade automatically, independently of an opposite confirmed setup.
A gap exits at the received quote, not at an invented stop fill. Quotes older than 30 seconds, more than one second in the future,
or out of order cannot move it. The original SL remains recorded; the
main card and index/futures chart show the current TSL separately.

Pending confirmation is not an entry and cannot arm protection. A reconstructed
candle entry seeds only the fill price as the peak; unobserved highs/lows cannot
create a profitable trail. Replay retains ambiguous outcomes when ordering is
unknown. The five-minute offline replay does not model tick-driven TSL and
cannot validate its profitability. Saved protection remains compatible with
version-1 records and resumes from verified observations after reload.

The rule parameters are an implementation choice, not a demonstrated optimum.
The 1.20:1 minimum measures room at entry, not the realised winner size. Trailing
exits produce variable rewards and losses. Production performance requires separate historical/tick
validation with costs. This remains dashboard-local tracking while running,
not a broker-held stop or automatic broker order.

Research: [Fidelity ATR guidance](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/atr)
describes adapting stops to volatility using an ATR multiple, including 1.5×.
[Fidelity trailing stops](https://www.fidelity.com/learning-center/trading-investing/trading/trailing-stops-video/)
explains the favorable-price trailing mechanism and execution/data risks.

## 20. Open profit with trailing protection

Confirmed CALL/CE and PUT/PE trades, and MCX LONG/SHORT trades, remain active when
the original reference target is reached. There is no fixed take-profit boundary
at 1.2R, 2R, 3R or higher. The reference is still required before entry: both the
setup and actual observed entry must provide at least 1.20:1, and an already
consumed setup cannot be entered late. RSI/VWAP weights and confirmation gates
are unchanged.

TSL starts with the initial stop and follows favourable observed prices using
the existing max(1.5 × eligible ATR, 0.35R, two ticks) distance. It tightens in the
correct direction for CE and PE, reaches entry or better at +1R, and never loosens.
It can move beyond the reference target. A live stop breach books the actual
observed quote and uncapped directional points. Initial SL remains the denominator
for R. Existing confirmed reversal, manual exit and session/contract square-off
rules still apply.

Both the main agent card and today's confirmed-trade cards show the current TSL
separately from initial SL. The main card shows current return in R and removes
the bounded target-progress meter for active trades. Chart target labels are REF.

Saved trails beyond the reference survive version-1 history validation and reload.
Existing completed TARGET_HIT results remain terminal. Reconnect recovery ignores
reference crossings and checks the saved stop first. Only known completed closes
may tighten the trail for subsequent bars; unobserved high/low ordering cannot
create a synthetic same-bar trailing win. The separate offline five-minute replay
remains a fixed-target comparison model and cannot validate this live exit policy.

Regression coverage includes all seven instruments in both directions through
1.2R/2R/3R/5R, observed gap exits, persistence past the reference, one-position
enforcement, recovery, entry reward/risk checks and rendered CE/PE cards.
The 258 targeted tests pass across agent, analysis, history/open-profit,
commodities, storage, replay and enhancement suites. Production build, lint and
diff checks pass; Vite retains its existing large-chunk advisory. Authenticated
broker data and interactive browser operation were not exercised.

Sources: [predictionHistory.ts](../src/analysis/predictionHistory.ts),
[tradeProtection.ts](../src/analysis/tradeProtection.ts),
[openProfit.test.cjs](../tests/openProfit.test.cjs).
Sources: [tradeRisk.ts](../src/analysis/tradeRisk.ts),
[tradeProtection.ts](../src/analysis/tradeProtection.ts),
[predictionHistory.ts](../src/analysis/predictionHistory.ts).
