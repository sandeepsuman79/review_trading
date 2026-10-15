# Trading Prediction Agent

The agent has two independent analyses. Technical analysis alone confirms CALL/CE
or PUT/PE setups. Market sentiment describes support or headwinds; it never creates,
delays, vetoes, reverses or closes a trade. Both scores are reproducible evidence
ratings, not calibrated probabilities. Profitability has not been established by
an out-of-sample backtest. The tracker records index points and does not submit orders.

The agent always analyses completed **1-minute candles** for every index, independent
of the displayed chart's 1/5/15-minute or hourly timeframe. Each newly closed minute
updates candle patterns, EMA/SMA, RSI, ATR, ADX, Supertrend and genuine VWAP where
volume exists. Latest available OI/PCR, India VIX, flows, news and global observations
retain their existing source freshness checks; changing cadence does not manufacture
new external data or require a Gemini request every minute. Forming candles are
excluded, and the card identifies its analysis as 1-minute. Chart timeframe changes
neither restart the agent nor change its analysis timeframe.

A new red candle alone does not confirm a PUT. Both directions still require a
completed setup, matching directional route, technical score/lead, coverage and
ATR/reward-risk checks. The separate CALL/PUT diagnostics explain unmet conditions.
Session high/low and previous-day reference levels use the full saved history,
even though short-term structure detection uses a bounded recent window.

## Part 1: technical confirmation

| Input group | Fixed budget | Inputs |
| --- | ---: | --- |
| Chart | 40% | Completed setup, pattern, location, candle pressure, structure, bullish/bearish evidence |
| Indicators | 45% | SMA20, price/EMA20, EMA20/50 alignment, slopes, turns and crossovers, RSI14/momentum, Supertrend10/3, genuine session VWAP |
| OI / PCR | 15% | Current unexpired option-chain PCR and call/put OI change balance |

Each group's bullish and bearish contributions remain inside its budget. Missing
inputs never increase other weights. OI walls, max pain and totals remain reference
levels; OI alone does not establish writing. A missing option chain (including
Sensex) can leave a trade eligible when remaining technical evidence is strong.
Zero-volume spot-index candles cannot provide genuine VWAP; its budget stays missing.

Inside the 45% indicator budget: SMA20 5%, price/EMA20 5%, EMA20/50 alignment and
EMA20 slope 20%, EMA20/50 trajectories 10%, new turns/crossovers 5%, RSI level 10%,
RSI momentum 10%, Supertrend 20%, VWAP 15%. Correlated signals share capped budgets.

Completed-bar trajectories compare three-bar EMA20/50 slopes with preceding
three-bar slopes, using 0.03 ATR as a flat/noise band. Crossovers detect EMA20/50,
RSI crossing 50, Supertrend flips, and price/VWAP crossing within the same IST
session. Gaps interrupt trajectory checks. Multiple simultaneous turns share one
capped vote. A turn or crossover cannot confirm without a completed price setup.

Confirmation requires:

- A recent completed price-action pattern with valid entry, target and invalidation.
- At least 50 completed bars and warmed-up EMA20/50, RSI14/momentum and Supertrend.
- At least 70% technical coverage, directional support of 55/100, and a 15-point lead for STANDARD confirmation.
- STRONG classification requires at least 60/100 support and a 20-point lead.
- Consecutive completed bars from the current IST session and the Mon–Fri 09:15–15:15 IST new-entry window.
- A stop outside chart invalidation and at least one ATR14 from entry, rounded outward.
- At least 1.5:1 reward/risk after widening the stop; the chart target stays unchanged.

ATR and India VIX are risk checks rather than directional votes.
[NSE describes India VIX](https://www.nseindia.com/static/products-services/indices-indiavix-index)
as expected volatility. The existing experimental rule raises required technical
support from 55 to 65 and the directional lead from 15 to 20 when VIX is at least
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

## Entry, exits and persistence

Confirmation reserves a conditional entry; today's cards show trades only after
entry is actually observed. Entry pauses when the stream disconnects or current
technical confirmation is lost, independently of news loading/disagreement.
Confirmation must match the candidate's index, timeframe, side, signal candle and
exact levels, be checked within 30 seconds, and remain inside the current completed
setup window. Paused candidates still observe invalidation and expiry; entry is
never reconstructed from a candle formed while confirmation paused.

One active trade is allowed per index. Recorded risk levels remain fixed, with
continued target, stop and completed-chart reversal monitoring. Profit/loss is
booked before another trade can enter for that index.

Position management also consumes the current fully confirmed 1-minute opposite
plan, including for positions opened on older chart timeframes. Reversal exits
require a full post-entry candle and a fresh live quote after its close. Developing,
stale, missing or wrong-index plans cannot exit a position. Observed stops/targets
take precedence; booked P/L and the existing one-active-trade guard precede any
replacement entry. Older records retain their original timeframe for persistence
and gap replay; they are not relabelled as new one-minute entries.

The user's strategy automatically squares off at **15:15 IST** for all three
indices and expires unentered candidates. This is an application cutoff, separate
from the [exchange's trading/closing-auction timetable](https://www.nseindia.com/static/market-data/market-timings). The first observed
same-session quote at or after the cutoff supplies the actual tracked exit time
and price, with `SESSION_SQUARE_OFF` as the exit reason. No quote means the card
shows square-off due; it does not invent a fill. Missing pre-cutoff observations
still require continuous candle replay, and an unobserved overnight exit remains
UNVERIFIED. The tracker records index points; it does not submit broker orders.

## Next-session gap outlook at 15:00 IST

Each index independently saves one outlook during the live 15:00 minute on
weekdays. It uses only completed candles through 14:59, at least fifty bars,
warmed-up indicators, 70% technical coverage and thirty consecutive current-session
minute bars. The same existing technical and sentiment evidence supplies a
heuristic score: 60% technical directional lead plus 40% sentiment directional
lead. Missing sentiment retains its missing weight. A directional gap bias needs
sentiment availability, 60% combined coverage and an absolute score of at least
15; otherwise it remains MIXED. These are explicit experimental thresholds,
not calibrated overnight probabilities. The card shows source reasoning, missing
inputs, coverage, the reference index value and its actual generation time.

The outlook targets the **next trading session**, so weekends and exchange
holidays are not labelled as a guaranteed next-day open. No holiday calendar is
inferred or future holiday date guessed. Overnight news and the remainder of the
current session are unknown at 15:00. Snapshots are browser-local and generated
only while the dashboard is running with data available; late opening, missing
data or a suspended/offline browser is disclosed without backdating an outlook.
The saved snapshot survives reload and is not revised with later candles. This
outlook cannot create, veto or close an intraday trade, and requires no additional
AI/API polling.

New candidates use `technical-v2` and save three technical contribution groups plus
a separate sentiment summary. Existing `combined-v1` and `early-v1` records remain
readable and continue exit tracking. Strategy changes cannot reopen an already
traded signal; corrected pending levels cannot extend the original deadline.

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
An observed support/resistance target remains a cap. When no observed target exists,
a projected 2R target is labelled explicitly. Candidate ranking prefers setups
that satisfy the final ATR reward/risk check. Rejected chart candidates remain
visible in diagnostics. The live dashboard uses the fully confirmed one-minute
opposite plan for reversal exits, independently of the displayed timeframe.

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
prices must still offer at least 1.5:1 reward/risk. Stale data, missing/distant
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
and at least 1.5:1 reward/risk remain mandatory for actual confirmation. Standard
55/15 and strong 60/20 classifications are experimental thresholds chosen by
the user, not calibrated probabilities. Missing weights remain undistributed.

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
