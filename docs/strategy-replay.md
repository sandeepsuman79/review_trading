# Offline strategy replay

This is a bounded, chronological simulation for reviewing a **five-minute baseline**
of the technical entry rules. The live agent now independently evaluates 5-minute,
15-minute and hourly candles; this simulator does not reproduce that cross-timeframe
selection or its reversal exits. It does not train the agent, tune live thresholds,
send orders, fetch broker data or establish prediction accuracy.

Run it from the repository root with Node and the installed development dependencies:

```sh
node scripts/replay-agent.cjs /path/to/candles.json
node scripts/replay-agent.cjs /path/to/candles.json --output /path/to/report.json
node --test tests/strategyReplay.test.cjs
npm run test:replay
```

The first command writes JSON to standard output. `--output` creates a new file and
refuses to overwrite an existing file or the input. Errors go to standard error.
No API keys, network access or login are needed.
In the dashboard, expand **Agent monitoring** and use **Export candles for offline
replay** to download completed candles with matching contract metadata. Use that
file as the CLI input. It contains the current chart instrument, even when an old
held futures contract remains under separate monitoring.

## Input

Wrap exported SmartAPI candles in this structure. Use the full saved, real candle
history; the abbreviated example below has insufficient history to make a setup:

```json
{
  "instrument": "Nifty 50",
  "interval": "FIVE_MINUTE",
  "candles": [
    ["2026-10-16T09:15:00+05:30", 23000, 23010, 22995, 23005, 0]
  ],
  "costs": {
    "slippagePointsPerSide": 0,
    "roundTripCostPoints": 0
  }
}
```

Accepted instruments: Nifty 50, Sensex, Bank Nifty, Natural Gas, Crude Oil, Silver
and Gold. A commodity additionally requires `contract`, copied from its actual
resolved MCX contract: `name`, `root`, `exchange: "MCX"`, `exchangeType: 5`, `token`,
`symbol`, `expiry` (YYYY-MM-DD), `expiresAt` (Unix milliseconds at that expiry's
configured MCX close), and optional `tickSize`/`lotSize`. Do not combine contracts
or splice prices across rollover. Replay each exact contract separately.

Rows must be unique and increasing, five-minute aligned, timezone-qualified OHLCV
with positive consistent prices and nonnegative volume. No guessed volume is
added for spot indices. Maximum input is 5 MB / 5,000 candles. Each evaluation uses
at most the latest 1,000 observed completed bars, with a minimum 50-bar warmup.
This bounded history can differ from a dashboard with a larger local cache.

## Simulation policy

The engine runs the existing price-pattern, evidence-score and confirmed-plan
builders at each completed candle's close, giving them only a chronological
prefix. It supplies **no reconstructed OI/PCR, India VIX, news, FII/DII, global
quotes or paired option VWAP**. Those historical observations are absent, and the
result discloses them. Today's data must never be injected into a past assessment.

A confirmed setup may enter only at the **immediate next observed bar's open**,
with its trigger already reached, in the same session and before expiry. The
actual simulated entry including adverse slippage must retain at least 1.5:1
reward/risk. The simulation does not infer an intrabar entry from the candle high
or low and does not assume a same-close fill. The next open is a simulation
convention, not a live quote proven to have arrived after signal computation.
Missed triggers are skipped; a later retracement cannot resurrect the candidate.

Only one position is active per input instrument. Stops/targets are the plan's
original levels. Stop gaps use the worse observed open; favourable target gaps
are capped at the target. A candle touching both is **AMBIGUOUS**: neither a win
nor a loss is invented. Missing bars/session observations produce **DATA_GAP**;
an unclosed final position is **END_OF_DATA**. These outcomes are excluded from
resolved performance, so always inspect the excluded count alongside any win rate.
After an active position encounters missing observations, new entries are blocked
for the rest of that IST session: an unknown exit cannot justify replacing it.

The configured weekday cutoff is 15:15 IST for indices and the MCX daylight-saving
aware close for commodities. With a complete final candle, square-off uses its
observed close. Without that observation, the exit is unknown. There is no holiday
or special-session calendar in this simulator. Intrabar exit times are reported
at candle close, because OHLC does not reveal the actual touch timestamp.

**Multi-timeframe candidate selection, opposite-frame reversal exits, tick-based
protection, trailing stops and execution latency are not simulated by five-minute
OHLC.** The live strategy no longer performs one-minute technical analysis.
This tool therefore cannot reproduce the complete live strategy or validate a
particular browser incident. It cannot recover unknown tick ordering.

## Reading the output

Each trade reports its signal, observed entry and assumptions, outcome, price
points and R when resolvable. R uses actual simulated entry-to-original-stop risk.
An adverse `slippagePointsPerSide` is applied at both fills; `roundTripCostPoints`
is deducted once from each resolved trade. Defaults are zero and prominently
reported; zero-cost output must not be presented as executable returns. Supply
instrument-specific point costs if you have defensible estimates.
`grossPoints` already includes the assumed slippage; `netPoints` additionally
deducts the supplied round-trip point cost.

The summary includes entered/resolved/excluded counts, wins/losses, resolved-only
win rate, gross/net points, net R and maximum realised drawdown in points and R.
Drawdown starts at zero and uses only chronologically closed, resolved outcomes;
it excludes unrealised drawdown and all unknown outcomes. No position size,
compounding, option premium, account return or rupee profit is inferred.

The test injection parameter exists solely to stress the execution engine with
controlled scenarios. The CLI always uses the current production technical rules.
Validate on unseen sessions and multiple volatility conditions before proposing
any live parameter changes. This tool does not modify those parameters.
