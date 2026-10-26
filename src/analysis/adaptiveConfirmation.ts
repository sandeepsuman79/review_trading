import type { AngelOneCandle } from '../api/angelOne'
import { completedCandles } from './candleData'
import { isCommodity } from './commodities'
import { calculateMovingAverageSeries } from './movingAverages'
import { calculateTechnicalIndicatorSeries } from './technicalIndicators'
import { calculateSessionVwap, candleSession } from './vwap'

export type ThresholdMode = 'ADAPTIVE' | 'FIXED'
export type AdaptiveThresholds = {
  policy: 'adaptive-regime-v1'; mode: ThresholdMode; interval: 'FIFTEEN_MINUTE'; asOf?: string; closedAt?: number
  regime: 'STRONG_TREND' | 'TREND' | 'RANGE' | 'HIGH_VOLATILITY' | 'WARMING_UP' | 'UNAVAILABLE'
  ready: boolean; blocked: boolean; reason: string; direction: 'CALL' | 'PUT' | 'NEUTRAL'
  adx?: number; relativeAtr?: number; atrMedian?: number; baselineBars: number; chop?: number; vwapCrossings?: number
  minimumScore: number; minimumLead: number; minimumAdx: number
}
export const adaptiveRules = { atrBaselineBars: 50, chopBars: 12, minimumChopChanges: 6,
  maximumScore: 80, maximumLead: 30, minimumAdx: 18, maximumAdx: 25, extremeAtrRatio: 2.5, maximumChop: .8 }
const duration = 900000
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clip = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const rounded = (v: number) => Math.round(v * 1000) / 1000
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const cache = new WeakMap<AngelOneCandle[], { at: number; instrument: string; value: Omit<AdaptiveThresholds, 'minimumScore' | 'minimumLead' | 'minimumAdx'> }>()

/** Completed 15m observations only. No headline/tick state, current option proxy,
 * current public context or future candles can rewrite an anchored regime. */
