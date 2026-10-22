# Chart performance and history sync

The browser keeps each index/timeframe in `LiveCandleBook` memory. Chart rendering,
timeframe switching and trade reconciliation read that book instead of repeatedly
parsing local storage. Every accepted exchange tick still updates OHLC and trade
entry/exit tracking synchronously. React receives batched snapshots every 250 ms.

Local storage remains the recovery cache across reloads. Dirty histories save one
timeframe per idle callback, starting every five seconds; page hide and unmount
flush outstanding changes. A sudden browser/process crash can lose the last few
seconds of unsaved chart ticks. Trade-ledger persistence remains immediate.

Only the active agent builds its visible cards. Other agents continue evaluating
and monitoring trades. Closed-candle analysis keeps stable snapshots; moving
averages, trajectories and VWAP use a weak-reference memory cache that invalidates
on a new immutable snapshot, timeframe change or candle-completion boundary.
Feed freshness, confirmation deadlines and sentiment freshness still check the
current clock on every evaluation.

The chart computes indicators over the full saved history but draws only candles
and indicator segments around the visible range. Panning, scrollbar updates and
wheel events coalesce into animation frames. Historical positions stay fixed on
live ticks. Explicitly fitting the entire history can still draw many candles.

The application, prediction page and chart load as separate JavaScript chunks.
The Node server gzip-compresses eligible static assets and retains immutable
asset caching. The instrument endpoint supports `?scope=indices`, sending just
tracked indices and India VIX candidates to the prediction page. For this scope, the master
is fetched once per six hours per running server instance; only the small index
subset is retained in memory. Concurrent fetches share one request. The default
instrument endpoint continues to fetch and return the full master.

## Background synchronization

Login, page reload and the refresh button start one cancellable sync pass. Index
or timeframe changes reprioritize pending work; they do not start another pass.
The current instrument's 5-minute default analysis feed comes first, then its
displayed interval and remaining 5/15/60-minute feeds, followed by the other instruments.
Cached charts remain interactive throughout the pass. All three analysis intervals
are maintained locally for each instrument; chart selection never starts another
sync pass. There is no one-minute underlying history job or strategy feed.

Cold starts request 14 days of 5-minute, 45 days of 15-minute and 120 days of hourly
candles. Warm starts overlap the most recent saved candle and fetch the missing
tail, starting no later than the current IST session's 09:15 opening. A new live
candle after a late login cannot hide a missing morning block or a hole inside
today's cached session. Candles dated after the current clock cannot advance the
sync cursor. Old gaps are split into requests below SmartAPI's 100/200/400-day caps
for these three intervals.
All dates use IST `yyyy-MM-dd HH:mm`. Cached history is retained, and merging
protects live ticks newer than the request's minute-precision cutoff.

The client issues one request at a time, spaced by at least 1.2 seconds. HTTP 200
responses with `status: false` are rejected. Transient failures retry at most twice
with increasing delays; rate-limit responses use at least 15/30-second waits and
respect the broker's `Retry-After`. History starts independently of profile loading.
Rejected authorization gets one shared token refresh and retry per job, using the
same recovery as profile/premium requests; failed recovery stops the remaining pass.
Successful empty responses preserve cached candles instead of reporting a
rejected request. A cold empty response is reported as missing data.

## Commodity charts in the existing instrument dropdown

Natural Gas, Crude Oil, Silver and Gold use standard MCX `FUTCOM` contracts from
Angel One's instrument master. `/api/instruments?scope=commodities` retains only
those four roots; options and mini/micro variants are excluded. The browser selects
the nearest unexpired future and shows its symbol, expiry and broker lot size.
Contract selection rolls over after its expiry session, and candle caches remain
separate by token so different expiries are never stitched together. Missing
contracts appear unavailable rather than using fabricated tokens or index prices.

The existing socket subscribes to MCX exchange type 5 in quote mode alongside the
index LTP subscriptions. MCX REST quotes use `exchange: MCX`; their receipt time is
labelled and cannot create a fabricated live candle. Every actual exchange tick
updates the candle book before rendering is throttled. Historical requests use
MCX and the resolved contract token, share the serial queue/auth recovery, and
backfill from 09:00 IST. Commodity selection prioritizes its 5-minute default
analysis feed, then its displayed timeframe and other analysis intervals.
All three supported timeframes are saved locally and switching reads that cache.

