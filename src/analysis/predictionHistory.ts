import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import type { PredictionPlan } from './earlyPrediction'
import { candleIntervalMs, completedCandles, tickTimestamp } from './candleData'
import { withinEntryWindow } from './tradeDecision'
import { agentInterval, candleIntervals, timeframeInfo } from './timeframes'
import { analyzePriceAction } from './priceAction'
import { squareOffTime, tradingSession, squareOffLabel, marketHours } from './tradingSession'
import { commoditySpecs, isCommodity, validCommodityContract, tradeDirection } from './commodities'

export const predictionHistoryKey = 'traders_prediction_history_v1'
export type PredictionStatus = 'PENDING' | 'ACTIVE' | 'TARGET_HIT' | 'STOP_LOSS_HIT' | 'EARLY_EXIT' | 'EXPIRED' | 'AMBIGUOUS' | 'UNVERIFIED'
export type PredictionRecord = PredictionPlan & {
  status: PredictionStatus
  observedThrough: number
  entryAt?: number
  entryPrice?: number
  exitAt?: number
  exitPrice?: number
  points?: number
  latestPrice?: number
  latestPriceAt?: number
  latestPriceSource?: 'LIVE' | 'CANDLE'
  earlyExitSource?: 'MANUAL' | 'AGENT_REVERSAL' | 'SESSION_SQUARE_OFF'
  earlyExitAcknowledgedAt?: number
  reversalCheckedCandle?: string
  outcomeNote: string
}
const statuses: PredictionStatus[] = ['PENDING', 'ACTIVE', 'TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT', 'EXPIRED', 'AMBIGUOUS', 'UNVERIFIED']
export const isOpenPrediction = (record: PredictionRecord) => record.status === 'PENDING' || record.status === 'ACTIVE'
export const isConfirmedTrade = (record: PredictionRecord) => record.stage === 'CONFIRMED' && record.entryAt !== undefined && record.entryPrice !== undefined
export const predictionDisplayStatus = (record: PredictionRecord) => isOpenPrediction(record) ? 'Live' : 'Done'

/** Preserve old snapshots while retiring unentered early picks and legacy overlapping positions. */
export function reconcilePredictionRecords(records: PredictionRecord[]): PredictionRecord[] {
  const positions = new Map<string, PredictionRecord>()
  for (const record of [...records].filter(record => record.status === 'ACTIVE').sort((a, b) => a.entryAt! - b.entryAt! || a.generatedAt - b.generatedAt || a.id.localeCompare(b.id))) {
    if (!positions.has(record.instrument)) positions.set(record.instrument, record)
  }
  const candidates = new Map<string, PredictionRecord>()
  for (const record of [...records].filter(record => record.status === 'PENDING' && record.stage === 'CONFIRMED').sort((a, b) => b.generatedAt - a.generatedAt || a.id.localeCompare(b.id))) {
    if (!positions.has(record.instrument) && !candidates.has(record.instrument)) candidates.set(record.instrument, record)
  }
  return records.map(record => {
    if (record.status === 'ACTIVE' && positions.get(record.instrument)?.id !== record.id) {
      return { ...record, status: 'UNVERIFIED', outcomeNote: 'This legacy position overlapped an earlier live trade for the same instrument. Its outcome is unverified and excluded from success totals; the earlier trade remains under agent management.' }
    }
    if (record.status === 'PENDING' && candidates.get(record.instrument)?.id !== record.id) {
      return { ...record, status: 'EXPIRED', outcomeNote: record.stage === 'EARLY' ? 'Unconfirmed early pick retired before entry; no trade was opened.' : 'Candidate retired before entry because another trade or newer confirmed setup takes priority for this instrument.' }
    }
    return record
  })
}