function regime(raw: AngelOneCandle[], instrument: string, now: number): Omit<AdaptiveThresholds, 'minimumScore' | 'minimumLead' | 'minimumAdx'> {
  const bars = completedCandles(raw, 'FIFTEEN_MINUTE', now), last = bars[bars.length - 1]
  const at = Date.parse(last?.[0] ?? ''), closedAt = at + duration
  const current = Boolean(last && now >= closedAt && now < closedAt + duration && candleSession(last[0]) === candleSession(new Date(now).toISOString()))
  const saved = cache.get(raw)
  if (current && saved?.at === closedAt && saved.instrument === instrument) return saved.value
  const base = { policy: 'adaptive-regime-v1' as const, mode: 'ADAPTIVE' as const, interval: 'FIFTEEN_MINUTE' as const,
    asOf: last?.[0], closedAt: Number.isFinite(closedAt) ? closedAt : undefined, baselineBars: 0, direction: 'NEUTRAL' as AdaptiveThresholds['direction'], ready: false, blocked: !current }
  const unavailable = { ...base, regime: 'UNAVAILABLE' as const, reason: 'A fresh completed 15-minute regime candle is required; missing or stale data cannot relax confirmation.' }
  if (!current) return unavailable
  const points = calculateTechnicalIndicatorSeries(bars.map(b => b[2]), bars.map(b => b[3]), bars.map(b => b[4]))
  const averages = calculateMovingAverageSeries(bars.map(b => b[4])), end = bars.length - 1, point = points[end], avg = averages[end], old = averages[end - 3]
  const baseline = points.slice(Math.max(0, end - adaptiveRules.atrBaselineBars), end).map(p => p.atr14).filter((v): v is number => finite(v) && v > 0)
  const atrMedian = baseline.length === adaptiveRules.atrBaselineBars ? median(baseline) : undefined
  const relativeAtr = finite(point?.atr14) && point.atr14 > 0 && atrMedian ? point.atr14 / atrMedian : undefined
  let direction: AdaptiveThresholds['direction'] = 'NEUTRAL'
  if (finite(avg?.ema20) && finite(avg?.ema50) && finite(old?.ema20)) direction = avg.ema20 > avg.ema50 && avg.ema20 > old.ema20 && last[4] > avg.ema20 ? 'CALL'
    : avg.ema20 < avg.ema50 && avg.ema20 < old.ema20 && last[4] < avg.ema20 ? 'PUT' : 'NEUTRAL'
  const tail: AngelOneCandle[] = []
  for (let i = end; i >= 0 && tail.length <= adaptiveRules.chopBars; i--) {
    if (candleSession(bars[i][0]) !== candleSession(last[0]) || i < end && Date.parse(bars[i + 1][0]) - Date.parse(bars[i][0]) !== duration) break
    tail.unshift(bars[i])
  }
  let chop: number | undefined, vwapCrossings: number | undefined
  if (tail.length > adaptiveRules.minimumChopChanges && finite(point?.atr14) && point.atr14 > 0) {
    const noise = point.atr14 * .03
    const moves = tail.slice(1).map((b, i) => b[4] - tail[i][4]).filter(v => Math.abs(v) > noise).map(Math.sign)
    chop = moves.length < 2 ? 1 : moves.slice(1).filter((v, i) => v !== moves[i]).length / (moves.length - 1)
    // Spot-index volume is never invented. Only MCX uses actual session-VWAP crossings.
    if (isCommodity(instrument)) {
      const values = calculateSessionVwap(bars), offset = bars.length - tail.length
      const sides = tail.map((b, i) => values[offset + i] === undefined ? undefined : b[4] - values[offset + i]!)
      const known = sides.every(finite)
      if (known) {
        const signs = sides.filter((v): v is number => finite(v) && Math.abs(v) > noise).map(Math.sign)
        vwapCrossings = signs.slice(1).filter((v, i) => v !== signs[i]).length
        if (signs.length > 1) chop = Math.max(chop, vwapCrossings / (signs.length - 1))
      }
    }
  }
  const ready = finite(relativeAtr) && finite(chop) && finite(point?.adx14) && finite(avg?.ema50)
  const blocked = Boolean(finite(relativeAtr) && relativeAtr >= adaptiveRules.extremeAtrRatio || finite(chop) && chop >= adaptiveRules.maximumChop)
  const kind: AdaptiveThresholds['regime'] = !ready ? 'WARMING_UP' : relativeAtr! >= 1.5 ? 'HIGH_VOLATILITY' : chop! >= .5 || point!.adx14! < 20 ? 'RANGE'
    : point!.adx14! >= 25 && direction !== 'NEUTRAL' ? 'STRONG_TREND' : 'TREND'
  const value = { ...base, baselineBars: baseline.length, ready, blocked, regime: kind, direction, adx: point?.adx14,
    atrMedian, relativeAtr, chop, vwapCrossings,
    reason: blocked ? 'Extreme completed-bar volatility or chop: wait for a new qualified 15-minute regime.' : ready ? 'Adaptive thresholds use this completed 15-minute regime.' : 'ATR median needs 50 prior valid observations and chop needs six current-session changes; conservative fallback floors apply.' }
  cache.set(raw, { at: closedAt, instrument, value }); return value
}

