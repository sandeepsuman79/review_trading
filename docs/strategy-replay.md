# Offline strategy replay

The default evaluator is the live **five-minute-candles-v2** entry policy.
This bounded chronological simulator reviews entries under a **fixed-target
comparison exit model**. It does not reproduce live trailing stops or opposite
candlestick exits, fetch broker data, send orders or establish profitability.
See [the live candlestick rules](candlestick-agent.md).

Run from the repository root with Node and installed development dependencies:

```sh
node scripts/replay-agent.cjs /path/to/candles.json
node scripts/replay-agent.cjs /path/to/candles.json --output /path/to/report.json
npm run agent:compare -- /path/to/candles.json --output /path/to/comparison.json
npm run test:replay
```

The first command prints JSON. `--output` creates a new file and refuses to
overwrite an existing file or the input. Errors go to standard error. No login
or API keys are needed. In the dashboard, **Agent monitoring → Export candles
and agent diagnostics** downloads completed candles, contract metadata, observed
decisions/transitions and current entry/quote/connection context. The current
snapshot is never injected into historical evaluations.

## Input

Use real saved history; this abbreviated example has insufficient warmup:

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

Accepted instruments are Nifty 50, Sensex, Bank Nifty, Natural Gas, Crude Oil,
Silver and Gold. A commodity also needs its actual resolved MCX `contract`:
`name`, `root`, `exchange: "MCX"`, `exchangeType: 5`, `token`, `symbol`, `expiry`
(YYYY-MM-DD), `expiresAt` (Unix milliseconds at configured expiry close), and
optional `tickSize`/`lotSize`. Replay each exact contract separately; do not splice
prices across rollover.

Rows must be unique, increasing, five-minute aligned and timezone-qualified,
with consistent positive OHLC prices and nonnegative volume. Spot-index volume
is not invented. Maximum input is 5 MB / 5,000 candles. Evaluations use at most
the latest 1,000 observed completed bars. The current candle policy needs 20
completed bars across available history and three contiguous current-session
pattern bars. Archived indicator evaluators retain their 50-bar warmup.

## Entry and comparison exits

Each evaluation receives only the completed chronological prefix. Current
candle-only signals use no RSI, VWAP, volume, sentiment, coverage score or higher
timeframe inputs. Historical ATM snapshots are unnecessary for this policy.

A confirmed setup can enter only at the **immediate next observed bar's open**,
with its trigger reached, in the same session and before expiry. Actual entry
including adverse slippage must retain positive risk and remaining reward; no
minimum reward/risk ratio applies. An intrabar
high/low does not imply an entry, and no same-close fill is assumed. Missed
triggers are skipped. This conservative convention can produce far fewer entries
than confirmed candidates; it is not an observed live quote sequence.

Only one position is active per instrument. The comparison uses original stops
and reference targets. Stop gaps use the worse observed open; favourable target
gaps are capped at the target. Touching both in one bar is **AMBIGUOUS**. Missing
observations produce **DATA_GAP**; an unclosed final position is **END_OF_DATA**.
These unknown outcomes are excluded from resolved performance. After a missing
observation affects an active position, further entries are blocked for that
IST session because its exit is unknown.

The cutoff is 15:15 IST for indices and the configured daylight-saving-aware MCX
close for commodities. Square-off uses a complete final candle's observed close;
without that observation the exit is unknown. Dated special-session overrides
also apply, including 8 November 2026 Muhurat; a complete holiday calendar is not
connected. OHLC does not establish intrabar touch order or exact exit time.

**Live uncapped-profit TSL, opposite-pattern exits, intrabar trigger fills and
execution latency are not simulated.** A fixed-target result cannot validate
the new live exit policy or reproduce a particular browser incident.

## Output and archived comparisons

Reports include confirmed-candidate and entry counts, trade assumptions, resolved
and excluded outcomes, wins/losses, resolved-only win rate, price points, R and
maximum realised drawdown. R uses actual simulated entry-to-original-stop risk.
Drawdown starts at zero and excludes unrealised moves and unknown outcomes.
No option premium, position size, account return or rupee profit is inferred.

`slippagePointsPerSide` applies adversely to both fills; `roundTripCostPoints`
is deducted once per resolved trade. Defaults are zero and are labelled.
`grossPoints` includes assumed slippage; `netPoints` also deducts point costs.
Zero-cost results are not executable returns.

`diagnostics` contains reconstructed per-direction failures and the last 20
evaluations. These are separate from exported actual observed `assessments`.
Several blockers can apply to a candidate; a price-qualified pattern is not an
entered trade. Current diagnostics use candle checks. Archived adaptive/fixed
diagnostics retain their original indicator and mandatory historical-context
checks; no missing inputs are invented.

`agent:compare` writes four results under identical costs and comparison exits:
`legacy`, `fixed`, `adaptive` and `revised` (the current candle-only policy).
Archived index indicator policies require genuine recorded `atmVwapSnapshots`;
the current quote/context cannot stand in for historical snapshots. Genuine
snapshots must be ordered by fetch time and visible only after they were fetched.
Missing snapshots can explain zero archived confirmations without establishing
a live-feed fault. The [earlier monitoring investigation](nifty-monitoring-investigation.md)
documents such an archived example.

The CLI always uses the current entry evaluator; a test-only injection parameter
allows controlled execution scenarios. These tools do not tune live parameters.
Use unseen sessions and realistic costs for further evaluation; a sample result
does not establish improvement or market prediction accuracy.
