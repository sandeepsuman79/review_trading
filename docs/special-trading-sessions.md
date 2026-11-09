# Muhurat and other special trading sessions

## Issue found

The app's background monitoring, entry gate and candle refresh scheduler rejected
all Saturdays/Sundays. The history-continuity logic also rejected a Friday-to-
Sunday transition. Separately, server-side ATM option VWAP explicitly skipped
Sunday and fetched Friday's candles. These are code-level reasons that the agent
and live data could be absent during a valid Sunday Muhurat session. They do not
establish the health of an authenticated broker feed.

## Verified 8 November 2026 schedule (IST)

| Segment | Continuous session | Agent policy |
| --- | --- | --- |
| NSE/BSE underlying indices | 14:20–15:30 | Entry from 14:20; existing 15-minute-before-close square-off at 15:15; monitoring until close plus 30-second observed-quote grace |
| NSE/BSE index options | 14:20–15:40 | CE/PE VWAP history uses the options session; it is a displayed reference and cannot extend the spot-index agent's entry window |
| MCX energy/bullion futures | 14:20–15:30 | Entry from 14:20; square-off at 15:30; same bounded closing-quote grace |

Primary references:

- [NSE capital market circular CMTR/76941, 19 October 2026](https://nsearchives.nseindia.com/content/circulars/CMTR76941.pdf).
  CAS stocks stop continuous trading at 15:15 and have a separate closing auction;
  the app does not treat pre-open, auctions or post-close as entry candles.
- [NSE F&O circular FAOP/76940, 19 October 2026](https://nsearchives.nseindia.com/content/circulars/FAOP76940.pdf).
- [MCX circular TRD/590/2026, 19 October 2026](https://www.mcxindia.com/docs/default-source/circulars/english/2026/october/circular-590-2026.pdf?sfvrsn=41cf74f3_1).
- BSE notices [20261019-9](https://www.bseindia.com/downloads/UploadDocs/Notices/20261019-9/20261019-9.pdf)
  and [20261019-10](https://www.bseindia.com/downloads/UploadDocs/Notices/20261019-10/20261019-10.pdf).
  BSE blocked automated retrieval (403); its matching cash/derivative times were
  cross-checked against the [broker's linked exchange-circular bulletin](https://zerodha.com/marketintel/bulletin/461711/muhurat-trading-session-on-account-of-diwali-november-2026).

## Implementation and maintenance

`src/data/specialTradingSessions.json` is the shared dated override list, with
separate NSE, BSE, NFO, BFO and MCX segments and a source for each. The browser's
`exchangeCalendar.ts` and server's `indexSession.js` both read it. Device timezone
does not change IST dates. Regular weekday hours and MCX daylight-saving closes
remain the defaults; the override wins even on a Sunday.

Monitoring, setup expiry/square-off, history-refresh boundaries, live candle
alignment, closed-candle caches, opening ranges, chart gaps and session-review
timing use the applicable instrument session. Fifteen-minute/hourly candles
start at the special open, rather than mislabelling a 14:20 tick as 14:15. A late
historical response uses each candle's own date when reconciling live ticks.

The agent can carry Friday's closing history into Sunday's 14:20 opening bar,
then Sunday's 15:25 bar into Monday's opening bar. Missing bars and a missing
scheduled Sunday still break continuity. Previous history supplies warmup;
confirmation still needs three complete, contiguous current-session five-minute
pattern bars and a fresh matching quote. The earliest qualifying assessment is
therefore 14:35, not a wait for 20 or 50 new bars today. Signals are not guaranteed.

ATM VWAP fallback requests Sunday option history from 14:20 to the latest
completed minute (capped at 15:40 for NFO/BFO). Before the first completed minute
it retains the previous available session, and after close retains Sunday's
snapshot. Real option volume is required; heartbeat counts never create volume.

Token expiry, logout, broker rejection and login-date limits still apply. This
remains an app-open engine, including hidden tabs/other routes. A calendar fix
does not bypass authentication or keep monitoring alive after browser closure.

This is **not a complete exchange holiday calendar** or a Diwali-date prediction.
Add each future year's announced special date, segment hours and source circular
to the shared list; never reuse 8 November or these clock times annually. Rebuild
the frontend and restart/redeploy the API when the list changes because the
server loads it at startup. Unlisted weekends stay closed and an unlisted
weekday keeps its existing regular-session behavior.

## Validation

`npm run test:sessions` covers the special-session lifecycle, all seven markets
and both CALL/PUT directions, prior-session warmup, exact token expiry, entry and
closing limits, history publication grace, missing-bar rejection, candle-book
alignment/reconciliation, Monday continuity and server/browser option-session
agreement. The normal monitoring/schedule and ATM VWAP regressions run alongside
it. These are deterministic correctness checks, not performance validation or
authenticated broker-feed verification.
