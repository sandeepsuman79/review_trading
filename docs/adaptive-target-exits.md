# Target exits, extensions and profit protection

The current candle agent now treats its target as an actionable exit level.
This replaces the earlier rule that targets never closed an active trade.
Confirmation remains based on completed five-minute OHLC and price structure;
indicator lines are visual context and there is still no minimum reward/risk.

## Target handling

For CALL, price at/above the current target reaches it. For PUT, price at/below
the current target reaches it. The actual observed quote is the exit price;
a gap does not imply an ideal fill at the target.

When a target is reached, the agent can extend it only if:

1. A matching five-minute review is fresh (review no older than 30 seconds, the
   latest completed bar is current, instrument and exact MCX token match).
2. That candle closed after the position entered. No forming/future bars are used.
3. The review contains a same-side accepted candle pattern, or aligned HH/HL or
   LH/LL trend structure whose last completed close advances in that direction.
   An opposite pattern always prevents extension.
4. Another already observed level is at least two ticks beyond both the quote
   and the current target. The nearest such resistance is chosen for CALL;
   support is chosen for PUT. Confirmed swing pivots, repeated zones and eligible
   unfilled gap edges are considered. Pivots inside a repeated zone are treated
   as part of that zone, not additional targets a fraction of a point farther on.

Targets are rounded toward price to the actual tick, never beyond the chosen
obstacle. If these checks fail or no farther known level exists, the agent books
TARGET_HIT at the observed quote. It does not invent a distant projection merely
to keep holding. Continuing evidence can support multiple successive observed
targets. A same-side pattern by itself never forces a reversal exit.

The original `record.target`, reward/risk and saved confirmation remain intact.
`targetManagement` stores the current target, revision count, source candle,
update time and level basis. Cards, chart levels, notifications and monitoring
exports show the updated target. Critical target/policy updates are checkpointed
before database commit; reloads preserve them.

## Reversal and long-TSL protection

The exit order on live quotes is session/expiry square-off, original SL, saved
TSL, profit guard, confirmed opposite candle pattern, then target exit/extension.
An opposite accepted pattern does not need a replacement entry or minimum
reward/risk. The first completed candle after entry can qualify even if it began
before entry; its close must occur after entry and the quote must be fresh and
at/after that close. Same-side patterns do not trigger this exit.

`targetRules` sets profit-guard activation at +1R and maximum profit giveback at
35%. After that activation, a retreat leaving 65% or less of the best **observed**
profit can close the trade at the observed quote without waiting for a distant
TSL. Ordinary pullbacks above that boundary and trades that never reached +1R
do not trigger it. This is a configurable implementation choice, not an empirically
validated optimum or a guarantee of realised profit during gaps/offline periods.

All active candle-v1/v2 trades use this policy. Older indicator-era open trades
adopt `STRUCTURE_TARGETS_V1` on their next fresh matching live five-minute review.
Missing/stale reviews cannot migrate those records. Already closed historical
trades retain their saved outcomes. New behavior creates local tracked exits;
it does not add broker order placement.

## Reconnects and charts

Completed-bar recovery never borrows a later review to extend an earlier target.
A known opening quote beyond target can settle at that open. A target-only touch
can be reconstructed at the target with exact time disclosed as unknown. If both
target and stop are touched with unknown ordering, the result is AMBIGUOUS rather
than an invented winning or losing sequence. Partial overlap with saved quotes
keeps the existing recovery guard. A fresh observed stop/profit-guard breach is
still actionable after a quote gap.

Every chart has a visible named color legend outside the collapsed values panel:
Supertrend (green/red), VWAP (purple; ATM reference for spot indices), EMA20 (blue),
EMA50 (orange), SMA20 (slate), entry, initial SL, target and TSL when available.
CE/PE price-action views retain the keys with overlay controls disabled; INDEX
view restores indicator toggles. No spot-index VWAP is fabricated from zero volume.

## Sources and validation

Observed levels follow the concepts in [ChartSchool support and resistance](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/support-and-resistance)
and [trend lines](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/trend-lines).
The exact review-age, tick spacing and 35% giveback rules above are our adaptation,
not a trading algorithm endorsed by those sources or evidence of improved returns.

`npm run test:targets` covers mirrored target exits/extensions across all seven
markets, current candle-plan persistence, policy adoption, stale/future/mismatched
reviews, zone deduplication, opposite patterns, profit giveback, OHLC ambiguity,
and all chart legends. Regression checks also cover TSL, existing terminal outcomes,
storage checkpoints, chart rendering and offline replay. The fixed-target offline
comparison model still does not simulate these adaptive live exits.
