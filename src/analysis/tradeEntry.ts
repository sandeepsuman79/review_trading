import type { AngelOneStreamTick } from '../api/angelOne'
import type { PredictionPlan } from './earlyPrediction'
import { candleIntervalMs, tickTimestamp } from './candleData'
import { withinEntryWindow, type DecisionCheck } from './tradeDecision'

/** UI diagnostics for the live entry stage, separate from technical setup confirmation. */
export function diagnoseTradeEntry(plan: PredictionPlan | undefined, tick: AngelOneStreamTick | undefined, streamConnected: boolean, now: number, active: boolean, issuedAt = plan?.generatedAt) {
  if (active) return { state: 'OPEN TRADE', checks: [] as DecisionCheck[] }
  const checks: DecisionCheck[] = []
  const add = (code: DecisionCheck['code'], label: string, pass: boolean, detail: string, checked = true) => checks.push({ code, label, status: !checked ? 'NOT_CHECKED' : pass ? 'PASS' : 'FAIL', detail })
  const confirmed = plan?.stage === 'CONFIRMED'
  add('SETUP_NOT_CONFIRMED', 'Technical setup', confirmed, confirmed ? 'Technical confirmation passed; entry is a separate stage' : 'Entry quote not checked until a setup is confirmed')
  if (!confirmed || !plan) return { state: 'NOT CHECKED', checks }
  const signal = Date.parse(plan.signalCandleTime), duration = candleIntervalMs(plan.interval)
  const window = withinEntryWindow(now) && now < plan.expiresAt && now >= signal + duration && now < signal + 2 * duration
  add('OUTSIDE_ENTRY_WINDOW', 'Current entry window', window, 'Current completed setup, before its deadline and within Mon–Fri 09:15–15:15 IST')
  add('LIVE_STREAM_DISCONNECTED', 'Stream', streamConnected, streamConnected ? 'Connected' : 'New entries paused')
  const time = tick ? tickTimestamp(tick) : NaN, price = tick?.ltp
  const quoteFresh = Number.isFinite(time) && now - time >= -1000 && now - time <= 30000 && price !== undefined && Number.isFinite(price) && price > 0
  add('QUOTE_STALE', 'Entry quote freshness', quoteFresh, 'A valid index quote no more than 30 seconds old is required')
  const subsequent = quoteFresh && issuedAt !== undefined && time > issuedAt
  add('QUOTE_BEFORE_SIGNAL', 'Quote after setup issue', subsequent, 'Entry needs an observed quote received after the candidate was issued', quoteFresh)
  const d = plan.side === 'CALL' ? 1 : -1, reached = price !== undefined && d * (price - plan.entry) >= 0
  const canCheck = window && streamConnected && subsequent
  add('TRADE_LEVELS_INVALID', 'Setup invalidation', price !== undefined && d * (price - plan.stopLoss) > 0, 'The entry quote must not invalidate the stop before entry', canCheck)
  add('ENTRY_NOT_REACHED', 'Entry trigger', reached, `Trigger ${plan.entry.toFixed(2)}${price === undefined ? '' : ` · Quote ${price.toFixed(2)}`}`, canCheck)
  const risk = price === undefined ? NaN : d * (price - plan.stopLoss), reward = price === undefined ? NaN : d * (plan.target - price)
  const rr = risk > 0 ? reward / risk : NaN
  add('RR_BELOW_MINIMUM', 'Reward/risk at entry quote', Number.isFinite(rr) && rr >= 1.5, Number.isFinite(rr) ? `${rr.toFixed(2)}:1 / 1.50:1 required` : 'No eligible entry quote', canCheck && reached)
  const paused = checks.some(check => check.status === 'FAIL' && check.code !== 'ENTRY_NOT_REACHED')
  return { state: paused ? 'ENTRY PAUSED' : reached && canCheck ? 'ELIGIBLE QUOTE' : 'AWAITING ENTRY', checks }
}
