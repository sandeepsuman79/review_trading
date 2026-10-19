import type { PredictionRecord } from './predictionHistory'
import { chartIntervals, timeframeInfo } from './timeframes'

export const protectionRules = { activationR: .75, breakEvenR: 1, atrMultiplier: 1.5, minimumTrailR: .35 }
export type TradeProtection = { version: 1; peakPrice: number; peakAt: number; stop: number; armed: boolean; atr: number; risk: number }
export type ProtectionAssessment = {
  instrument: string
  contractToken?: string
  interval: typeof chartIntervals[number]
  asOf: string
  reviewedAt: number
  atr?: number
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
/** Trail only actual observed quotes. Never loosen the stop or infer an unobserved peak. */
export function updateTradeProtection(record: PredictionRecord, price: number, time: number, review?: ProtectionAssessment): PredictionRecord {
  if (record.status !== 'ACTIVE' || record.entryPrice === undefined || !Number.isFinite(price) || price <= 0 || time < record.entryAt!) return record
  const d = direction(record), risk = Math.abs(record.entryPrice - record.stopLoss)
  const atr = matchingProtectionAssessment(record, review, time) && typeof review?.atr === 'number' && Number.isFinite(review.atr) && review.atr > 0 ? review.atr : record.protection?.atr ?? record.evidenceSummary?.atr14 ?? risk
  if (!(risk > 0) || !(atr > 0)) return record
  const previous = record.protection
  const higher = !previous || (price - previous.peakPrice) * d > 0
  const peakPrice = higher ? (price - record.entryPrice) * d > 0 ? price : record.entryPrice : previous.peakPrice
  const gain = (peakPrice - record.entryPrice) * d
  const armed = previous?.armed || gain >= protectionRules.activationR * risk
  let stop = previous?.stop ?? record.stopLoss
  if (armed) {
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
