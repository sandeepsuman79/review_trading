# Trading Prediction Agent

For a consolidated checklist of current rules, weights, entry/exit timing and the
late-entry review, see [Agent rule audit](agent-rule-audit.md).
The [enhancement review](agent-enhancement-review.md) documents monitoring,
sentiment-age weighting and offline replay additions and their limits.

The agent has two independent analyses. Technical analysis alone confirms CALL/CE
or PUT/PE setups. Market sentiment describes support or headwinds; it never creates,
delays, vetoes, reverses or closes a trade. Both scores are reproducible evidence
ratings, not calibrated probabilities. Profitability has not been established by
an out-of-sample backtest. The tracker records index points and does not submit orders.

The chart defaults to **5 minutes**. For every index and commodity, the agent
independently analyses completed **5-minute, 15-minute and 1-hour candles**, even
while another chart is displayed. Each interval evaluates its own candle patterns,
EMA/SMA, RSI, ATR, ADX, Supertrend and genuine VWAP where volume exists. Every model
needs its own 50-bar warmup and full confirmation checks. The agent does not add
scores across intervals or require unanimous direction. Either CALL/CE or PUT/PE
(LONG/SHORT for MCX) can qualify automatically on any eligible interval.

Among eligible confirmed setups the latest completed signal close has priority;
equal close times prefer 5 minutes, then 15 minutes, then 1 hour. The selected
setup retains its actual interval, risk levels and candle-close deadline in the
card and ledger. Changing the chart interval does not change the analysis set or
reopen an already traded signal. The one-active-position guard applies across
all intervals for an instrument.

There is no one-minute strategy analysis, one-minute historical sync or independent
minute-pressure exit. Legacy one-minute trade records remain readable and receive
ordinary stop/trailing tracking, but cannot produce new one-minute setups. Raw
one-minute option volume may still be used to calculate separately labelled ATM
option VWAP context; it supplies no one-minute entry or exit trigger.

A current fully confirmed opposite setup on any of the three supported intervals
may close an existing position. It must be a full completed candle formed wholly
after entry, pass its own score/coverage/pattern/ATR/reward-risk gates, match the
contract and have a fresh observed quote after its close. Developing or conflicting
direction alone cannot close a position. Stops settle first. Reference targets
do not close an entered position. Exit
records retain the reversal timeframe, observed price and booked points. Any
replacement needs its own confirmed setup and the same one-position guard.

Context and India VIX are requested every minute; OI/global quote caches allow
minute refreshes while news/flow publication caches remain slower. Latest available
sentiment is shared as a reference by the timeframe assessments. Source timestamps and missing
coverage remain explicit. Gemini/headline assessment caching and quota cooldowns
remain in place; no model call is required for a technical review or exit.
Background monitoring is browser-local and requires the dashboard to remain running.

A new red candle alone does not confirm a PUT. Both directions still require a
completed setup, matching directional route, technical score/lead, coverage and
ATR/reward-risk checks. The separate CALL/PUT diagnostics explain unmet conditions.
Session high/low and previous-day reference levels use the full saved history,
even though short-term structure detection uses a bounded recent window.

## Part 1: technical confirmation

| Input group | Fixed budget | Inputs |
| --- | ---: | --- |
| Chart | 25% | Completed setup, pattern, location, candle pressure, structure, bullish/bearish evidence |
| Other indicators | 15% | SMA20, price/EMA20, EMA20/50 alignment, slopes, non-RSI/non-VWAP turns and crossovers, Supertrend10/3 |
| RSI structure + VWAP | 50% | RSI14 level 8%, momentum 7%, confirmed RSI HH/HL/LH/LL structure 10%, genuine session VWAP 25% |
| OI / PCR | 10% | Current unexpired option-chain PCR and call/put OI change balance |

Each group's bullish and bearish contributions remain inside its budget. Missing
inputs never increase other weights. OI walls, max pain and totals remain reference
levels; OI alone does not establish writing. A missing option chain (including
Sensex) can leave a trade eligible when remaining technical evidence is strong.
Indices use the selected index’s ATM CE/PE broker session averages and actual traded volume for VWAP context, with a candle-volume fallback.
Zero-volume spot candles cannot supply VWAP; missing ATM data earns no VWAP points.