MCX hourly buckets align to 09:00 IST; index hourly buckets retain 09:15. The
regular metals/energy schedule is Mon–Fri 09:00–23:30 IST during US daylight saving,
or 09:00–23:55 otherwise, following [MCX's published trading hours](https://www.mcxindia.com/market-operations/trading-surveillance).
The header labels regular hours and explicitly allows exchange holidays/special
sessions; it does not claim that a weekday clock alone verifies an open exchange.
Fresh broker data continues to be consumed in the evening. The index agent's
15:15 strategy cutoff is not applied to commodity data.

All seven instruments use the same Trading Prediction Agent, evidence disclosures,
CALL/PUT diagnostics (displayed as LONG/SHORT for MCX), horizontal analysis cards,
optional Gemini second opinion, and confirmed-trades ledger. Commodities use the
same independent completed 5/15/60-minute setup/trajectory analysis, positive supporting
score ≥1.5× opposition, ≥70%
coverage, ATR stops and ≥1.5:1 reward/risk as indices. Missing commodity option-chain
OI/PCR keeps its 10% technical budget unavailable. Equity India VIX, index OI/PCR,
FII/DII cash flows and equity participant positions do not vote on commodity trades.
The corresponding cards explicitly retain unavailable data, without reweighting it.

Commodity LONG/SHORT plans store the exact futures token, symbol, expiry, and tick
size. Planned prices snap conservatively to that tick grid and reward/risk is checked
again. Entry requires a matching fresh quote and unexpired contract. Only one open
position per commodity is permitted; an opposite confirmed setup settles it before
another entry. An open old-expiry contract remains subscribed and stored separately
through rollover. It never receives the new expiry's prices or reversal signals.
MCX positions use their own 23:30/23:55 regular session cutoff and require an actual
observed exit quote; missing observations remain unverified. This is browser-local
trade tracking, not a broker order or a rupee P/L calculation. A closed browser cannot
execute square-off orders. Exchange holidays/special sessions are not calendar-backed;
fresh quotes and completed bars remain required. Index 15:00 gap outlook stays index-only.

Genuine historical traded volume supports VWAP. Live volume counts only observed
cumulative-volume deltas inside the same candle, excluding first quotes, reconnect
gaps, counter resets and unknown cross-boundary volume; it is labelled partial until
history sync. Commodity charts show support/resistance and trade levels, with India
VIX and the index CE/PE strike ladder excluded.

Commodity news searches target each underlying's supply/demand and India/MCX
headlines. The Global card uses the corresponding US futures benchmark plus USD/INR;
their direct moves provide indicative context rather than inverse Indian-equity cues.
US Dollar Index and US yields are displayed as references without directional votes.
Foreign futures are delayed references with different prices, units and expiries, never
substitutes for MCX quotes. Headline assessment caches are isolated by commodity, so
an oil supply shock is not assigned an Indian-equity sentiment rating. News/global
sentiment and optional Gemini never confirm, delay, veto or reverse technical trades.

`npm run test:commodities` covers contract selection/expiry rollover, exchange routing,
DST hours, candle/volume handling, all four commodities' symmetric trade
confirmation, contract-bound entries/reversals, observed square-off, dashboard
references and scoped news/caching. Existing index suites remain applicable.

The historical proxy also serializes requests across clients on one server
instance, uses a 20-second upstream timeout, coalesces duplicates, and holds a
bounded 30-second memory cache keyed by hashed session and the exact request
range. Empty/error responses are not cached. Rate-limit cooldown pauses queued
broker calls. Restarting Render clears server memory caches; browser storage
survives. Multiple server instances require a shared queue/cache for a global
broker quota; this change does not add Redis or other external infrastructure.

SmartAPI's published candle API limits are 3/sec, 180/min and 5,000/hour:
[SmartAPI rate-limit announcement](https://smartapi.angelone.in/smartapi/forum/topic/4387/changes-in-api-rate-limit/1).
Request/response formats and supported intervals follow the
[SmartAPI documentation](https://smartapi.angelone.in/docs).

These changes reduce application work and duplicate requests. They cannot ensure
that upstream data is available or eliminate hosting cold starts.

Run `npm run test:sync`, `npm run test:stream`, `npm run test:history`,
`npm run test:analysis` and `npm run build` for the relevant regression checks.

The optional CE/PE scale keeps only nearest-expiry index option instruments beside
the index metadata cache. It polls paired LTP quotes only while a premium column
is revealed; quotes are excluded from the historical candle sync and from live
agent decisions. See [option-price-scale.md](option-price-scale.md).

The selectable chart intervals are 5 minutes, 15 minutes and 1 hour for every index
and commodity, with **5 minutes as the default view**. Every instrument's agent
evaluates all three supported intervals independently from completed-candle
snapshots. The latest eligible confirmed signal close wins; equal closes prefer
5 minutes, 15 minutes, then 1 hour. No scores are summed and unanimity is not
required. Confirmation, warmup, coverage, ATR/RR and quote checks apply separately
to each interval. One open position per instrument remains the limit across all
intervals. A current fully confirmed opposite plan on any supported interval can
exit only with a full post-entry candle and a fresh observed matching quote.

One-minute strategy analysis, private underlying candle updates and historical
sync jobs are removed. Legacy one-minute trade records/caches remain readable;
they are never chosen for new signals. The seven front instruments now maintain
21 serialized history jobs. Login/reload/refresh sync history; timeframe reviews
use the live candle book instead of polling historical data on each evaluation.
Completed-candle references and memoized analyses avoid repeating full indicator
calculations on every forming tick. Stops, targets and ATR trailing protection
still observe every live quote. Old active futures retain their own token and
quote stream through rollover. New expiry signals cannot close an older
contract's position.

Separately labelled ATM CE/PE VWAP context may use raw one-minute option candles
to calculate genuine volume-weighted option prices. Those option requests share
the existing serialized server queue and session cache; they are not a one-minute
underlying analysis feed or independent trade trigger. The 15:00 index gap outlook
continues to use six completed 5-minute bars for its 30-minute reference window;
archived 1-minute outlooks remain readable.
