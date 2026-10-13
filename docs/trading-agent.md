# Trading Prediction Agent

The agent has two independent analyses. Technical analysis alone confirms CALL/CE
or PUT/PE setups. Market sentiment describes support or headwinds; it never creates,
delays, vetoes, reverses or closes a trade. Both scores are reproducible evidence
ratings, not calibrated probabilities. Profitability has not been established by
an out-of-sample backtest. The tracker records index points and does not submit orders.

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
- At least 70% technical coverage, directional support of 60/100, and a 20-point lead.
- A stop outside chart invalidation and at least one ATR14 from entry, rounded outward.
- At least 1.5:1 reward/risk after widening the stop; the chart target stays unchanged.

ATR and India VIX are risk checks rather than directional votes.
[NSE describes India VIX](https://www.nseindia.com/static/products-services/indices-indiavix-index)
as expected volatility. The existing experimental rule raises required technical
support from 60 to 65 when VIX is at least 25 or its daily rise is at least 10%.
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