The 15-point other-indicator budget comprises SMA20 1, price/EMA20 1, EMA20/50
alignment and EMA20 slope 5, EMA trajectories 2, non-RSI/non-VWAP turns 1, and
Supertrend 5. RSI including its own swing structure supplies 25 points and VWAP
supplies 25, together exactly half the technical score for setups and confirmed
reversal exits. Correlated signals share capped budgets.

Completed-bar trajectories compare three-bar EMA20/50 slopes with preceding
three-bar slopes, using 0.03 ATR as a flat/noise band. Crossovers detect EMA20/50,
RSI crossing 50, Supertrend flips, and price/VWAP crossing within the same IST
session. Gaps interrupt trajectory checks. Multiple simultaneous turns share one
capped vote. A turn or crossover cannot confirm without a completed price setup.

Confirmation requires:

- A recent completed price-action pattern with valid entry, target and invalidation.
- At least 50 completed bars and warmed-up EMA20/50, RSI14/momentum and Supertrend.
- At least 70% technical coverage, positive directional support ≥1.5× opposition for STANDARD confirmation.
- STRONG classification requires at least 60/100 support and a 20-point lead.
- Consecutive completed bars from the current IST session and the Mon–Fri 09:15–15:15 IST new-entry window.
- A stop outside chart invalidation and at least one ATR14 from entry, rounded outward.
- At least 1.20:1 reward/risk after widening the stop; the chart target stays unchanged.

