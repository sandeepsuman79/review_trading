import { isCandleStrategy } from './strategyPolicy'
import { hasValidRewardRisk } from './tradeRisk'
import type { AngelOneStreamTick } from '../api/angelOne'
import type { PredictionPlan } from './earlyPrediction'
import { candleIntervalMs, tickTimestamp } from './candleData'
import { withinEntryWindow, type DecisionCheck } from './tradeDecision'
import { marketHours } from './tradingSession'

/** UI diagnostics for the live entry stage, separate from technical setup confirmation. */
export function diagnoseTradeEntry(plan: PredictionPlan | undefined, tick: AngelOneStreamTick | undefined, streamConnected: boolean, now: number, active: boolean, issuedAt = plan?.generatedAt) {
  if (active) return { state: 'OPEN TRADE', checks: [] as DecisionCheck[] }
  const checks: DecisionCheck[] = []
  const add = (code: DecisionCheck['code'], label: string, pass: boolean, detail: string, checked = true) => checks.push({ code, label, status: !checked ? 'NOT_CHECKED' : pass ? 'PASS' : 'FAIL', detail })
  const confirmed = plan?.stage === 'CONFIRMED'
  add('SETUP_NOT_CONFIRMED', isCandleStrategy(plan?.strategyVersion ?? '') ? 'Candlestick setup' : 'Technical setup', confirmed, confirmed ? 'Setup confirmation passed; entry is a separate stage' : 'Entry quote not checked until a setup is confirmed')
  if (!confirmed || !plan) return { state: 'NOT CHECKED', checks }
  const signal = Date.parse(plan.signalCandleTime), duration = candleIntervalMs(plan.interval)
  const window = withinEntryWindow(now, plan.instrument) && now < plan.expiresAt && now >= signal + duration && now < signal + 2 * duration
  add('OUTSIDE_ENTRY_WINDOW', 'Current entry window', window, `Current completed setup, before its deadline and within ${marketHours(plan.instrument, now)}`)
  add('LIVE_STREAM_DISCONNECTED', 'Stream', streamConnected, streamConnected ? 'Connected' : 'New entries paused')
  const time = tick ? tickTimestamp(tick) : NaN, price = tick?.ltp
  const quoteFresh = Number.isFinite(time) && now - time >= -1000 && now - time <= 30000 && price !== undefined && Number.isFinite(price) && price > 0
  add('QUOTE_STALE', 'Entry quote freshness', quoteFresh && (!plan.contract || tick?.token === plan.contract.token && tick.exchangeType === 5), 'A matching contract/instrument quote no more than 30 seconds old is required')
  const subsequent = quoteFresh && issuedAt !== undefined && time > issuedAt
  add('QUOTE_BEFORE_SIGNAL', 'Quote after setup issue', subsequent, 'Entry needs an observed quote received after the candidate was issued', quoteFresh)
  const d = plan.side === 'CALL' ? 1 : -1, reached = price !== undefined && d * (price - plan.entry) >= 0
  const canCheck = window && streamConnected && subsequent
  add('ENTRY_NOT_REACHED', 'Entry trigger', reached, `Trigger ${plan.entry.toFixed(2)}${price === undefined ? '' : ` · Quote ${price.toFixed(2)}`}`, canCheck)
  const risk = price === undefined ? NaN : d * (price - plan.stopLoss), reward = price === undefined ? NaN : d * (plan.target - price)
  const rr = risk > 0 ? reward / risk : NaN
  const levelsValid = [plan.entry, plan.stopLoss, plan.target].every(value => Number.isFinite(value) && value > 0)
    && d * (plan.entry - plan.stopLoss) > 0 && d * (plan.target - plan.entry) > 0 && hasValidRewardRisk(rr)
  add('TRADE_LEVELS_INVALID', 'Entry price levels', levelsValid, `The quote must remain between the stop and reference target. ${Number.isFinite(rr) ? `Reference reward/risk ${rr.toFixed(2)}:1; no minimum ratio.` : 'No valid remaining reward/risk geometry.'}`, canCheck)
  const paused = checks.some(check => check.status === 'FAIL' && check.code !== 'ENTRY_NOT_REACHED')
  return { state: paused ? 'ENTRY PAUSED' : reached && canCheck ? 'ELIGIBLE QUOTE' : 'AWAITING ENTRY', checks }
}
