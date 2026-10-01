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
experimental commentary; it does not set entry/target/stop-loss levels, is not a
calibrated probability, and never overrides the deterministic trade decision.
Free-tier limits may be reached; the chart's rule-based analysis continues to
work if AI is unconfigured or unavailable.

The AI opinion is experimental commentary based only on recent completed OHLC
candles and the rule-based context. It does not set entry/target/stop-loss
levels, is not a calibrated probability, and never overrides the rule-based
trade decision. Model output can be wrong; do not rely on it as financial
advice. The first response may take longer while the model downloads/loads.

## Angel One login

Run the frontend and backend in separate terminals with `npm run dev` and `npm run server`.
Set the backend-only `ANGELONE_*` variables from `.env.example`; never expose the private
key in frontend code. The login request always sends an explicit `state` value (defaulting
to `live`) to avoid an undefined variable error.
