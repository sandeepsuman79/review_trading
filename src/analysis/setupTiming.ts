import type { AngelOneCandle } from '../api/angelOne'
import type { EarlyPrediction, PredictionPlan } from './earlyPrediction'
import type { PredictionRecord } from './predictionHistory'
import { candleIntervalMs } from './candleData'

/** A completed technical setup is current only until the following candle closes. */
export function setupEntryDeadline(plan: PredictionPlan) {
  return plan.strategyVersion === 'technical-v2' && plan.stage === 'CONFIRMED'
    ? Math.min(plan.expiresAt, Date.parse(plan.signalCandleTime) + 2 * candleIntervalMs(plan.interval))
    : plan.expiresAt
}

/** Forming bars may invalidate an entry, but can never confirm a new one. */
export function consumedSetupReason(plan: PredictionPlan, candles: AngelOneCandle[], now: number): string | undefined {
  if (plan.stage !== 'CONFIRMED' || plan.strategyVersion !== 'technical-v2') return
  if (now >= setupEntryDeadline(plan)) return 'Setup entry window ended at the next candle close; waiting for a fresh completed setup.'
  const after = Date.parse(plan.signalCandleTime) + candleIntervalMs(plan.interval), d = plan.side === 'CALL' ? 1 : -1
  for (let i = candles.length - 1; i >= 0; i--) {
    const bar = candles[i], time = Date.parse(bar[0])
    if (time < after) break
    if (!Number.isFinite(time) || time > now || !bar.slice(1, 5).every(value => typeof value === 'number' && Number.isFinite(value) && value > 0) || bar[2] < Math.max(bar[1], bar[4]) || bar[3] > Math.min(bar[1], bar[4])) continue
    if ((d === 1 ? bar[3] - plan.stopLoss : plan.stopLoss - bar[2]) <= 0) return 'Setup invalidation was already crossed after the signal candle; no late entry on a retracement.'
    if ((d === 1 ? bar[2] - plan.target : plan.target - bar[3]) >= 0) return 'Setup target was already reached after the signal candle; that move is over and cannot create a late entry.'
  }
}

/** A competing older timeframe must not immediately reopen the side just closed
 * by an agent reversal. An opposite replacement or a newly closed candle is eligible.
 */
export function reversalReentryReason(plan: PredictionPlan, records: PredictionRecord[]): string | undefined {
  if (plan.stage !== 'CONFIRMED') return
  const lastReversal = records.filter(record => record.instrument === plan.instrument
    && record.contract?.token === plan.contract?.token && record.contract?.symbol === plan.contract?.symbol
    && record.status === 'EARLY_EXIT' && record.earlyExitSource === 'AGENT_REVERSAL' && Number.isFinite(record.exitAt))
    .reduce<PredictionRecord | undefined>((latest, record) => !latest || record.exitAt! > latest.exitAt! ? record : latest, undefined)
  const closedAt = Date.parse(plan.signalCandleTime) + candleIntervalMs(plan.interval)
  if (lastReversal?.side === plan.side && closedAt <= lastReversal.exitAt!) return 'This direction was closed by an agent reversal after this signal candle. Waiting for a newly completed setup before reopening the same side; an opposite replacement may proceed.'
}

/** Keep a finished ledger signal from reappearing as a new confirmed card. */
export function currentSetupPrediction(prediction: EarlyPrediction, records: PredictionRecord[], candles: AngelOneCandle[], now: number): EarlyPrediction {
  if (!('plan' in prediction) || prediction.plan.stage !== 'CONFIRMED') return prediction
  const record = records.find(record => record.id === prediction.plan.id)
  if (record && record.status !== 'PENDING' && record.status !== 'ACTIVE') return { side: 'WAIT', reason: `This setup has ended (${record.status.replace(/_/g, ' ')}). ${record.outcomeNote} Waiting for a fresh completed setup.` }
  const reversalReason = record?.status === 'ACTIVE' ? undefined : reversalReentryReason(prediction.plan, records)
  if (reversalReason) return { side: 'WAIT', reason: reversalReason }
  const reason = consumedSetupReason(prediction.plan, candles, now)
  return reason ? { side: 'WAIT', reason } : prediction
}
