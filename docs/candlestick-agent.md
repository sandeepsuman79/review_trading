# Five-minute candlestick agent

Current live policy, introduced 5 November 2026: `five-minute-candles-v2`.
Persisted trade version: `candle-v2`. Earlier `candle-v1` records retain their identity. The same deterministic agent evaluates
Nifty 50, Sensex, Bank Nifty and each exact supported MCX futures contract.

Only completed **five-minute OHLC candles** determine a new directional signal.
There are no RSI/VWAP weights, ADX/EMA gates, technical coverage percentage,
adaptive score thresholds, higher-timeframe agreement, volume requirement or
sentiment vote in this policy. The independently displayed market reference and
other chart intervals do not enter its confirmation algorithm. No LLM chooses
an entry or exit.

## Pattern decisions

The agent needs at least 20 completed price bars from available previous/current
history, plus three contiguous current-session pattern bars. This is price-history
readiness, not a daily indicator warmup. Forming/future bars cannot create signals.
Missing pattern bars, stale closes and an invalid/expired MCX contract block a new
signal. Normal overnight/weekend closures and configured special sessions can
connect historical trading bars. The dated Muhurat session on 8 November 2026
opens at 14:20 IST: prior-session history plus three completed current bars can
qualify from 14:35, provided a pattern and a subsequent eligible quote exist.
See [special session rules](special-trading-sessions.md).

The accepting candle must have a directional body at least 35% of its range and
close in the directional outer 35% of that range. The agent recognizes:

- **Accepted range break:** two completed closes beyond the prior ten-bar high
  or low. The latest candle must hold the broken level within the larger of two
  ticks or 25% of the previous break candle's range.
- **Engulfing reversal:** an opposite previous body is engulfed and the new close
  breaks its high/low. It must occur after counter-direction price movement or at
  a known support/resistance location.
- **Rejection break:** a rejection wick is at least twice its body and half its
  candle range, at the same contextual locations. A subsequent directional candle
  must close beyond the rejection candle's high/low.
- **Inside-bar break:** an inside candle fits strictly within its mother candle,
  followed by a directional close outside the mother range.

The ChartSchool-based extension adds five routes:

- **Zone retest:** a zone with at least two swing touches flips after two closes
  through it, then a later retest holds and a directional candle breaks the
  retest candle's high/low.
- **Trend pullback:** HH/HL or LH/LL structure, a validated three-touch trend line,
  a pullback at that line and a directional close past the pullback candle.
- **Trend structure break:** two closes past a validated opposing trend line
  **and** the most recent opposing swing; a slope change alone cannot reverse it.
- **Double bottom/top break:** similar turning points separated by at least four
  bars after an approach in the opposite direction, then two accepted closes
  past the intervening neckline. The stop also covers the second turning point.

[Chart structure rules and sources](chart-structure-agent.md) specify tolerances,
line validation, observed gaps and chart rendering. These numerical choices are
our intraday adaptation; they are not a validated StockCharts trading system.

The mirrored bullish/bearish conditions produce CALL/PUT (LONG/SHORT for MCX).
When no pattern qualifies, at least four overlaps among the latest six candles
and net progress below 30% of their total range produce **SIDEWAYS**. Otherwise
the agent reports WAIT and its unmet checks. It never forces a trade to satisfy
a target number of entries.

The card displays CONFIRMED CALL/PUT, HOLD CALL/PUT, EXIT CALL/PUT, SIDEWAYS or a
readiness/wait state. A sideways reading alone does not liquidate an existing
position; its stop and TSL continue to protect it.

## Entry, target and initial stop

Confirmation identifies an accepted pattern; entry remains an observed event:

- CALL trigger: accepting candle's high plus one instrument tick.
- PUT trigger: accepting candle's low minus one tick.
- Initial SL: one tick beyond the pattern's opposite wick. An inside-bar stop
  also covers the mother candle. Round outward to the actual contract tick.
- Initial target: a 2R projection from that invalidation, capped by a nearer
  known opposing swing/zone or an applicable unfilled session-gap edge. Confirmed swing pivots need two completed bars on
  both sides and must be known before evaluation. A projection is labelled as
  such; the target is never widened to override a nearby observed obstacle.

**There is no minimum planned or actual-entry reward/risk ratio.** The calculated
ratio is displayed for reference only. Entry, stop and target must remain finite,
positive and correctly ordered; invalid price geometry still produces WAIT.
The signal can still confirm an exit of an existing opposite position: closing
that position does not require a profitable new opposite-entry projection.

