# Trading Prediction Agent

The agent combines completed chart patterns with available market evidence. Scores
are reproducible evidence ratings, not calibrated win probabilities. These rules
have functional tests; an increase in predictive accuracy has not been established
by an out-of-sample backtest.

| Input group | Fixed budget | Inputs |
| --- | ---: | --- |
| Chart | 22% | Confirmed setup, location, candle pressure, bullish/bearish evidence, structure |
| Indicators | 22% | SMA 20, EMA 20, EMA 20/50 alignment and slope, RSI 14 and momentum, Supertrend 10/3, genuine session VWAP |
| Open interest | 18% | PCR and OI change balance; expiry, total call/put OI, walls and max pain remain contextual reference data |
| FII / DII | 13% | Published net/FII/DII cash flow, FII futures long/short positions, up to five saved observed daily reports |
| News | 12% | Individually assessed Indian, global, constituent and global-company headlines |
| Global | 13% | Available GIFT Nifty, Dow, Nasdaq, FTSE, Nikkei, KOSPI, Brent, USD/INR, US 10Y, S&P 500 and WTI quotes |

Each group's bullish and bearish contributions remain inside its budget. Missing
inputs do not transfer weight to other groups. Correlated indicators and markets
share a capped group budget. News impact scores and global moves retain magnitude;
a tiny market move does not become a full directional vote.

ATR and India VIX are risk inputs. [NSE describes India VIX](https://www.nseindia.com/static/products-services/indices-indiavix-index)
as expected Nifty volatility; the agent uses it for risk rather than an automatic
bullish or bearish vote. As an explicit experimental risk rule, VIX at least 25 or
a daily rise of at least 10% raises the required directional score from 55 to 65.
Unavailable VIX is disclosed rather than fabricated.

## Confirmation and entry

A new trade requires:

- A recent completed chart setup with valid entry, target and invalidation levels.
- At least 60% available evidence and at least two external groups with 40% coverage.
- Directional support of at least 55/100 (65 with elevated VIX), leading the opposing score by at least 20 points.
- Fewer than two strongly opposing groups. Strong opposition requires at least 50% group coverage and net opposition of at least 60% of its fixed budget.
- A stop outside chart invalidation and at least one ATR away from entry, rounded outward.
- At least 1.5:1 reward to risk after applying the ATR stop. The chart target is never increased to manufacture an eligible trade.
- No conflicting current, cited AI outlook.

For example, an 8-point chart stop with ATR 10 becomes a stop of at least 10 points.
An unchanged 16-point target still offers 1.6:1 reward to risk. A 12-point target
offers only 1.2:1 and the agent waits.

Confirmation reserves a conditional entry; the trade appears in today's cards
only after entry is actually observed. Entry pauses while analysis is refreshing,
the stream is disconnected, evidence conflicts, or the confirmed setup changes.
Paused candidates still track invalidation and expiry. An entry is not reconstructed
from a candle that formed while confirmation was paused.
Confirmation must match the candidate's index, timeframe, side and exact price
levels, and becomes ineligible when the next candle closes. Corrected unentered
levels do not extend the original deadline. Evidence is refreshed at observed entry.

There is one active trade per index. Existing trades keep their recorded risk
levels and continue tracking targets, stops and confirmed chart reversals while
new-entry checks run. Exits book index points before a subsequent trade can enter.

## Freshness and audit

- Live/incomplete candles never confirm a setup; recent means within two timeframe intervals.
- Source fetches must be within ten minutes; OI and VIX observations must be within thirty minutes.
- OI must match the index and its contract must not have expired.
- Daily institutional reports may be up to seven days old; saved trend observations are bounded to five reports within fourteen days, requiring at least three reports for a trend vote.
- Global quotes may be prior-session references up to four days old, accounting for different sessions and weekends.
- News must be within 48 hours and its AI assessment must match the current context revision.
- The context revision changes when news or public market inputs change, so updated OI, flows or quotes trigger reassessment.
- Zero-volume spot-index candles cannot supply genuine VWAP and remain excluded.
- Session levels use IST regardless of browser timezone.

The agent card shows combined bullish/bearish scores, opposing evidence and an
expandable contribution table with coverage and risk checks. A confirmed trade
saves its evidence summary with the existing local trade record. Gemini receives
the completed chart, indicator values and timestamped public input snapshots;
stale snapshots have their data removed. Saved flow observations are explicitly
labelled as browser observations, not independently verified historical API data.
New candidates use strategy `combined-v1`; existing `early-v1` trades remain
readable and continue exit tracking. A previously entered signal cannot reopen
just because the strategy version changed.
