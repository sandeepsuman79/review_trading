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
The current index's 1-minute agent feed comes first, then its displayed chart
timeframe and other intervals, then remaining indices with their agent feed first.
Cached charts remain interactive throughout the pass. All twelve index/timeframe
combinations are maintained locally; chart selection never changes the fixed
1-minute agent analysis or starts another sync pass.

Cold starts request 7 days of 1-minute, 14 days of 5-minute, 45 days of 15-minute and 120 days of hourly
candles. Warm starts overlap the most recent saved candle and fetch the missing
tail, starting no later than the current IST session's 09:15 opening. A new live
candle after a late login cannot hide a missing morning block or a hole inside
today's cached session. Candles dated after the current clock cannot advance the
sync cursor. Old gaps are split into requests below SmartAPI's 30/100/200/400-day caps.
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