/** A confirmed candidate may reserve an entry, but cannot overlap a live index trade. */
export function registerConfirmedPrediction(records: PredictionRecord[], plan: PredictionPlan, now = plan.generatedAt): PredictionRecord[] {
  const current = reconcilePredictionRecords(records)
  if (plan.stage !== 'CONFIRMED' || !Number.isFinite(now) || !withinEntryWindow(now, plan.instrument) || now >= plan.expiresAt || isCommodity(plan.instrument) && (!validCommodityContract(plan.contract, plan.instrument) || plan.contract.expiresAt <= now) || current.some(record => record.instrument === plan.instrument && record.status === 'ACTIVE'
    || record.entryAt !== undefined && record.instrument === plan.instrument && record.contract?.token === plan.contract?.token && record.interval === plan.interval && record.side === plan.side && record.signalCandleTime === plan.signalCandleTime)) return current
  const existing = current.find(record => record.id === plan.id)
  if (existing) {
    if (existing.status !== 'PENDING' || !['combined-v1', 'technical-v2'].includes(plan.strategyVersion) || now >= existing.expiresAt) return current
    return current.map(record => record.id === plan.id ? { ...record, ...plan, generatedAt: record.generatedAt, expiresAt: Math.min(record.expiresAt, plan.expiresAt), outcomeNote: 'Current chart levels and market evidence revalidated; awaiting observed entry.' } : record)
  }
  const generatedAt = current.reduce((time, record) => record.instrument === plan.instrument && record.exitAt !== undefined ? Math.max(time, record.exitAt) : time, Math.max(now, plan.generatedAt))
  if (generatedAt >= plan.expiresAt) return current
  return [...current.map(record => record.instrument === plan.instrument && record.status === 'PENDING'
    ? { ...record, status: 'EXPIRED' as const, outcomeNote: 'Replaced by a newer confirmed setup before entry; no trade was opened.' } : record), createPredictionRecord({ ...plan, generatedAt })]
}

export function acknowledgePredictionEarlyExit(record: PredictionRecord, now: number): PredictionRecord {
  if (record.status !== 'EARLY_EXIT' || record.earlyExitAcknowledgedAt !== undefined || !Number.isFinite(now) || now < record.exitAt!) return record
  return { ...record, earlyExitAcknowledgedAt: now }
}
const direction = (record: PredictionRecord) => record.side === 'CALL' ? 1 : -1
const round = (value: number) => Math.round(value * 100) / 100
const recordCutoff = (record: PredictionRecord) => Math.min(squareOffTime(record.entryAt ?? record.generatedAt, record.instrument), record.contract?.expiresAt ?? Infinity)

export function createPredictionRecord(plan: PredictionPlan): PredictionRecord {
  return { ...plan, status: 'PENDING', observedThrough: plan.generatedAt, outcomeNote: 'Waiting for entry; expires after three timeframe intervals.' }
}

export function readPredictionHistory(storage: Pick<Storage, 'getItem'>): PredictionRecord[] {
  const saved = storage.getItem(predictionHistoryKey)
  if (saved === null) return []
  let parsed: { version?: number; records?: unknown }
  try { parsed = JSON.parse(saved) } catch { throw new Error('Saved prediction history is unreadable. Existing data was preserved; export or recover it before saving new calls.') }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(validRecord)) {
    throw new Error('Saved prediction history has an unsupported or invalid format. Existing data was preserved.')
  }
  if (new Set(parsed.records.map(record => record.id)).size !== parsed.records.length) throw new Error('Saved prediction history contains duplicate IDs. Existing data was preserved.')
  return parsed.records
}

