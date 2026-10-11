# Review Wala

A React + TypeScript app scaffolded with Vite.

## Available Scripts

- `npm install` — install dependencies
- `npm run dev` — start the development server
- `npm run build` — build for production
- `npm run lint` — run ESLint checks

## Project Files

- `src/main.tsx` — application entry point
- `src/App.tsx` — main app component with review dashboard
- `src/index.css` — global styles
- `src/App.css` — dashboard and review styles
- `src/assets/profile.svg` — profile picture asset
- `src/data/profile.ts` — user profile details
- `src/content/daily.ts` — daily review items
- `src/content/weekly.ts` — weekly review items
- `src/content/monthly.ts` — monthly review items
- `src/content/index.ts` — content list export
- `src/content/types.ts` — review item definitions
- `vite.config.ts` — Vite configuration

## Launch

Open the workspace and run the `Run Review Wala` task, or use `npm run dev` in the terminal.

## Live Market Data

The Traders Prediction page displays live Nifty 50, Sensex, and Bank Nifty data
from the Angel One SmartAPI WebSocket stream. Log in with a valid Angel One
session and restart the frontend after changing `.env`.

Chart history is cached in the browser's local storage separately for each
index and timeframe. A timeframe is fetched from Angel One only when no local
cache exists; live stream ticks update saved candles for already-cached
timeframes. This cache remains on the same browser/device across refreshes and
Angel One logout, but is not shared between browsers or devices.

## Optional Gemini AI candle commentary

The candle panel can request a second opinion from Google's Gemini API. Google
currently lists a free tier for select models, including `gemini-2.5-flash-lite`;
availability, quotas, eligible models, and terms can change. Check the current
[Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) before use.

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Add `GEMINI_API_KEY=your_key` to the project-root `.env` file. Keep it on the
   backend: do not use a `VITE_` prefix, commit the key, or paste it into chat.
3. Optionally set `GEMINI_MODEL=gemini-2.5-flash-lite` in `.env`.
4. Restart `npm run server`, then use **Analyze with Gemini AI** in the candle
   panel. No local model installation is required.

This sends recent candle OHLC data and rule-based context to Google. Review
Google's current terms and data-use policy before enabling it. The AI opinion is
experimental commentary; it does not set entry/target/stop-loss levels and is
not a calibrated probability. Its sourced news outlook can confirm or veto the
chart agent's early setup; numerical trade filters remain deterministic.
Free-tier limits may be reached; the chart's rule-based analysis continues to
work if AI is unconfigured or unavailable.

Model output can be wrong; do not rely on it as financial advice.

## Angel One login

Run the frontend and backend in separate terminals with `npm run dev` and `npm run server`.
Set the backend-only `ANGELONE_*` variables from `.env.example`; never expose the private
key in frontend code. The login request always sends an explicit `state` value (defaulting
to `live`) to avoid an undefined variable error.

## Deploy on Render without `.env`

The Node service serves both the built Vite frontend and `/api/*`, so deploy this
repository as one Render **Web Service**. The optional `render.yaml` Blueprint
contains the same build/start and health-check settings.

For an existing Render project, create or configure a Web Service from this
repository with:

- **Build command:** `npm ci && npm run build`
- **Start command:** `npm run server`
- **Health check path:** `/api/health`

Add the required values under the service's **Environment** settings (not in
Git and not in a deployed `.env` file):

- `VITE_ANGELONE_API_KEY` — needed by the browser for Angel One's market stream.
   Vite embeds this value in the frontend bundle, so it is visible to users; use
   only an API key intended for browser-side SmartAPI streaming.
- `ANGELONE_PRIVATE_KEY` — backend-only Angel One private key.
- `ANGELONE_CLIENT_LOCAL_IP`, `ANGELONE_CLIENT_PUBLIC_IP`,
   `ANGELONE_MAC_ADDRESS` — the client metadata expected by Angel One.
- `GEMINI_API_KEY` — optional; leave unset to disable Gemini commentary.
- `GEMINI_MODEL` — optional; defaults to `gemini-2.5-flash-lite` in the backend.

After saving variables, trigger a deploy. Render provides `PORT` automatically;
the Node service listens on it. Keep all private credentials in Render's
Environment settings. This repository ignores local `.env` files and the service
does not need one in production.

Before publishing, rotate any credentials that were previously committed in
this repository: deleting `.env` from the current revision does not erase it
from Git history. Also verify Angel One permits requests from Render; its
required IP/MAC metadata or IP allowlisting may not work on a free dynamic
hosting instance.

## Early prediction agent

The agent reads the selected index and timeframe from validated, ordered,
deduplicated OHLC history. SMA/EMA, RSI and Supertrend use the same full
history as the chart; structure and setups use the latest 180 completed bars.
The chart can show a forming candle, but the agent excludes it from decisions.
An early directional view is separate from a confirmed trade setup. Scores
measure rule evidence, rather than the probability of a profitable outcome.

Analysis updates when a candle completes or completed OHLC is corrected.
The panel shows the last completed candle time, so saved history is identifiable.
Gemini receives the current completed-candle snapshot and refreshes when that
snapshot, the index, or timeframe changes. Old responses are discarded.
Stream candles use exchange timestamps; disconnected ticks cannot manufacture
new bars. Live interval volume is unavailable, so new stream bars use zero
until historical data supplies volume; session cumulative volume is not used.

Run `npm run test:analysis` for deterministic regression checks. These checks
verify data handling and signal consistency; they do not measure profitability.

## Public news and company context

The prediction agent now fetches `/api/market-context?instrument=Nifty%2050`
for the selected index. Restart the backend after updating the code. Public
feeds require no new API key and refresh every five minutes; providers can
still delay, block, or interrupt them.