A fresh matching connected-stream quote must cross the trigger after the setup
is issued, before the next five-minute candle closes. A consumed/invalidated
setup cannot enter on a later retracement. Existing instrument session cutoffs,
contract expiry and one-position enforcement remain. A gap below the former
ratio floor can enter if the trigger is reached and positive reference reward
remains. A quote at/beyond the target or invalidating the stop cannot enter.

## Target handling, trailing stop and candle exits

At a target touch, the trade closes at the observed quote unless a fresh matching
completed five-minute review supports the same direction and identifies a farther
confirmed resistance (CALL) or support (PUT). The target then advances to the
nearest eligible observed level and is persisted separately from the initial
confirmation. No farther level or stale/opposite evidence means book profit.
See [adaptive target/exit rules](adaptive-target-exits.md) for calculations,
the +1R / 35% profit-giveback guard, exit priority and recovery behavior.

New candle-only entries store protection version 2, basis `CANDLE_STRUCTURE`.
No ATR is calculated for this protection policy.

1. Start the stop at the initial pattern SL.
2. Trail one initial risk distance behind the best actually observed favourable
   price. Never use an unobserved candle high/low as an intrabar peak.
3. A newly confirmed higher low for CALL, or lower high for PUT, can tighten it
   further. The pivot must form after entry, belong to the matching five-minute
   assessment/contract and stay behind the current observed price.
4. At +1R, enforce entry or better after tick rounding. Never loosen the stop.
5. Exit a breached stop at the observed quote, including a gap through the stop.

Profit can run through successive confirmed targets. A reached current target
closes the live trade unless fresh same-direction evidence supplies a farther
observed level. A fresh opposite accepted candlestick pattern can close the held
side independently of a replacement entry. Its candle must close after entry;
it need not have begun after entry. Exit needs a fresh matching quote at/after
that close. Existing stop/TSL breaches, the profit guard and session square-off
retain priority. Missing quotes never invent an exit fill.

## Chart, persistence and monitoring

CE/PE controls select CALL/PUT price-action views of the same underlying chart.
They do not load ATM option candles or switch to premium prices. The directional
views show plain candles, price levels and trade annotations, without indicator
overlays or an extra option chart. Chart direction selection cannot force an agent
signal. The agent remains on five minutes when another chart interval is viewed.

New records persist their pattern, trigger, invalidation, target, tick size and
passed candle checks. Reload restores entry/TSL/exit state. Old records remain
readable with their original policy and trailing parameters; current five-minute
price patterns can manage their exits. The old indicator algorithms remain
available as explicit archived comparisons, not as live entry gates.

Monitoring exports mark new assessments `CANDLE_ONLY`. Legacy numeric score fields
remain zero for format compatibility and are not displayed as confidence or used
as gates. Current connection, quote and entry checks remain separate. Performance
cohorts keep candle-only trades separate from archived indicator-policy trades.

## Validation and limits

`npm run test:candles` covers both directions across all seven markets, pattern
families, sideways/warmup/gaps, future candles, entry timing and actual-price risk,
SL/TSL priority, post-entry opposite-pattern exits, saved evidence and UI controls.
Additional history/agent/storage/options/replay checks preserve older records.
The current checks pass: 26 candle/structure/UI tests, 185 agent/history/storage
regressions and 12 replay tests (223 total). The final engine-only rerun also
passes all 23 tests. Build, lint and diff checks pass; Vite retains its existing
large-chunk advisory.

The supplied Nifty monitoring file has 1,187 bars through 5 November 10:35 IST.
The current v2 replay produces 70 confirmed candidates. Its **fixed-target
comparison model** takes six immediate-next-open entries: three wins and three
losses, approximately +33.87 underlying points with zero assumed costs. This is
not a live-trade result or proof of improved profitability; six entries are a
small sample, and the model does not simulate live TSL/opposite-pattern exits.
The earlier v1 result (75 candidates, five entries, one win/four losses) belongs
to the superseded candle-only policy. No parameter was tuned to make this file
profitable. See the [structure review](chart-structure-agent.md) for current checks.

The tracker still records underlying/futures points locally. It places no broker
order and does not calculate option-premium returns. Authenticated live operation
and unseen-session profitability are not validated by these implementation tests.
