import type { PredictionRecord } from './predictionHistory'
import type { CandleAssessment, CandleSignal } from './candleAgent'
import type { AngelOneCandle } from '../api/angelOne'
import type { ChartStructure } from './chartStructure'
import { matchingProtectionAssessment, type ProtectionAssessment } from './tradeProtection'
import { isCandleStrategy } from './strategyPolicy'

export const targetRules = { profitGuardActivationR: 1, maximumProfitGiveback: .35, minimumTargetTicks: 2 }
export type TargetManagement = { version: 1; target: number; revisions: number; updatedAt: number; asOf: string; basis: string }
export type TargetEvidence = { structure: ChartStructure; signal?: CandleSignal; advancing: boolean }
export const currentTradeTarget = (record: Pick<PredictionRecord, 'target' | 'targetManagement'>) => record.targetManagement?.target ?? record.target
/** Archived positions retain their policy until fresh live review adopts this one. */
export const usesStructureTargets = (record: Pick<PredictionRecord, 'strategyVersion' | 'targetPolicy'>) => isCandleStrategy(record.strategyVersion) || record.targetPolicy === 'STRUCTURE_TARGETS_V1'

/** Completed OHLC only, shared with the live five-minute agent. */
export function candleProtectionReview(assessment: CandleAssessment, candles: AngelOneCandle[]): ProtectionAssessment | undefined {
  if (!assessment.current || !assessment.asOf) return
  const index = candles.findIndex(bar => bar[0] === assessment.asOf), last = candles[index], prior = candles[index - 1]
  const d = assessment.structure.trend === 'UPTREND' ? 1 : -1
  return { instrument: assessment.instrument, contractToken: assessment.contractToken, interval: 'FIVE_MINUTE', asOf: assessment.asOf,
    reviewedAt: assessment.reviewedAt, candleStops: assessment.candleStops,
    targetEvidence: { structure: assessment.structure, signal: assessment.signal, advancing: Boolean(last && prior && d * (last[4] - prior[4]) > 0) } }
}

/** Only an already known, strictly farther level can replace a reached target. */
export function nextStructureTarget(record: PredictionRecord, price: number, time: number, review?: ProtectionAssessment): TargetManagement | undefined {
  if (!review?.targetEvidence || review.interval !== 'FIVE_MINUTE' || !matchingProtectionAssessment(record, review, time)
    || record.entryAt === undefined || Date.parse(review.asOf) + 300000 <= record.entryAt) return
  const { structure, signal, advancing } = review.targetEvidence
  if (structure.asOf !== review.asOf || signal && (signal.side !== record.side || signal.instrument !== record.instrument || signal.contractToken !== record.contract?.token || signal.asOf !== review.asOf)) return
  const d = record.side === 'CALL' ? 1 : -1, tick = record.contract?.tickSize ?? .01
  const supported = signal?.side === record.side || structure.trend === (d === 1 ? 'UPTREND' : 'DOWNTREND') && advancing
  if (!supported) return
  const boundary = Math.max(d * price, d * currentTradeTarget(record)) + targetRules.minimumTargetTicks * tick
  const zones = structure.zones.filter(z => z.role === (d === 1 ? 'RESISTANCE' : 'SUPPORT') && z.touches >= 2 && Date.parse(z.lastAt) <= Date.parse(review.asOf))
  const levels = [
    ...structure.swings.filter(s => s.kind === (d === 1 ? 'HIGH' : 'LOW') && Date.parse(s.confirmedAt) <= Date.parse(review.asOf)
      && !zones.some(z => s.price >= z.low && s.price <= z.high)).map(s => ({ price: s.price, basis: `Confirmed ${d === 1 ? 'resistance' : 'support'} swing` })),
    ...zones.map(z => ({ price: d === 1 ? z.low : z.high, basis: `Confirmed ${d === 1 ? 'resistance' : 'support'} zone` })),
    ...(structure.gap && structure.gap.state !== 'FILLED' && structure.gap.direction === (d === 1 ? 'DOWN' : 'UP') ? [{ price: d === 1 ? structure.gap.low : structure.gap.high, basis: 'Observed unfilled gap edge' }] : []),
  ].filter(level => Number.isFinite(level.price) && level.price > 0 && d * level.price >= boundary - 1e-8).sort((a, b) => d * (a.price - b.price))
  const next = levels[0]
  if (!next) return
  // Round toward price so the target never sits beyond the observed obstacle.
  const target = Math.round((d === 1 ? Math.floor(next.price / tick + 1e-8) : Math.ceil(next.price / tick - 1e-8)) * tick * 1e8) / 1e8
  if (d * target < boundary - 1e-8) return
  return { version: 1, target, revisions: (record.targetManagement?.revisions ?? 0) + 1, updatedAt: time, asOf: review.asOf, basis: next.basis }
}

/** Observed profit only: once +1R was seen, protect 65% of the best gain.
 * It acts only on a retracement and never assumes a fill at the guard price. */
export function profitGuardBreached(record: PredictionRecord, price: number) {
  if (record.status !== 'ACTIVE' || !record.protection || record.entryPrice === undefined) return false
  const d = record.side === 'CALL' ? 1 : -1, risk = Math.abs(record.entryPrice - record.stopLoss)
  const peak = d * (record.protection.peakPrice - record.entryPrice), gain = d * (price - record.entryPrice)
  return risk > 0 && peak >= targetRules.profitGuardActivationR * risk && peak - gain > 0
    && gain <= peak * (1 - targetRules.maximumProfitGiveback) && gain > 0
}

export function validTargetManagement(record: PredictionRecord) {
  const value = record.targetManagement
  if (value === undefined) return true
  const d = record.side === 'CALL' ? 1 : -1, start = Date.parse(value.asOf)
  return usesStructureTargets(record) && value.version === 1 && Number.isFinite(value.target) && value.target > 0 && d * (value.target - record.target) > 0
    && Number.isInteger(value.revisions) && value.revisions > 0 && Number.isFinite(value.updatedAt) && value.updatedAt >= (record.entryAt ?? Infinity)
    && Number.isFinite(start) && start % 300000 === 0 && start + 300000 <= value.updatedAt && value.updatedAt < start + 600000
    && value.updatedAt <= record.observedThrough && typeof value.basis === 'string' && value.basis.length > 0
}