- Indian and global headlines: Google News public RSS search, retaining the
  original publisher, article link, and publication time.
- Index membership: official NSE archive CSVs for Nifty 50 and Bank Nifty,
  with the NSE Indices download as a fallback; the official BSE Indices
  website's public constituent response for Sensex.
- Company evidence: NSE corporate-announcement RSS filtered to current
  constituents. A constituent-name news search supplements empty announcement
  results. NSE announcement timestamps without a suffix are interpreted as IST.
- Global-company evidence: a disclosed watchlist for potential technology,
  banking, energy, and automotive exposure. Inclusion does not establish that
  a foreign company affects an Indian index or that a headline is bullish.

Only timestamped headlines published within 48 hours are retained. Duplicates
are removed, failed requests are briefly cached, and stale snapshots keep
original fetch times. Stale feeds cannot support a current combined AI outlook.
Current constituent weights and constituent price breadth are unavailable;
the agent must not invent weighted company contributions.

With the existing backend `GEMINI_API_KEY` configured, completed candles and
fresh public context are supplied to Gemini for a separate combined early
outlook. It must cite supplied article IDs. The panel displays the combined
view and whether it supports or conflicts with the chart. A historical chart,
missing evidence, or invalid citations makes that combined view unavailable.
Technical analysis continues independently; conflicting news vetoes new calls.
News retrieval works without Gemini; combined interpretation requires Gemini.
Its API quotas and pricing are separate from these free public feeds.

Run `npm run test:context` to check source parsing, publication times, membership,
caching, stale-data handling and citation validation. This supplements
`npm run test:analysis`; neither suite establishes predictive profitability.

## Entry levels and saved prediction history

The early agent combines completed-chart evidence with the available sourced
market outlook. Aligned news supports a setup; conflicting or mixed news makes
the agent wait. Missing or neutral interpretation is explicitly labelled
technical-only. Entries, targets and stops come from the chart, never model
generated prices. Early setups use the directional breakout trigger and chart
invalidation before full confirmation, require a clear technical bias and at
least 1.5:1 reward to risk, and expire if no entry is observed within three
selected timeframe intervals. Targets use chart structure where suitable; a
fallback 2R projection is explicitly identified. Stale charts cannot issue calls.

The **History** tab beside Traders Prediction automatically records each new
CALL/PUT issued by all three index agents, independently of the selected chart.
All three monitor the current timeframe, including while History is visible.
Each index/timeframe/completed-candle/side is recorded
once; original levels and evidence are retained when news or charts change.
All saved open calls are tracked across indices and timeframes, even while
viewing History or a different index. This is a forward signal log, not a
backfilled performance claim or an account order-history import.

Records are stored under `traders_prediction_history_v1` in browser
`localStorage`, separately from Angel One authentication. Refresh, login and
logout preserve them on the same browser/origin. Storage errors show a toast;
corrupt saved history is preserved instead of being silently overwritten.
Other tabs receive storage updates. CSV export provides a manual backup.
Changing browsers, clearing site data or private-browsing cleanup can remove
access to local history. No server or cloud history backup is provided.

Results track **index points**, not option premiums, costs or executed orders.
Live triggers use the observed entry quote, reject gaps with insufficient
reward to risk, and stops use the observed quote, including adverse gaps.
Targets credit the planned target. Closed candle replay uses only complete
post-signal bars; bars overlapping a missing/partial observation period become
unverified. Quote gaps longer than 30 seconds without complete candle coverage
are also unverified. A setup is expired if invalidated before entry.
Same-bar target/stop or entry/stop ordering is ambiguous unless
the opening quote establishes the first event. Candle events display the close
timestamp because an exact intrabar fill time is unavailable. Tracking runs
while the page is open; missing periods do not become assumed wins.

The History table lists Indices, Direction, Status, Entry, Target, Stop Loss, Early Exit
and Success Score. It keeps timestamps, fill prices, outcome notes and evidence
inside each row's details. Overall results appear below the table and always
include all saved calls, even when the list is filtered.
Status is **Live** for pending/active calls and **Done** for terminal outcomes;
the detailed outcome remains visible. Order updates share the stream heartbeat
row; expand the latest update to see recent orders.

Successful history writes emit queued toasts with the index, CALL/PUT and event
reason: setup/confirmation, observed entry, target, stop loss, early exit or
expiry/unverified outcome. Early setups are explicitly labeled as such, never
as confirmed calls. Loading saved history does not replay these toasts.

An active call closes early automatically when a completed chart confirms an
opposite CALL/PUT setup. The confirming candle must form entirely after entry,
and the exit uses a live quote received after that candle closes. Stops and
targets are evaluated first. Weak or forming-candle reversals do not trigger
an automatic exit. Manual **Exit early** is also available for active calls
with a live quote from the last 30 seconds. Both save the actual observed
index quote and directional points as `EARLY_EXIT`; no broker order is sent.
Historical prices or stale quotes cannot be used for an early exit.
An early-exit alert remains until **OK** is pressed. Its acknowledgment is saved
with the call, so refresh and login do not reopen a dismissed alert. The exit
and points remain in History; acknowledgment does not change the outcome.

A row's success score is 100% when a verified closed call earned positive
points, and 0% for a loss or break-even. Overall success score is
`profitable closed calls / all verified closed calls × 100`, including early
exits. Pending, active, expired, ambiguous and unverified calls are excluded.
The summary retains target/stop counts and shows early-exit counts, settled
points and per-index results. This measured local simulation score is not a
forecast probability. Existing records remain compatible with the same local
storage key and format; the new early-exit metadata is optional on old records.

Run `npm run test:history` for signal level, news alignment, tick/candle outcome,
ambiguity, storage and statistics regression checks.
