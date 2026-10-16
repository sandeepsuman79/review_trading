import type { PredictionRecord } from './predictionHistory'
import type { MinuteReview } from './minuteMonitor'

export const protectionRules = { activationR: .75, breakEvenR: 1, atrMultiplier: 1.5, minimumTrailR: .35 }
export type TradeProtection = { version: 1; peakPrice: number; peakAt: number; stop: number; armed: boolean; atr: number; risk: number }
const direction = (record: PredictionRecord) => record.side === 'CALL' ? 1 : -1
export function matchingMinuteReview(record: PredictionRecord, review: MinuteReview | undefined, now: number) {
  const start = Date.parse(review?.asOf ?? '')
  return Boolean(review && review.instrument === record.instrument && review.contractToken === record.contract?.token && review.current
    && now >= review.reviewedAt && now - review.reviewedAt < 60_000 && now >= start + 60_000 && now < start + 120_000)
}
/** Trail only actual observed quotes. Never loosen the stop or infer an unobserved peak. */
export function updateTradeProtection(record: PredictionRecord, price: number, time: number, review?: MinuteReview): PredictionRecord {
  if (record.status !== 'ACTIVE' || record.entryPrice === undefined || !Number.isFinite(price) || price <= 0 || time < record.entryAt!) return record
  const d = direction(record), risk = Math.abs(record.entryPrice - record.stopLoss)
  const atr = matchingMinuteReview(record, review, time) && review?.indicators.atr ? review.indicators.atr : record.protection?.atr ?? record.evidenceSummary?.atr14 ?? risk
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
export function minuteTrendExit(record: PredictionRecord, review: MinuteReview | undefined, now: number) {
  const start = Date.parse(review?.asOf ?? '')
  return Boolean(matchingMinuteReview(record, review, now) && review?.pressure && review.pressure.side !== record.side
    && review.pressure.confirmed && record.entryAt !== undefined && start >= record.entryAt
    && record.latestPriceSource === 'LIVE' && record.latestPriceAt !== undefined && record.latestPriceAt >= start + 60_000
    && now - record.latestPriceAt >= -1000 && now - record.latestPriceAt <= 30_000)
}