ATR and India VIX are risk checks rather than directional votes.
[NSE describes India VIX](https://www.nseindia.com/static/products-services/indices-indiavix-index)
as expected volatility. The existing experimental rule raises required technical
a support floor of 65 and a directional lead floor of 20 when VIX is at least
25 or its daily rise is at least 10%.
Unavailable VIX is disclosed. Thresholds require strategy validation.

## Part 2: market sentiment reference

| Input group | Independent budget | Inputs |
| --- | ---: | --- |
| FII / DII | 30% | Published daily flows, participant futures positions, observed multi-session flow trend |
| News | 30% | Current individually assessed Indian, global and constituent headlines |
| Global | 30% | Available GIFT Nifty, Dow, Nasdaq, FTSE, Nikkei, KOSPI, Brent, USD/INR, US10Y, S&P500, WTI |
| PCR reference | 10% | Same current option-chain PCR used in technical analysis |

Sentiment needs 40% available coverage and at least one sufficiently observed
non-PCR group to label a direction; a gap below 15 points is neutral. Otherwise
it is unavailable. Support/opposition compares sentiment with the technical setup
and warns about counter-sentiment risk. PCR appears in both views for context;
sentiment never adds another PCR vote to the technical score. Missing or stale
sentiment never blocks technical confirmation. Gemini can run or refresh while
the technical agent confirms and observes entry locally.

Sentiment-only contributions now decay from publication/observation time, with
experimental half-lives of news 12h, globals 24h, published flows 3d and PCR
reference 15m. Existing hard freshness gates remain; fetch time does not reset
age, coverage is not reweighted, raw headline labels stay visible, and technical
OI/PCR scores and confirmation thresholds do not decay. Input details show the
remaining age-weight. Historical flow-trend reports decay individually.

## Entry, exits and persistence

Confirmation reserves a conditional entry; today's cards show trades only after
entry is actually observed. Entry pauses when the stream disconnects or current
technical confirmation is lost, independently of news loading/disagreement.
Confirmation must match the candidate's index, timeframe, side, signal candle and
exact levels, be checked within 30 seconds, and remain inside the current completed
setup window. Paused candidates still observe invalidation and expiry; entry is
never reconstructed from a candle formed while confirmation paused.

Technical setup entry deadlines are anchored to the next candle close, bounded
by session/contract cutoff. A target reached before entry also retires the idea,
even while entry is paused. Post-signal candle extremes invalidate already-spent
setups after reconnect/late loading; a retracement cannot revive them. The signal
candle itself is excluded from this invalidation scan. Terminal ledger signals
are shown as ended rather than displayed again as fresh confirmed setups. Setup
time retains the pending record's original issue time; candle close labels use
the actual close timestamp.

Live entry alerts require an actual live entry still open and no more than 30
seconds old. Replayed entries retain their candle source, even after a later live
quote. Replay that discovers both entry and exit reports a recorded outcome and
does not announce a fresh confirmed entry after the trade has already ended.

One active trade is allowed per index. Recorded risk levels remain fixed, with
continued stop, trailing and completed-chart reversal monitoring. Profit/loss is
booked before another trade can enter for that index.

Position management consumes current fully confirmed opposite plans from 5-minute,
15-minute and hourly assessments, including for positions opened on another
interval. Reversal exits
require a full post-entry candle and a fresh live quote after its close. Developing,
stale, missing or wrong-index plans cannot exit a position. Observed stops
take precedence; booked P/L and the existing one-active-trade guard precede any
replacement entry. Older records retain their original timeframe for persistence
and gap replay; they are not relabelled as new signals on another interval.
After an agent reversal exit, another interval's old signal cannot immediately
reopen the side just exited: its candle must close after that exit. Opposite-side
replacement remains eligible without a fixed cooldown, and a newly completed
candle can qualify the prior side again. CALL/LONG and PUT/SHORT use the same guard.

The user's strategy automatically squares off at **15:15 IST** for all three
indices and expires unentered candidates. This is an application cutoff, separate
from the [exchange's trading/closing-auction timetable](https://www.nseindia.com/static/market-data/market-timings). The first observed
same-session quote at or after the cutoff supplies the actual tracked exit time
and price, with `SESSION_SQUARE_OFF` as the exit reason. No quote means the card
shows square-off due; it does not invent a fill. Missing pre-cutoff observations
still require continuous candle replay, and an unobserved overnight exit remains
UNVERIFIED. The tracker records index points; it does not submit broker orders.

## Dynamic next-session gap outlook after 15:00 IST

Users can log in any time after 15:00 IST to see a newly evaluated outlook for
Nifty 50, Sensex and Bank Nifty. There is no completed-index-chart requirement.
The outlook refreshes each minute from currently available external inputs while
the dashboard is open, including overnight and weekends until the next weekday
09:15 IST open. A login fetches the feeds again. Weekends are handled; an exchange
holiday calendar is not connected.

Direction uses the current external sentiment lead, with its existing fixed
budgets: FII/DII 30%, assessed news 30%, global markets including GIFT Nifty 30%,
and available PCR reference 10%. Source publication/observation timestamps and age
weights remain in force; fetching an old report does not make it newly published.
Missing or unassessed news and stale feeds do not gain points or redistribute
weights. Coverage must be at least 60% and the absolute directional lead at least
15 for a directional gap bias; otherwise the outlook is mixed.

Late news, global incidents and changed market quotes can change a previous
outlook. The card shows its actual update time, source contributions and missing
inputs, and saves the latest revision locally. Previous version-1 snapshots remain
readable and are labelled as last saved outlooks. A gap bias is not a calibrated
probability, gap-size forecast or a trade trigger; it cannot enter or close an
intraday position. Events can only be considered once available feeds publish
them and the news assessment processes them.

## Freshness and audit

- Incomplete candles cannot confirm; recent means within two timeframe intervals.
- Context/source fetches must be within ten minutes; OI/VIX observations within thirty.
- OI must match the index and its option expiry must remain current.
- Institutional reports may be up to seven days old; saved trends use up to five
  reports within fourteen days and require at least three reports.
- Global quotes may be prior-session references up to four days old.
- News must be within 48 hours and assessments must match the current context revision.
- Session levels and VWAP resets use IST regardless of browser timezone.

The card displays separate score sets, coverage, contribution tables, missing data,
opposing evidence and technical risk checks. Gemini receives completed chart data,
separate technical scores and sentiment context as an advisory second opinion.
Saved flow reports remain browser observations, not independently verified history.

## Additional completed-candle opportunities

The engine also checks trend momentum breaks, EMA(20) pullback reclaims and first
breaks of the actual 09:15–09:30 IST opening range. These setups require warmed-up
indicators and at least one directional route: EMA20/50 trajectory or crossover,
Supertrend trajectory or flip, or a support/resistance break or reversal. The
routes use OR; EMA, Supertrend and DMI need not all agree. RSI and ADX/DMI remain
context, and conflicting evidence still affects the fixed technical score. A
completed directional candle and price event are required. The last seven bars
must be consecutive within the same session.
Tiny/indecisive bodies, large spikes, overextended prices and session-close entries
are excluded. Missing opening bars cannot create an opening-range setup.

ADX measures trend strength; +DI and −DI supply direction. Calculation uses
Wilder smoothing with fourteen valid price changes for DI and fourteen DX values
for ADX. It restarts warmup after invalid data. The concepts and interpretation
are described in [TradingView's DMI documentation](https://www.tradingview.com/support/solutions/43000502250-directional-movement-dmi/).
The numeric setup thresholds here are experimental rules, not calibrated accuracy.

New setup stops cover both chart invalidation and at least one ATR from the outset.
An observed support/resistance level caps the reference target used for entry
eligibility, while an entered trade can continue beyond it. When no observed target exists,
a projected 2R target is labelled explicitly. Candidate ranking prefers setups
that satisfy the final ATR reward/risk check. Rejected chart candidates remain
visible in diagnostics. The live dashboard can use a fully confirmed opposite
5-minute, 15-minute or hourly plan for reversal exits, independently of the displayed
timeframe. A full post-entry signal candle and fresh matching quote remain required.

The agent displays seven confirmation checks and separately reports a disconnected
stream or missing fresh quote. Bullish/bearish scores remain weighted evidence,
not probabilities. Current support/resistance levels are drawn with green S and
red R price-scale labels, with full values in a legend; levels outside the current
price viewport remain available in the legend and are visible when panning to them.

## Historical outcome reference

For the visible agent, a memory-cached comparison matches past candle shape,
EMA20/50 trend and slope, price relative to EMA20, Supertrend, RSI band, ADX trend
strength and normalized ATR volatility. An indecisive current candle is compared
with indecisive historical candles in similar indicator conditions.

Only completed candles are used. Historical outcome windows contain three
consecutive same-session candles after each reference. Selected windows do not
overlap, and a three-bar embargo separates them from the current reference.
Up/down requires a net closing move greater than ±0.5 ATR of that historical
reference; smaller changes are classified flat. Missing bars and overnight gaps
cannot masquerade as continuous intraday moves.

Percentages are withheld below thirty cases or three distinct saved sessions.
Displayed rates are empirical frequencies of next-three-bar outcomes, not
calibrated live forecasts or trade success probabilities. The visible 95% Wilson
sampling ranges follow [NIST's proportion interval method](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).
Non-overlapping windows still need not be independent; correlated market regimes,
limited history, slippage and transaction costs are outside those sampling ranges.

Historical bias requires a directional outcome rate ≥60% with its Wilson lower
bound above 50%. It is recorded separately from technical evidence scores and
cannot override a missing current pattern, expired signal, ATR/RR failure or missing
live quote. The current watch levels remain visible while waiting. Hidden agents
skip this optional reference to avoid repeating historical comparison work. No extra history or AI requests are needed.

## Partial-check risky level setups

When full technical confirmation fails, the agent can display a separate `RISKY`
conditional setup after at least four of the seven full-confirmation checks pass.
The count is a screening threshold, not permission to ignore any missing input.
Recent completed candles, fifty-bar EMA/RSI warmup, a positive ATR, chronological
same-session bars, and market hours remain required.

A risky CALL requires a recent support touch; a risky PUT requires a resistance
touch. The current close must be on the supported side and within 1.5 ATR of the
observed level. At least one current EMA, Supertrend or support/resistance route
must match the proposed direction. Opposing RSI, EMA, Supertrend and DMI readings
are disclosed, rather than adding another all-indicators agreement gate.
Directional evidence must supply at least
40 points with a ten-point lead. These partial thresholds are experimental rules,
not calibrated trade probabilities.

Entry is a proposed break beyond the last two completed candle highs/lows. The
stop covers the level/candle invalidation and at least one ATR. Observed opposing
support/resistance caps the target; insufficient room rejects the idea. When no
observed opposing target exists, the 2R projection is labelled explicitly. Rounded
prices must still offer at least 1.20:1 reward/risk. Stale data, missing/distant
levels, absent directional routes, insufficient score/lead, late-session data and
poor risk/reward remain WAIT even if four arbitrary checks passed.

The card shows an amber “RISKY · CONDITIONAL SETUP” label, trigger/stop/target,
matched level, aligned/conflicting indicators and unmet confirmation checks. The
original seven checks continue to describe full confirmation. This conditional
idea is not a confirmed entry: it does not reserve a live trade, write a confirmed
ledger entry or trigger an entry notification. Only a subsequent fully confirmed
setup and observed live entry use the existing trade lifecycle. An already open
index trade remains the displayed trade and cannot be overlapped by a risky idea.

`npm run test:agent` includes partial CALL/PUT setup tests, threshold/freshness/
chronology/target-cap rejection, confirmed-stage preservation and seeded OHLC
end-to-end detection. These checks verify implementation, not market profitability.

## Directional alignment routes for CALL and PUT

CALL/CE and PUT/PE use mirrored rules. EMA20/50 crossovers compare the previous
completed pair with the current pair; trajectory compares EMA20 and EMA50 over
three consecutive bars, with EMA50 flat or moving in the same direction.
Supertrend uses a direction flip or movement of its line over three bars, with
price on the indicated side. Both trajectories use a 0.03 ATR noise band.

An additional fast EMA20 turn compares the preceding three-bar slope with the
current three-bar slope, across seven consecutive same-session candles. The old
slope must oppose the proposed direction, and the new slope must exceed the
0.03 ATR noise band in that direction. A completed directional close must be
beyond EMA20 and the preceding candle's high/low by the normal price buffer,
with improving RSI in the same direction. EMA50 may still lag. This route adds
no extra indicator weight and cannot bypass the remaining confirmation checks.

A three-candle reversal can qualify near observed support (CALL) or resistance
(PUT): a strong opposing first body, a small middle body touching the level,
then a directional close beyond both the first body's midpoint and the middle
candle's high/low. Stops cover all three candles and at least one ATR. Existing
target caps and reward/risk checks apply. This is an intraday price-action rule,
not a claim that the candles form a textbook gap-based Morning/Evening Star.
All thresholds scale with current price/ATR; no index price or reversal time is
hardcoded.

Support/resistance breaks compare consecutive closes across a level known before
the latest candle. Prior swing levels exclude pivots that only become detectable
with the latest candle. A reversal requires a recent level touch, a directional
improvement in close, and a close in the directional 55% of the candle range.
Routes never compare across session boundaries or missing bars. Forming candles
are excluded before calculating routes or patterns.

The card lists matched bullish and bearish routes in “Directional alignment”.
These routes do not add a second indicator weight. Full confirmation still
requires a current completed pattern, a route in that pattern's direction,
existing fixed-budget technical score/lead and coverage thresholds, warmed-up
indicators, and ATR/reward-risk validation. A route by itself cannot confirm a
trade. Partial proposals remain explicitly RISKY and cannot enter confirmed
trade history. One live trade per index and exit-before-replacement are retained.

`npm run test:agent` verifies the alignment route variants independently for
both CALL and PUT, disagreement with other indicators, absent routes, candle
indecision, missing bars and overnight boundaries. These rules and tests do not
establish calibrated live-market accuracy or profitability.

## Independent candidate decisions and rejection diagnostics

Chart detection retains CALL and PUT candidates, including candidates rejected
by the initial reward/risk filter. Their original target and invalidation levels
remain inspectable. Each direction is scored independently against the same
completed candles and current indicator/positioning data. If the original chart
selection is ineligible, the other direction can qualify independently. A valid
original selection retains priority; only one plan is submitted to the existing
one-position-per-index tracker.

Initial candidates require at least 30 completed bars, 60% technical coverage,
55 supporting points and a 15-point lead, a matching route, available initial
EMA20/RSI/momentum/Supertrend inputs, and fresh same-session data, valid ATR and
entry hours. High-VIX score/lead requirements also apply to these early
candidates. They can be displayed as EARLY while EMA50 warmup or a completed
pattern/risk check is missing. Fifty bars, full indicator readiness, 70% coverage
and at least 1.20:1 reward/risk remain mandatory for actual confirmation. The standard 1.5× directional ratio and strong 60/20 classification are
experimental thresholds chosen by the user, not calibrated probabilities. Missing weights remain undistributed.

The CALL / PUT decisions disclosure shows each direction's support/opposing
scores, lead, coverage, pattern, routes, actual candidate levels and checked
reward/risk. All failed checks have reason codes, including insufficient
candles, stale data, session gaps, indicator readiness, missing routes/patterns,
coverage, score, lead, invalid ATR/levels, reward/risk and entry hours.

A separate entry section distinguishes technical confirmation from a disconnected
stream, missing/stale quote, quote predating issue, unreached trigger and poor
reward/risk at the actual quote. Quote-dependent reward/risk is not checked
until the entry is reached. Full confirmation is not an observed fill. Standard
versus strong quality is retained in entered-plan snapshots. No option contract
is selected or validated by this index-level engine; it does not manufacture an
OPTION_CONTRACT_INVALID result for an integration it does not perform.

The page keeps a bounded memory log of the last 400 changed assessments, with
both directions and their thresholds/reasons on each snapshot. Identical
heartbeat evaluations are deduplicated. The download button exports the selected
index's session log without broker credentials or news/provider responses. Reload
clears this diagnostic memory; the existing entered-trade ledger persists.

The core scorer and live entry guard both reject new entries at/after 15:15 IST.
Open-position management automatically requests tracked square-off. The entry tracker
continues requiring a fresh matching assessment and now explicitly refuses a
stale live quote when a current technical confirmation is supplied. Data
freshness, ATR, source-session integrity and quote/entry checks are not relaxed
by the new score thresholds.

## Multi-timeframe reversals and quote-based protection

WAIT on one interval does not disable monitoring of an already active trade. The
other supported intervals remain eligible to confirm an opposite setup. Reversal
exits use the full technical entry requirements on that opposite interval, a full
post-entry candle, fresh revalidation and a matching live quote no more than thirty
seconds old. Independent one-minute price-pressure exits have been removed. An
opposite direction label or forming candle cannot exit a trade by itself.

Actual live quotes also maintain a per-position favourable-price extreme and an
ATR trailing stop. Protection starts automatically at observed confirmed entry,
initially using the original stop. It tightens after observed favourable movement;
its distance is the greater of **1.5 × eligible completed-frame ATR**, **0.35R**, and two broker
ticks. If a current matching timeframe ATR is unavailable, the last known protective ATR, entry ATR or
initial risk is used. At **1R**, the stop cannot remain behind entry. Stops only
tighten and original planned levels stay recorded separately. A live breach exits
at the observed quote, which can be worse than the stop during a gap. Initial stops
and scheduled square-off take precedence. Reference targets never cap an open trade.
Saved trails survive reload; unobserved entry/stop ordering remains ambiguous.
Recovery checks saved stops before tightening from each known candle close for
subsequent bars. No unobserved candle high is invented as
a live peak. These thresholds are experimental, not a backtested optimum.

For Nifty 50, Sensex and Bank Nifty, nearest-expiry CE/PE quotes follow the exact
current ATM strike (50/100/100-point steps). Shared ten-second FULL quote requests
supply the broker's session average price, cumulative traded volume, LTP and IST
exchange trade time. These requests use the quote queue independently of chart
history; heartbeats never add assumed trades or volume. If the average is absent,
a separate candle-based session VWAP estimate uses sum(HLC3 × actual minute volume)
/ sum(volume), overlaps the last saved minute and refreshes at most once per
minute. A slow fallback never blocks later live quotes. LTP timestamps and
VWAP timestamps remain separate when combining quotes with candle averages.
Partial sessions, absent volume, stale timestamps and a strike different from
current ATM cannot supply directional context. Paired CE-above/PE-below supports
upward context; the reverse supports downward context.
The paired ATM direction supplies the 25-point technical VWAP
allocation for indices; mixed legs are neutral and missing data earns no coverage.
RSI level (8), momentum (7), and confirmed HH/HL/LH/LL RSI swing structure (10)
add another 25 points, making RSI structure + VWAP exactly 50% of technical scoring.
The remaining budgets are chart 25, other indicators 15 and OI/PCR 10. These weights
also apply to opposite setups used for confirmed reversal exits; protective exits
continue separately. The chart card stays expanded for indices and shows both
premium VWAPs, CE/PE prices, ATM strike, expiry and the data timestamp. Before open,
after close and over weekends, the latest weekday session remains visible but
cannot earn live directional points. A delayed trailing broker minute is accepted
only when history is contiguous from open and the separate freshness gate passes.
Option premiums are compared with their own VWAPs, never with spot-index points. Raw one-minute option data does not
enable one-minute strategy analysis. Commodity
futures use their own traded-volume VWAP instead of equity option context.

The selected index uses one chart area with the existing CE / expiry / PE switch.
CE shows the current ATM call; PE shows the current ATM put; the expiry button
returns to the index chart (the default view). There is no extra ATM panel.
Option views use the selected 5/15/60-minute interval and the actual contract's OHLC candles,
volume bars, candle-derived VWAP, EMA, RSI and Supertrend. The spot-index chart
retains index-point prices; ATM premiums use their own rupee axis. The VWAP
control on the spot chart selects the ATM CE view. Session volume for both legs is
shown alongside the live VWAP card, separately from historical per-candle volume.
Only the visible option chart loads history; minute refreshes overlap the last
broker candle and share in-flight requests. Strike/expiry/login changes cannot
reuse a different contract's chart. Unavailable contract history remains missing.

Missing ATM VWAP removes 25 available technical points and can push coverage
below the existing 70% minimum. Each index agent now displays the specific ATM
feed blocker and its actual evidence coverage. Valid paired ATM context enables
zero-volume spot indices to qualify using the same setup, risk and freshness
checks as before; the option chart itself does not create extra strategy votes.

ATR describes volatility, and trailing stops are risk controls rather than market
forecasts; see [TradingView ATR](https://www.tradingview.com/support/solutions/43000501823-average-true-range-atr/)
and [trailing-stop mechanics](https://www.tradingview.com/support/solutions/43000754965-introduction-to-trailing-stops/).
ATM averages and volume come from [Angel One market data](https://smartapi.angelone.in/docs),
with actual minute candles as fallback. No spot-volume or poll-count substitute is used.

Historical candles refresh automatically after each completed strategy bar, with
a five-second broker publication grace and a 15-second visible-page check. Focus,
reconnection and changed credentials also trigger a due check. Successful broker
progress determines the overlapping incremental range; late live ticks cannot
skip a missing morning session. One request timeout cannot cancel the remaining
instrument queue. A last-successful-sync timestamp appears above the selected chart.
Trade exits remain local tracking; the dashboard must be running and no broker
order is submitted. Profitability requires separate out-of-sample validation.


The October 19 changes, including default five-minute analysis, the 1.5× normal
score rule, persisted score trajectories, refresh recovery and after-market
learning reports, are specified in [agent-rule-audit.md](agent-rule-audit.md#13-october-19-enhancements).


The 22 October continuation update adds fresh local trend breaks and bounded
impulse breaks, including when the normal 1.8-ATR EMA-distance filter cannot
accept an entry. These families require four completed contiguous session bars,
current directional alignment, their own body/range/RSI/extension checks and all
existing full confirmation/risk checks. Standard momentum families now require
three current-session bars, with four checked separately for a three-bar range
break. Seven same-session hourly bars are no longer a universal prerequisite for
index momentum detection. A flat Supertrend band can qualify through a held-side
route with fresh completed price progress. The main trade card explains failed
checks and applicable price-event blockers. Scoring budgets and confirmation
thresholds stay as documented above.


The requested reward/risk minimum is now **1.20:1**, shared across setup detection,
ATR adjustment, plan creation and the actual observed entry. A gap/slippage below
that floor cannot enter, and original reference targets are not stretched. Entered
trades have open profit: reaching 1.2R, 2R, 3R or the original reference does not
trigger take-profit. Realised reward depends on the exit. RSI/VWAP allocations, directional
score requirements, coverage and VIX/ATR checks remain unchanged.

Automatic TSL begins when a confirmed setup actually enters, retaining its
initial SL at entry. It tightens on favorable quotes with the existing ATR/risk/
tick distance and reaches break-even at +1R. The main trade card and chart show
its current level; its breach records a local exit at the observed quote, even
without an opposite setup. Tracking requires fresh data and an open dashboard;
no broker-held stop or broker order is created. Reconstructed entries never use
an unobserved candle high as a trailing peak.

Both the main card and today's confirmed-trade list show current TSL separately
from initial SL. The main card displays current R using initial risk and has no
bounded target-progress meter for active trades. The target remains labelled as
an entry reference; chart badges read REF. Trails may pass it and survive reload.
Saved completed target outcomes are preserved. Recovery checks the saved stop
before each known candle close can tighten it for subsequent bars. Confirmed
reversal, manual and session square-off exits remain available. This tracks
underlying/futures points for CE/PE directions, not actual option premium orders.

An already saved SL/TSL breached by a fresh, matching same-session quote now exits
at that observed quote before reconnect candle replay. Overlapping candle ranges
can contain moves before the saved TSL; they keep a position under recovery while
waiting for an observed exit rather than immediately retiring it as Unverified.
Unknown exits are never assigned an invented fill or booked profit.

Completed exits with entry/exit times, prices and P/L take precedence over newer
uncertainty snapshots during storage merge. IndexedDB stores the full ledger;
synchronous localStorage checkpoints protect entry/TSL/exit transitions before
database commit and active positions on tab hide/cleanup. Reload replays those
checkpoints and removes only committed snapshots. No Redux dependency is needed.