export function deriveAdaptiveThresholds({ candles, instrument, now, side, reversal, higherAligned, mode = 'ADAPTIVE' }: {
  candles: AngelOneCandle[]; instrument: string; now: number; side: 'CALL' | 'PUT'; reversal: boolean; higherAligned: boolean; mode?: ThresholdMode
}): AdaptiveThresholds {
  if (mode === 'FIXED') return { policy: 'adaptive-regime-v1', mode, interval: 'FIFTEEN_MINUTE', regime: 'WARMING_UP', ready: false, blocked: false,
    reason: 'Explicit fixed-threshold comparison baseline.', direction: 'NEUTRAL', baselineBars: 0, minimumScore: reversal ? 65 : 55, minimumLead: reversal ? 20 : 15, minimumAdx: reversal ? 0 : 20 }
  const data = regime(candles, instrument, now)
  if (!data.ready) {
    const highVolatility = finite(data.relativeAtr) && data.relativeAtr >= 1.5
    return { ...data, minimumScore: reversal || highVolatility ? 65 : 60, minimumLead: 20, minimumAdx: reversal ? 0 : highVolatility ? 22 : 20 }
  }
  const excess = Math.max(0, data.relativeAtr! - 1), chop = data.chop!, aligned = higherAligned && data.direction === side
  const highVolatility = data.relativeAtr! >= 1.5
  const minimumScore = reversal ? clip(65 + Math.ceil(4 * excess + 5 * chop), 65, adaptiveRules.maximumScore)
    : clip(Math.ceil(60 - .4 * Math.max(0, data.adx! - 20) + 8 * excess + 10 * chop - (aligned ? 5 : 0)), data.regime === 'RANGE' ? 65 : 55, adaptiveRules.maximumScore)
  const minimumLead = clip((reversal ? 20 : 15) + Math.ceil((reversal ? 4 : 5) * chop + (reversal ? 2 : 3) * excess + (reversal || aligned ? 0 : 3)), reversal ? 20 : 15, adaptiveRules.maximumLead)
  const minimumAdx = reversal ? 0 : rounded(clip(20 + 2 * excess + 5 * chop - (aligned && data.regime === 'STRONG_TREND' ? 2 : 0), adaptiveRules.minimumAdx, adaptiveRules.maximumAdx))
  // Strong ADX must not cancel a volatility penalty in the linear formula.
  return { ...data, minimumScore: highVolatility ? Math.max(minimumScore, clip(65 + Math.ceil(4 * (data.relativeAtr! - 1.5)), 65, 80)) : minimumScore,
    minimumLead: highVolatility || data.regime === 'RANGE' ? Math.max(20, minimumLead) : minimumLead, minimumAdx: highVolatility && !reversal ? Math.max(22, minimumAdx) : minimumAdx }
}

/** Validate recorded policy against its signal time, never against today's clock. */
export function validSavedAdaptive(value: AdaptiveThresholds | undefined, signalClose: number, reversal: boolean) {
  return Boolean(value && value.policy === 'adaptive-regime-v1' && value.mode === 'ADAPTIVE' && value.interval === 'FIFTEEN_MINUTE'
    && value.blocked === false && ['STRONG_TREND', 'TREND', 'RANGE', 'HIGH_VOLATILITY', 'WARMING_UP'].includes(value.regime)
    && ['CALL', 'PUT', 'NEUTRAL'].includes(value.direction) && typeof value.reason === 'string'
    && finite(value.closedAt) && Date.parse(value.asOf ?? '') + duration === value.closedAt && signalClose >= value.closedAt && signalClose < value.closedAt + duration
    && finite(value.minimumScore) && value.minimumScore >= (reversal ? 65 : 55) && value.minimumScore <= adaptiveRules.maximumScore
    && finite(value.minimumLead) && value.minimumLead >= (reversal ? 20 : 15) && value.minimumLead <= adaptiveRules.maximumLead
    && finite(value.minimumAdx) && (reversal ? value.minimumAdx === 0 : value.minimumAdx >= adaptiveRules.minimumAdx && value.minimumAdx <= adaptiveRules.maximumAdx)
    && (value.relativeAtr === undefined || finite(value.relativeAtr) && value.relativeAtr > 0 && value.relativeAtr < adaptiveRules.extremeAtrRatio)
    && (value.chop === undefined || finite(value.chop) && value.chop >= 0 && value.chop < adaptiveRules.maximumChop)
    && Number.isInteger(value.baselineBars) && value.baselineBars >= 0 && value.baselineBars <= adaptiveRules.atrBaselineBars
    && (value.ready === true ? value.regime !== 'WARMING_UP' && value.baselineBars === adaptiveRules.atrBaselineBars
      && finite(value.adx) && value.adx >= 0 && value.adx <= 100 && finite(value.atrMedian) && value.atrMedian > 0
      && finite(value.relativeAtr) && value.relativeAtr > 0 && value.relativeAtr < adaptiveRules.extremeAtrRatio
      && finite(value.chop) && value.chop >= 0 && value.chop < adaptiveRules.maximumChop
      : value.ready === false && value.regime === 'WARMING_UP' && value.minimumScore >= (reversal ? 65 : 60) && value.minimumLead >= 20))
}
