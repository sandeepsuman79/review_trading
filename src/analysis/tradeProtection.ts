import { isCandleStrategy } from './strategyPolicy'
import type { PredictionRecord } from './predictionHistory'
import type { TargetEvidence } from './tradeTargets'
import { chartIntervals, timeframeInfo } from './timeframes'

export const protectionRules = { activationR: 0, breakEvenR: 1, atrMultiplier: 1.5, minimumTrailR: .35 }
export type TradeProtection = { version: 1 | 2; basis?: 'CANDLE_STRUCTURE'; peakPrice: number; peakAt: number; stop: number; armed: boolean; atr?: number; risk: number }
export type ProtectionAssessment = {
  instrument: string
  contractToken?: string
  interval: typeof chartIntervals[number]
  asOf: string
  reviewedAt: number
  atr?: number
  candleStops?: Partial<Record<'CALL' | 'PUT', { price: number; at: string }>>
  targetEvidence?: TargetEvidence
}
const direction = (record: PredictionRecord) => record.side === 'CALL' ? 1 : -1
export function matchingProtectionAssessment(record: PredictionRecord, review: ProtectionAssessment | undefined, now: number) {
  const start = Date.parse(review?.asOf ?? '')
  if (!review || !(chartIntervals as readonly string[]).includes(review.interval)) return false
  const duration = timeframeInfo[review.interval].milliseconds
  return review.instrument === record.instrument && review.contractToken === record.contract?.token
    && Number.isFinite(start) && now >= review.reviewedAt && now - review.reviewedAt <= 30_000
    && now >= start + duration && now < start + 2 * duration
}
/** Seed the recorded entry, then trail observed quotes; never loosen or infer candle peaks. */
export function updateTradeProtection(record: PredictionRecord, price: number, time: number, review?: ProtectionAssessment): PredictionRecord {
  if (record.status !== 'ACTIVE' || record.entryPrice === undefined || !Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || !Number.isFinite(record.entryAt) || time < record.entryAt! || time < record.observedThrough || time < (record.protection?.peakAt ?? record.entryAt!)) return record
  const d = direction(record), risk = Math.abs(record.entryPrice - record.stopLoss)
  if (isCandleStrategy(record.strategyVersion)) {
    if (!Number.isFinite(risk) || risk <= 0) return record
    const previous = record.protection, higher = !previous || d * (price - previous.peakPrice) > 0
    const peakPrice = higher ? d * (price - record.entryPrice) > 0 ? price : record.entryPrice : previous.peakPrice
    const gain = d * (peakPrice - record.entryPrice), tick = record.contract?.tickSize ?? .01
    let candidate = gain > 0 ? peakPrice - d * Math.max(risk, 2 * tick) : record.stopLoss
    const swing = review?.interval === 'FIVE_MINUTE' && matchingProtectionAssessment(record, review, time) ? review.candleStops?.[record.side] : undefined
    if (swing && Number.isFinite(swing.price) && swing.price > 0 && Date.parse(swing.at) >= record.entryAt! && Date.parse(swing.at) <= Date.parse(review!.asOf)
      && Date.parse(swing.at) + 300000 <= time && d * (price - swing.price) > 0)
      candidate = d === 1 ? Math.max(candidate, swing.price) : Math.min(candidate, swing.price)
    if (gain >= risk) candidate = d === 1 ? Math.max(candidate, record.entryPrice) : Math.min(candidate, record.entryPrice)
    candidate = Math.round((d === 1 ? Math.floor(candidate / tick + 1e-8) : Math.ceil(candidate / tick - 1e-8)) * tick * 1e8) / 1e8
    if (gain >= risk) {
      const breakEven = Math.round((d === 1 ? Math.ceil(record.entryPrice / tick - 1e-8) : Math.floor(record.entryPrice / tick + 1e-8)) * tick * 1e8) / 1e8
      candidate = d === 1 ? Math.max(candidate, breakEven) : Math.min(candidate, breakEven)
    }
    const stop = d === 1 ? Math.max(previous?.stop ?? record.stopLoss, candidate) : Math.min(previous?.stop ?? record.stopLoss, candidate)
    return { ...record, protection: { version: 2, basis: 'CANDLE_STRUCTURE', peakPrice, peakAt: higher ? time : previous.peakAt, stop, armed: true, risk } }
  }
  const atr = matchingProtectionAssessment(record, review, time) && typeof review?.atr === 'number' && Number.isFinite(review.atr) && review.atr > 0 ? review.atr : record.protection?.atr ?? record.evidenceSummary?.atr14 ?? risk
  if (!Number.isFinite(risk) || !(risk > 0) || !Number.isFinite(atr) || !(atr > 0)) return record
  const previous = record.protection
  const higher = !previous || (price - previous.peakPrice) * d > 0
  const peakPrice = higher ? (price - record.entryPrice) * d > 0 ? price : record.entryPrice : previous.peakPrice
  const gain = (peakPrice - record.entryPrice) * d
  const armed = previous?.armed || gain >= protectionRules.activationR * risk
  let stop = previous?.stop ?? record.stopLoss
  if (armed && gain > 0) {
    const distance = Math.max(protectionRules.atrMultiplier * atr, protectionRules.minimumTrailR * risk, 2 * (record.contract?.tickSize ?? .01))
    let candidate = peakPrice - d * distance
    if (gain >= protectionRules.breakEvenR * risk) candidate = d === 1 ? Math.max(candidate, record.entryPrice) : Math.min(candidate, record.entryPrice)
    const tick = record.contract?.tickSize ?? .01
    candidate = Math.round((d === 1 ? Math.floor(candidate / tick + 1e-8) : Math.ceil(candidate / tick - 1e-8)) * tick * 100) / 100
    stop = d === 1 ? Math.max(stop, candidate) : Math.min(stop, candidate)
  }
  return { ...record, protection: { version: 1, peakPrice, peakAt: higher ? time : previous.peakAt, stop, armed: Boolean(armed), atr, risk } }
}
export function protectiveStopTouched(record: PredictionRecord, price: number) {
  return Boolean(record.protection?.armed && (price - record.protection.stop) * direction(record) <= 0)
}