function validRecord(value: unknown): value is PredictionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as PredictionRecord
  const d = record.side === 'CALL' ? 1 : -1
  return typeof record.id === 'string' && record.id.length > 0 && ['early-v1', 'combined-v1', 'technical-v2'].includes(record.strategyVersion)
    && ['Nifty 50', 'Sensex', 'Bank Nifty', ...commoditySpecs.map(item => item.name)].includes(record.instrument)
    && (isCommodity(record.instrument) ? validCommodityContract(record.contract, record.instrument) && record.generatedAt < record.contract.expiresAt : record.contract === undefined)
    && (candleIntervals as readonly string[]).includes(record.interval)
    && ['CALL', 'PUT'].includes(record.side) && ['EARLY', 'CONFIRMED'].includes(record.stage)
    && statuses.includes(record.status) && ['NEWS_ALIGNED', 'TECHNICAL_ONLY'].includes(record.contextMode)
    && [record.generatedAt, record.expiresAt, record.observedThrough, record.entry, record.target, record.stopLoss, record.riskReward, record.bullishScore, record.bearishScore].every(Number.isFinite)
    && record.expiresAt > record.generatedAt && record.observedThrough >= record.generatedAt
    && record.entry > 0 && record.target > 0 && record.stopLoss > 0 && (record.entry - record.stopLoss) * d > 0 && (record.target - record.entry) * d > 0
    && Number.isFinite(Date.parse(record.signalCandleTime))
    && [record.reason, record.newsSummary, record.outcomeNote, record.targetBasis].every(item => typeof item === 'string')
    && Array.isArray(record.technicalEvidence) && record.technicalEvidence.every(item => typeof item === 'string')
    && Array.isArray(record.coverage) && record.coverage.every(item => typeof item === 'string')
    && Array.isArray(record.newsEvidence) && record.newsEvidence.every(item => item && typeof item.id === 'string' && typeof item.title === 'string'
      && typeof item.url === 'string' && /^https?:\/\//i.test(item.url) && typeof item.publisher === 'string' && Number.isFinite(Date.parse(item.publishedAt)))
    && [record.entryAt, record.entryPrice, record.exitAt, record.exitPrice, record.points, record.latestPrice, record.latestPriceAt].every(item => item === undefined || Number.isFinite(item))
    && (record.status !== 'ACTIVE' || (record.entryPrice !== undefined && record.entryAt !== undefined))
    && (record.latestPriceSource === undefined || ['LIVE', 'CANDLE'].includes(record.latestPriceSource))
    && (record.earlyExitSource === undefined || ['MANUAL', 'AGENT_REVERSAL', 'SESSION_SQUARE_OFF'].includes(record.earlyExitSource))
    && (record.earlyExitAcknowledgedAt === undefined || record.status === 'EARLY_EXIT' && Number.isFinite(record.earlyExitAcknowledgedAt) && record.earlyExitAcknowledgedAt >= record.exitAt!)
    && (record.reversalCheckedCandle === undefined || Number.isFinite(Date.parse(record.reversalCheckedCandle)))
    && (record.status !== 'EARLY_EXIT' || record.earlyExitSource !== undefined)
    && (!['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(record.status) || (record.entryPrice !== undefined && record.entryAt !== undefined && record.exitAt !== undefined && record.exitPrice !== undefined && record.points !== undefined))
    && (record.points === undefined || record.entryPrice !== undefined && record.exitPrice !== undefined && record.points === round((record.exitPrice - record.entryPrice) * d))
    && validEvidenceSummary(record.evidenceSummary)
}

function validEvidenceSummary(value: PredictionRecord['evidenceSummary']) {
  return value === undefined || value !== null && typeof value === 'object' && ['combined-v1', 'technical-v2'].includes(value.version)
    && Number.isFinite(value.coverage) && value.coverage >= 0 && value.coverage <= 100
    && [value.atr14, value.indiaVix].every(item => item === undefined || Number.isFinite(item) && item > 0)
    && Array.isArray(value.layers) && value.layers.length === (value.version === 'technical-v2' ? 3 : 6) && value.layers.every(layer => layer
      && typeof layer.name === 'string' && layer.name.length <= 60
      && [layer.weight, layer.coverage, layer.bullish, layer.bearish].every(Number.isFinite)
      && layer.weight > 0 && layer.weight <= 100 && layer.coverage >= 0 && layer.coverage <= 1.000001
      && layer.bullish >= 0 && layer.bearish >= 0 && layer.bullish + layer.bearish <= layer.weight + .000001)
    && value.layers.reduce((sum, layer) => sum + layer.weight, 0) === 100
    && (value.sentiment === undefined || value.sentiment !== null && typeof value.sentiment === 'object'
      && [value.sentiment.bullishScore, value.sentiment.bearishScore, value.sentiment.coverage].every(score => Number.isFinite(score) && score >= 0 && score <= 100)
      && value.sentiment.bullishScore + value.sentiment.bearishScore <= 100
      && ['BULLISH', 'BEARISH', 'NEUTRAL', 'UNAVAILABLE'].includes(value.sentiment.bias)
      && ['SUPPORTS', 'OPPOSES', 'MIXED', 'UNAVAILABLE', 'NO_TECHNICAL_DIRECTION'].includes(value.sentiment.alignment)
      && typeof value.sentiment.reason === 'string')
}

export function writePredictionHistory(storage: Pick<Storage, 'setItem'>, records: PredictionRecord[]) {
  // No automatic pruning: an inability to save must be visible, never silently lose history.
  storage.setItem(predictionHistoryKey, JSON.stringify({ version: 1, records }))
}

function close(record: PredictionRecord, status: 'TARGET_HIT' | 'STOP_LOSS_HIT' | 'EARLY_EXIT', price: number, time: number, note: string): PredictionRecord {
  return { ...record, status, exitPrice: price, exitAt: time, observedThrough: time, points: round((price - record.entryPrice!) * direction(record)), outcomeNote: note }
}

/** Actual observed index quotes; a crossed stop fills at the observed price, not an invented ideal price. */
export function observePredictionTick(record: PredictionRecord, price: number, time: number, allowEntry = true): PredictionRecord {
  if (!isOpenPrediction(record) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || time <= record.observedThrough) return record
  let next: PredictionRecord = { ...record, observedThrough: time, latestPrice: price, latestPriceAt: time, latestPriceSource: 'LIVE' }
  const d = direction(record)
  if (next.status === 'PENDING') {
    if (!withinEntryWindow(time, record.instrument) || record.contract && time >= record.contract.expiresAt) return { ...next, status: 'EXPIRED', outcomeNote: `Entry window closed; no entry at or after the ${squareOffLabel(record.instrument, time)} IST square-off cutoff or contract expiry.` }
    if (time >= record.expiresAt) return { ...next, status: 'EXPIRED', outcomeNote: 'Entry was not observed before the three-interval deadline.' }
    if ((price - record.stopLoss) * d <= 0) return { ...next, status: 'EXPIRED', outcomeNote: 'Setup invalidated at its stop level before entry; no simulated entry.' }
    if (!allowEntry) return { ...next, outcomeNote: 'Entry paused while current chart and market evidence is checked.' }
    if ((price - record.entry) * d < 0) return next
    const rr = ((record.target - price) * d) / ((price - record.stopLoss) * d)
    if (!Number.isFinite(rr) || rr < 1.5) return { ...next, status: 'EXPIRED', outcomeNote: 'Entry quote passed the trigger with insufficient reward to risk; no simulated entry.' }
    next = { ...next, status: 'ACTIVE', entryPrice: price, entryAt: time, outcomeNote: 'Entry observed in live instrument quotes.' }
  }
  if (time >= recordCutoff(next)) {
    if (tradingSession(time).date !== tradingSession(next.entryAt!).date) return { ...next, status: 'UNVERIFIED', outcomeNote: `No same-session square-off quote was observed. An overnight price cannot verify the ${squareOffLabel(record.instrument, next.entryAt!)} IST exit.` }
    return close({ ...next, earlyExitSource: 'SESSION_SQUARE_OFF' }, 'EARLY_EXIT', price, time, `Automatic ${squareOffLabel(record.instrument, next.entryAt!)} IST square-off; exit uses the first observed quote at or after the cutoff, not a backdated fill.`)
  }
  if ((price - record.stopLoss) * d <= 0) return close(next, 'STOP_LOSS_HIT', price, time, 'Stop crossed in live instrument quotes; exit uses the observed quote.')
  if ((price - record.target) * d >= 0) return close(next, 'TARGET_HIT', record.target, time, 'Target observed in live instrument quotes; points use the planned target.')
  return next
}

/** Replay only complete post-signal bars. Never infer intrabar ordering or fill missing periods with wins. */
export function observePredictionCandles(record: PredictionRecord, candles: AngelOneCandle[], now: number, allowEntry = true): PredictionRecord {
  if (!isOpenPrediction(record)) return record
  let next = record
  const duration = candleIntervalMs(record.interval)
  for (const candle of completedCandles(candles, record.interval, now)) {
    const time = Date.parse(candle[0]), end = time + duration
    if (end <= next.observedThrough || end <= record.generatedAt) continue
    const cutoff = recordCutoff(next)
    if (time >= cutoff) break // Later candles cannot reconstruct a scheduled exit or overnight trade.
    // A partial bar contains moves before issue / after the last observed tick with unknown ordering.
    if (time !== next.observedThrough) {
      return { ...next, status: 'UNVERIFIED', observedThrough: end, outcomeNote: 'A partial or missing candle overlaps an unobserved period. Outcome cannot be verified; excluded from success rate.' }
    }
    const [, open, high, low, closing] = candle
    const d = direction(next)
    next = { ...next, observedThrough: end, latestPrice: closing, latestPriceAt: end, latestPriceSource: 'CANDLE' }
    if (next.status === 'PENDING') {
      if (!withinEntryWindow(end, next.instrument) || next.contract && end >= next.contract.expiresAt) return { ...next, status: 'EXPIRED', outcomeNote: `Entry was not verified before the ${squareOffLabel(next.instrument, end)} IST square-off cutoff or contract expiry.` }
      if (time >= next.expiresAt) return { ...next, status: 'EXPIRED', outcomeNote: 'Entry deadline elapsed before a trigger was observed.' }
      if ((open - next.stopLoss) * d <= 0) return { ...next, status: 'EXPIRED', outcomeNote: 'Opening quote invalidated the setup before entry.' }
      if (!allowEntry) {
        if (d === 1 ? low <= next.stopLoss : high >= next.stopLoss) return { ...next, status: 'EXPIRED', outcomeNote: 'Stop invalidated the setup while entry confirmation was paused.' }
        continue
      }
      const entryTouched = d === 1 ? high >= next.entry : low <= next.entry
      if (!entryTouched) {
        if (d === 1 ? low <= next.stopLoss : high >= next.stopLoss) return { ...next, status: 'EXPIRED', outcomeNote: 'Stop level invalidated the setup before an entry trigger.' }
        continue
      }
      if (end > next.expiresAt) return { ...next, status: 'AMBIGUOUS', outcomeNote: 'Entry touched in a candle spanning the entry deadline; the exact trigger time is unknown.' }
      const fill = (open - next.entry) * d >= 0 ? open : next.entry
      const rr = ((next.target - fill) * d) / ((fill - next.stopLoss) * d)
      if (!Number.isFinite(rr) || rr < 1.5) return { ...next, status: 'EXPIRED', outcomeNote: 'Gap through entry left insufficient reward to risk.' }
      next = { ...next, status: 'ACTIVE', entryPrice: fill, entryAt: end, outcomeNote: 'Entry reached in a completed candle; exact fill time is unknown.' }
      // If entry occurs inside this bar, a stop may have occurred before or after it.
      const stopTouched = d === 1 ? low <= next.stopLoss : high >= next.stopLoss
      if (stopTouched && fill !== open) return { ...next, status: 'AMBIGUOUS', exitAt: end, outcomeNote: 'Entry and stop touched in the same candle; ordering is unknown.' }
    }
    const stopTouched = d === 1 ? low <= next.stopLoss : high >= next.stopLoss
    const targetTouched = d === 1 ? high >= next.target : low <= next.target
    // An opening gap has a known first quote, unlike the subsequent high/low ordering.
    if ((open - next.stopLoss) * d <= 0) return close(next, 'STOP_LOSS_HIT', open, end, 'Opening gap crossed stop; exit uses candle open. Time is the candle close timestamp.')
    if ((open - next.target) * d >= 0) return close(next, 'TARGET_HIT', next.target, end, 'Opening quote crossed target. Time is the candle close timestamp.')
    if (stopTouched && targetTouched) return { ...next, status: 'AMBIGUOUS', exitAt: end, outcomeNote: 'Target and stop touched in the same candle; ordering is unknown. Excluded from success rate.' }
    if (stopTouched) return close(next, 'STOP_LOSS_HIT', next.stopLoss, end, 'Stop touched in completed candle; time is the candle close timestamp.')
    if (targetTouched) return close(next, 'TARGET_HIT', next.target, end, 'Target touched in completed candle; time is the candle close timestamp.')
  }
  if (next.status === 'PENDING' && now >= next.expiresAt) return { ...next, status: 'EXPIRED', outcomeNote: 'Entry not verified before the three-interval deadline.' }
  return next
}

export function predictionSuccessScore(record: PredictionRecord): number | null {
  if (!['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(record.status) || record.points === undefined) return null
  return record.points > 0 ? 100 : 0
}

export function canExitPredictionEarly(record: PredictionRecord, now: number) {
  return record.status === 'ACTIVE' && record.latestPriceSource === 'LIVE' && record.latestPrice !== undefined && record.latestPrice > 0
    && record.latestPriceAt !== undefined && record.latestPriceAt <= now + 1_000 && now - record.latestPriceAt <= 30_000
}

/** A local simulated close at the last fresh live quote; no broker order is sent. */
export function exitPredictionEarly(record: PredictionRecord, now: number, source: 'MANUAL' | 'AGENT_REVERSAL', reason: string): PredictionRecord {
  if (!canExitPredictionEarly(record, now)) return record
  return close({ ...record, earlyExitSource: source }, 'EARLY_EXIT', record.latestPrice!, record.latestPriceAt!, reason)
}

export function observePredictionReversal(record: PredictionRecord, candles: AngelOneCandle[], now: number): PredictionRecord {
  if (!canExitPredictionEarly(record, now) || record.entryAt === undefined) return record
  const closed = completedCandles(candles, record.interval, now)
  const latest = closed[closed.length - 1]
  if (!latest || latest[0] === record.reversalCheckedCandle) return record
  const start = Date.parse(latest[0])
  const end = start + candleIntervalMs(record.interval)
  // Use a full candle formed after entry, and a live quote received after its close.
  if (start < record.entryAt || record.latestPriceAt! < end || now - start > 2 * candleIntervalMs(record.interval)) return record
  const analysis = analyzePriceAction(closed, record.interval, now, record.instrument)
  const next = { ...record, reversalCheckedCandle: latest[0] }
  const opposite = record.side === 'CALL' ? 'PUT' : 'CALL'
  if (analysis.side !== opposite) return next
  return exitPredictionEarly(next, now, 'AGENT_REVERSAL', `Agent confirmed an opposite ${opposite} setup on the completed ${latest[0]} candle; exited at the observed live instrument quote.`)
}

/** A fresh confirmed agent reversal also manages positions opened on older chart timeframes. */
export function observeConfirmedAgentReversal(record: PredictionRecord, plan: PredictionPlan | undefined, now: number): PredictionRecord {
  if (!plan || !canExitPredictionEarly(record, now) || record.entryAt === undefined || plan.stage !== 'CONFIRMED' || plan.strategyVersion !== 'technical-v2' || plan.interval !== agentInterval || plan.instrument !== record.instrument || plan.side === record.side) return record
  if (record.contract?.token !== plan.contract?.token || record.contract?.symbol !== plan.contract?.symbol) return record
  const start = Date.parse(plan.signalCandleTime), duration = candleIntervalMs(plan.interval)
  if (!Number.isFinite(start) || start < record.entryAt || now < start + duration || now >= start + 2 * duration || record.latestPriceAt! < start + duration || !Number.isFinite(plan.generatedAt) || now < plan.generatedAt || now - plan.generatedAt > 30_000 || !Number.isFinite(plan.expiresAt) || now >= plan.expiresAt) return record
  return exitPredictionEarly({ ...record, reversalCheckedCandle: plan.signalCandleTime }, now, 'AGENT_REVERSAL', `Agent confirmed an opposite ${tradeDirection(plan.instrument, plan.side)} setup on the completed ${timeframeInfo[agentInterval].label} candle ${plan.signalCandleTime}; exited at the observed matching instrument quote before any replacement trade.`)
}

export function predictionHistoryStats(records: PredictionRecord[]) {
  const settled = records.filter(record => predictionSuccessScore(record) !== null)
  const wins = settled.filter(record => record.points! > 0).length
  const losses = settled.filter(record => record.points! < 0).length
  const breakEven = settled.filter(record => record.points === 0).length
  const earlyExits = records.filter(record => record.status === 'EARLY_EXIT').length
  const resolved = settled.length
  return { total: records.length, wins, losses, resolved, successRate: resolved ? wins / resolved * 100 : null,
    breakEven, earlyExits, targets: records.filter(record => record.status === 'TARGET_HIT').length, stops: records.filter(record => record.status === 'STOP_LOSS_HIT').length,
    netPoints: round(settled.reduce((sum, record) => sum + (record.points || 0), 0)),
    open: records.filter(isOpenPrediction).length, excluded: records.filter(record => ['AMBIGUOUS', 'EXPIRED', 'UNVERIFIED'].includes(record.status)).length }
}

export function canEnterConfirmedPrediction(record: PredictionRecord, plan: PredictionPlan | undefined, checkedAt: number, now: number) {
  const signal = Date.parse(record.signalCandleTime), duration = candleIntervalMs(record.interval)
  return Boolean(plan && plan.stage === 'CONFIRMED' && plan.id === record.id && plan.strategyVersion === record.strategyVersion
    && plan.instrument === record.instrument && plan.contract?.token === record.contract?.token && plan.contract?.symbol === record.contract?.symbol && plan.interval === record.interval && plan.side === record.side && plan.signalCandleTime === record.signalCandleTime
    && plan.entry === record.entry && plan.stopLoss === record.stopLoss && plan.target === record.target
    && (record.strategyVersion !== 'technical-v2' || withinEntryWindow(now, record.instrument))
    && (!record.contract || record.contract.expiresAt > now)
    && now >= checkedAt && now - checkedAt <= 30_000 && now >= signal + duration && now < signal + 2 * duration)
}

export function syncPredictionRecord(record: PredictionRecord, candles: AngelOneCandle[], tick: AngelOneStreamTick | undefined, now: number, allowEntry = true, entryPlan?: PredictionPlan, reversalPlan?: PredictionPlan | null): PredictionRecord {
  if (!isOpenPrediction(record)) return record
  if (record.status === 'PENDING' && (!withinEntryWindow(now, record.instrument) || record.contract && record.contract.expiresAt <= now)) return { ...record, status: 'EXPIRED', outcomeNote: `Candidate retired outside the ${marketHours(record.instrument, now)} entry window or after contract expiry.` }
  if (record.contract && tick && (tick.token !== record.contract.token || tick.exchangeType !== 5)) tick = undefined
  const time = tick ? tickTimestamp(tick) : NaN
  if (record.status === 'PENDING' && entryPlan) {
    allowEntry = allowEntry && canEnterConfirmedPrediction(record, entryPlan, now, Math.max(now, Number.isFinite(time) ? time : now))
    if (allowEntry) record = { ...record, bullishScore: entryPlan.bullishScore, bearishScore: entryPlan.bearishScore, technicalEvidence: entryPlan.technicalEvidence, newsSummary: entryPlan.newsSummary, newsEvidence: entryPlan.newsEvidence, coverage: entryPlan.coverage, evidenceSummary: entryPlan.evidenceSummary, contextMode: entryPlan.contextMode }
  }
  const continuous = tick && Number.isFinite(time) && time <= now + 1_000 && now - time <= 30_000 && time - record.observedThrough <= 30_000
  // Replay gaps before a reconnect quote; a missed stop must not turn into a later win.
  let next = continuous ? record : observePredictionCandles(record, candles, now, allowEntry)
  if (isOpenPrediction(next) && Number.isFinite(time) && time <= now + 1_000 && time - next.observedThrough > 30_000 && next.observedThrough < recordCutoff(next)) {
    next = { ...next, status: 'UNVERIFIED', outcomeNote: 'More than 30 seconds of quotes were missed without complete candle coverage. Outcome cannot be verified; excluded from success rate.' }
  }
  if (tick?.ltp !== undefined && time <= now + 1_000) next = observePredictionTick(next, tick.ltp, time, allowEntry && (!entryPlan || now - time <= 30_000))
  if (next.status === 'ACTIVE' && now >= recordCutoff(next)) return tradingSession(now).date !== tradingSession(next.entryAt!).date
    ? { ...next, status: 'UNVERIFIED', outcomeNote: `No same-session square-off quote was observed. The ${squareOffLabel(next.instrument, next.entryAt!)} IST exit and its P/L cannot be verified.` }
    : { ...next, outcomeNote: `${squareOffLabel(next.instrument, next.entryAt!)} IST square-off is due. Waiting for an observed same-session exit quote; no exit price has been invented.` }
  next = reversalPlan === undefined ? observePredictionReversal(next, candles, now) : observeConfirmedAgentReversal(next, reversalPlan ?? undefined, now)
  if (next.status === 'PENDING' && now >= next.expiresAt) next = { ...next, status: 'EXPIRED', outcomeNote: 'Entry not observed before the three-interval deadline.' }
  return next
}
