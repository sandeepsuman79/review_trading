import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import type { PredictionPlan } from './earlyPrediction'
import { candleIntervalMs, completedCandles, tickTimestamp } from './candleData'
import { analyzePriceAction } from './priceAction'

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
  earlyExitSource?: 'MANUAL' | 'AGENT_REVERSAL'
  earlyExitAcknowledgedAt?: number
  reversalCheckedCandle?: string
  outcomeNote: string
}
const statuses: PredictionStatus[] = ['PENDING', 'ACTIVE', 'TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT', 'EXPIRED', 'AMBIGUOUS', 'UNVERIFIED']
export const isOpenPrediction = (record: PredictionRecord) => record.status === 'PENDING' || record.status === 'ACTIVE'
export const predictionDisplayStatus = (record: PredictionRecord) => isOpenPrediction(record) ? 'Live' : 'Done'

export function acknowledgePredictionEarlyExit(record: PredictionRecord, now: number): PredictionRecord {
  if (record.status !== 'EARLY_EXIT' || record.earlyExitAcknowledgedAt !== undefined || !Number.isFinite(now) || now < record.exitAt!) return record
  return { ...record, earlyExitAcknowledgedAt: now }
}
const direction = (record: PredictionRecord) => record.side === 'CALL' ? 1 : -1
const round = (value: number) => Math.round(value * 100) / 100

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
  return typeof record.id === 'string' && record.id.length > 0 && record.strategyVersion === 'early-v1'
    && ['Nifty 50', 'Sensex', 'Bank Nifty'].includes(record.instrument)
    && ['FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR'].includes(record.interval)
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
    && (record.earlyExitSource === undefined || ['MANUAL', 'AGENT_REVERSAL'].includes(record.earlyExitSource))
    && (record.earlyExitAcknowledgedAt === undefined || record.status === 'EARLY_EXIT' && Number.isFinite(record.earlyExitAcknowledgedAt) && record.earlyExitAcknowledgedAt >= record.exitAt!)
    && (record.reversalCheckedCandle === undefined || Number.isFinite(Date.parse(record.reversalCheckedCandle)))
    && (record.status !== 'EARLY_EXIT' || record.earlyExitSource !== undefined)
    && (!['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(record.status) || (record.entryPrice !== undefined && record.entryAt !== undefined && record.exitAt !== undefined && record.exitPrice !== undefined && record.points !== undefined))
    && (record.points === undefined || record.entryPrice !== undefined && record.exitPrice !== undefined && record.points === round((record.exitPrice - record.entryPrice) * d))
}

export function writePredictionHistory(storage: Pick<Storage, 'setItem'>, records: PredictionRecord[]) {
  // No automatic pruning: an inability to save must be visible, never silently lose history.
  storage.setItem(predictionHistoryKey, JSON.stringify({ version: 1, records }))
}

function close(record: PredictionRecord, status: 'TARGET_HIT' | 'STOP_LOSS_HIT' | 'EARLY_EXIT', price: number, time: number, note: string): PredictionRecord {
  return { ...record, status, exitPrice: price, exitAt: time, observedThrough: time, points: round((price - record.entryPrice!) * direction(record)), outcomeNote: note }
}

/** Actual observed index quotes; a crossed stop fills at the observed price, not an invented ideal price. */
export function observePredictionTick(record: PredictionRecord, price: number, time: number): PredictionRecord {
  if (!isOpenPrediction(record) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || time <= record.observedThrough) return record
  let next: PredictionRecord = { ...record, observedThrough: time, latestPrice: price, latestPriceAt: time, latestPriceSource: 'LIVE' }
  const d = direction(record)
  if (next.status === 'PENDING') {
    if (time >= record.expiresAt) return { ...next, status: 'EXPIRED', outcomeNote: 'Entry was not observed before the three-interval deadline.' }
    if ((price - record.stopLoss) * d <= 0) return { ...next, status: 'EXPIRED', outcomeNote: 'Setup invalidated at its stop level before entry; no simulated entry.' }
    if ((price - record.entry) * d < 0) return next
    const rr = ((record.target - price) * d) / ((price - record.stopLoss) * d)
    if (!Number.isFinite(rr) || rr < 1.5) return { ...next, status: 'EXPIRED', outcomeNote: 'Entry quote passed the trigger with insufficient reward to risk; no simulated entry.' }
    next = { ...next, status: 'ACTIVE', entryPrice: price, entryAt: time, outcomeNote: 'Entry observed in live index quotes.' }
  }
  if ((price - record.stopLoss) * d <= 0) return close(next, 'STOP_LOSS_HIT', price, time, 'Stop crossed in live index quotes; exit uses the observed quote.')
  if ((price - record.target) * d >= 0) return close(next, 'TARGET_HIT', record.target, time, 'Target observed in live index quotes; points use the planned target.')
  return next
}

/** Replay only complete post-signal bars. Never infer intrabar ordering or fill missing periods with wins. */
export function observePredictionCandles(record: PredictionRecord, candles: AngelOneCandle[], now: number): PredictionRecord {
  if (!isOpenPrediction(record)) return record
  let next = record
  const duration = candleIntervalMs(record.interval)
  for (const candle of completedCandles(candles, record.interval, now)) {
    const time = Date.parse(candle[0]), end = time + duration
    if (end <= next.observedThrough || end <= record.generatedAt) continue
    // A partial bar contains moves before issue / after the last observed tick with unknown ordering.
    if (time !== next.observedThrough) {
      return { ...next, status: 'UNVERIFIED', observedThrough: end, outcomeNote: 'A partial or missing candle overlaps an unobserved period. Outcome cannot be verified; excluded from success rate.' }
    }
    const [, open, high, low, closing] = candle
    const d = direction(next)
    next = { ...next, observedThrough: end, latestPrice: closing, latestPriceAt: end, latestPriceSource: 'CANDLE' }
    if (next.status === 'PENDING') {
      if (time >= next.expiresAt) return { ...next, status: 'EXPIRED', outcomeNote: 'Entry deadline elapsed before a trigger was observed.' }
      if ((open - next.stopLoss) * d <= 0) return { ...next, status: 'EXPIRED', outcomeNote: 'Opening quote invalidated the setup before entry.' }
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
  const analysis = analyzePriceAction(closed, record.interval, now)
  const next = { ...record, reversalCheckedCandle: latest[0] }
  const opposite = record.side === 'CALL' ? 'PUT' : 'CALL'
  if (analysis.side !== opposite) return next
  return exitPredictionEarly(next, now, 'AGENT_REVERSAL', `Agent confirmed an opposite ${opposite} setup on the completed ${latest[0]} candle; exited at the observed live index quote.`)
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

export function syncPredictionRecord(record: PredictionRecord, candles: AngelOneCandle[], tick: AngelOneStreamTick | undefined, now: number): PredictionRecord {
  if (!isOpenPrediction(record)) return record
  const time = tick ? tickTimestamp(tick) : NaN
  const continuous = tick && Number.isFinite(time) && time <= now + 1_000 && now - time <= 30_000 && time - record.observedThrough <= 30_000
  // Replay gaps before a reconnect quote; a missed stop must not turn into a later win.
  let next = continuous ? record : observePredictionCandles(record, candles, now)
  if (isOpenPrediction(next) && Number.isFinite(time) && time <= now + 1_000 && time - next.observedThrough > 30_000) {
    next = { ...next, status: 'UNVERIFIED', outcomeNote: 'More than 30 seconds of quotes were missed without complete candle coverage. Outcome cannot be verified; excluded from success rate.' }
  }
  if (tick?.ltp !== undefined && time <= now + 1_000) next = observePredictionTick(next, tick.ltp, time)
  next = observePredictionReversal(next, candles, now)
  if (next.status === 'PENDING' && now >= next.expiresAt) next = { ...next, status: 'EXPIRED', outcomeNote: 'Entry not observed before the three-interval deadline.' }
  return next
}
