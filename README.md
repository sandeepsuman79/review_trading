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

## Live Market Data and LLM Predictions

The Traders Prediction page can show live Indian index quotes and optional LLM-generated outlooks.

1. Create a `.env` file in the project root.
2. Add your API keys using the example in `.env.example`:
   - `VITE_TWELVEDATA_API_KEY` for live index quotes
   - `VITE_OPENAI_API_KEY` for optional prediction generation
3. Restart the Vite dev server after changing `.env`.

When configured, the Prediction page will:
- fetch live quotes from TwelveData for Indian indices
- show current price and intraday change
- optionally generate updated predictions using OpenAI or another compatible LLM endpoint

## Angel One login

Run the frontend and backend in separate terminals with `npm run dev` and `npm run server`.
Set the backend-only `ANGELONE_*` variables from `.env.example`; never expose the private
key in frontend code. The login request always sends an explicit `state` value (defaulting
to `live`) to avoid an undefined variable error.
