# Monitoring while the app stays open

After a successful Angel One login, one trading dashboard engine stays mounted
above the router. Navigating to Profile, Feed or another app page hides its UI
without destroying streams, completed-candle analysis or the trade ledger.
Returning to Traders Prediction reveals that same engine. Closing the browser
or tab ends monitoring; no server worker or broker-order automation is added.

All tracked indices and resolved commodity contracts continue using the existing
five-minute candle agent. New completed candles trigger setup/reversal review;
observed exchange quotes drive entry, target exit/extension, profit-giveback and
SL/TSL updates. Existing confirmation and index 15:15 entry/square-off rules
remain in place. A single
quote stream serves the agents; navigation does not create a second engine.

## Lifetime and market hours

`monitoringSession.ts` applies the same checks in the app host and inside the
quote, history and trade callbacks. Delayed browser timers cannot authorize a
trade after the actual token deadline.

- Login before 09:00 IST arms the current session; monitoring starts at 09:00.
- Indices receive observations from 09:15 to 15:30 IST. Their existing strategy
  stops new entries and requests square-off from 15:15.
- MCX uses the existing Monday–Friday 09:00 to 23:30/23:55 IST schedule, adjusted
  for US daylight saving. Different instruments stop independently.
- At each exchange close, new entries stop immediately. Up to 30 seconds remain
  to save final **observed** closing quotes, including MCX square-off. No exit
  price is invented if the feed does not supply an eligible quote.
- JWT `exp`, successful logout or definitive broker authentication rejection
  disables monitoring. Token expiry has no closing grace. An unparseable expiry
  disables monitoring and shows a sign-in message.
- The login's IST date is retained across existing token refreshes. A stopped
  market session does not automatically restart on a following day. Sign in for
  that day's session. JWT parsing is only a scheduling hint; the broker remains
  responsible for authentication.

These defaults are overridden by the dated, exchange-specific special sessions in
`src/data/specialTradingSessions.json`. On 8 November 2026, Muhurat monitoring runs
14:20–15:30 IST for the underlying indices and MCX, including the existing closing
quote grace. Index strategy square-off remains 15:15; MCX square-off is 15:30.
The status strip identifies Muhurat and its actual start/deadline. This override
list is not a complete holiday calendar; future special sessions need the newly
published exchange date/hours. See [special-trading-sessions.md](special-trading-sessions.md).
The global status strip shows whether monitoring is active, armed or stopped and
the token/session deadline. The dashboard can still display saved records after
monitoring stops; valid sessions can manually retrieve history after market close.

## Hidden tabs and saved state

The completed-candle refresh scheduler no longer skips `document.hidden`.
It checks for due history every 15 seconds, retains bounded retries/backoff, and
also catches up on focus, online and visibility changes. Charts, news, sentiment
reference panels and VIX polling unmount or pause when the dashboard is hidden;
the price-action agents, trade persistence and quote handling remain active.
Disconnected quote streams retry with backoff capped at 60 seconds rather than
giving up after five attempts. Focus, visibility and online events can reconnect
a disconnected stream sooner; an already connected stream is left in place.

The existing IndexedDB ledger, local storage fallback and write-ahead checkpoints
save entries, trailing levels and exits. Page changes do not reload the ledger.
Browser sleep, tab discard, offline periods and OS suspension can interrupt
JavaScript and quotes. The app reconciles saved state and available historical
data when it resumes; it cannot guarantee continuous monitoring through those
interruptions or reconstruct an unobserved tick sequence.

## Validation

Run `npm run test:monitoring` for token/market lifetime rules and session recovery.
The tests cover all seven markets, pre-open arming, winter/summer MCX closes,
index entry cutoff, bounded closing settlement, exact token expiry, missing or
invalid tokens, logout, rejected sessions, stale rejection after a newer login,
weekends and next-day restart prevention.

Local isolated Chrome checks additionally exercised the actual React router host
through login, route changes, hidden-tab state, token rotation, rejection,
expiry, logout and market close. A separate preview used the actual PredictionPage,
agents and local ledger with simulated broker candles/quotes: all seven markets
saved pending setups, confirmed entries, tightened TSL above entry after +3R,
saved protective exits, and refreshed completed-bar history while hidden on Feed.
The preview deliberately simulated visibility and broker responses; it does not
claim an authenticated live-feed test or continuous operation during browser sleep.
