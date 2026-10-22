import type { AngelOneCandle } from '../api/angelOne'
import type { DirectionalAlignment } from './directionalAlignment'
import type { MovingAveragePoint } from './movingAverages'
import type { TechnicalIndicatorPoint } from './technicalIndicators'
import type { PriceActionInterval } from './priceAction'
import { candleIntervalMs } from './candleData'
import { candleSession } from './vwap'
import { inTradingEntryWindow } from './tradingSession'

export type TrendCandidate = {
  side: 'CALL' | 'PUT'; pattern: 'TREND_CONTINUATION_BREAK' | 'DIRECTIONAL_IMPULSE_BREAK'
  setup: string; reason: string; entry: number; stopLoss: number; target: number; score: number
  confluence: string[]; invalidation: string; targetBasis: string
}

/** Local price events can qualify while the slower EMA50 and distant pivots lag.
 * These candidates still go through the shared score, ATR, RR and live-entry gates. */
export function findTrendSetups(candles: AngelOneCandle[], averages: MovingAveragePoint[], indicators: TechnicalIndicatorPoint[], interval: PriceActionInterval, alignment: DirectionalAlignment, support?: number, resistance?: number, instrument?: string): TrendCandidate[] {
  const end = candles.length - 1, latest = candles[end], previous = candles[end - 1]
  const point = indicators[end], avg = averages[end], olderAvg = averages[end - 3]
  const atr = point?.atr14, rsi = point?.rsi14, ema = avg?.ema20
  if (candles.length < 50 || !latest || !previous || !atr || !Number.isFinite(atr) || atr <= 0 || rsi === undefined || !Number.isFinite(rsi) || ema === undefined || !Number.isFinite(ema)
    || alignment.at !== latest[0] || !inTradingEntryWindow(Date.parse(latest[0]) + candleIntervalMs(interval), instrument)) return []
  const tail = candles.slice(-4), session = candleSession(latest[0])
  if (tail.some((bar, i) => candleSession(bar[0]) !== session || i > 0 && Date.parse(bar[0]) - Date.parse(tail[i - 1][0]) !== candleIntervalMs(interval))) return []
  const range = latest[2] - latest[3], body = Math.abs(latest[4] - latest[1])
  const buffer = Math.max(.05 * atr, latest[4] * .00003)
  // A fresh local break is required; distant EMA entries are bounded, never unlimited.
  if (range <= 0 || Math.abs(latest[1] - previous[4]) > .5 * atr || Math.abs(latest[4] - ema) > 3 * atr) return []
  const result: TrendCandidate[] = []
  for (const d of [1, -1] as const) {
    const side = d === 1 ? 'CALL' : 'PUT', routes = alignment.routes.filter(route => route.side === side)
    const closePosition = d === 1 ? (latest[4] - latest[3]) / range : (latest[2] - latest[4]) / range
    if (!routes.length || d * (latest[4] - latest[1]) <= buffer || closePosition < .65) continue
    const add = (pattern: TrendCandidate['pattern'], setup: string, level: number, score: number) => {
      const structuralStop = d === 1 ? Math.min(latest[3], previous[3], level) - buffer : Math.max(latest[2], previous[2], level) + buffer
      const stopLoss = latest[4] - d * Math.max(d * (latest[4] - structuralStop), atr)
      const observedTarget = d === 1 ? resistance : support
      const hasTarget = observedTarget !== undefined && d * (observedTarget - latest[4]) > 0
      const target = hasTarget ? observedTarget : latest[4] + d * 2 * Math.abs(latest[4] - stopLoss)
      if (![latest[4], stopLoss, target].every(value => Number.isFinite(value) && value > 0)) return
      result.push({ side, pattern, setup, reason: `${setup}: a fresh completed price break with ${routes.map(route => route.name).join(' or ')}.`, entry: latest[4], stopLoss, target, score,
        confluence: ['Fresh local price break', ...routes.map(route => route.name), `RSI(14) ${rsi.toFixed(1)}`], invalidation: 'Loss of the local break and its structural stop invalidates this setup.',
        targetBasis: hasTarget ? 'Observed chart resistance/support' : '2R projection from ATR-aware invalidation; not an observed level' })
    }
    const localLevel = d === 1 ? previous[2] : previous[3]
    const progress = d * (latest[4] - tail[0][4])
    const directionalCloses = tail.slice(1).filter((bar, i) => d * (bar[4] - tail[i][4]) > buffer).length
    const emaProgress = olderAvg?.ema20 === undefined ? 0 : d * (ema - olderAvg.ema20)
    const heldSupertrend = indicators.slice(-4).every((p, i) => p.supertrendDirection === (d === 1 ? 'UP' : 'DOWN') && p.supertrend10 !== undefined && d * (tail[i][4] - p.supertrend10) > 0)
    const directionalRsi = d * (rsi - 50) >= 0
    if (range <= 1.5 * atr && body >= .35 * range && directionalRsi && (emaProgress > .03 * atr || heldSupertrend)
      && d * (latest[4] - ema) > 0 && progress >= .25 * atr && directionalCloses >= 2 && d * (latest[4] - localLevel) > buffer) {
      add('TREND_CONTINUATION_BREAK', `${d === 1 ? 'Bullish' : 'Bearish'} local trend continuation`, localLevel, 72)
    }
    // Accept a decisive first expansion only with an actual range break, directional
    // RSI acceleration and a matching existing route. A gap or wick alone cannot enter.
    const priorRange = candles.slice(-4, -1)
    const rangeLevel = d === 1 ? Math.max(...priorRange.map(bar => bar[2])) : Math.min(...priorRange.map(bar => bar[3]))
    const priorRsi = indicators[end - 1]?.rsi14
    if (range > 1.5 * atr && range <= 3 * atr && body >= .65 * range && closePosition >= .8 && directionalRsi
      && priorRsi !== undefined && d * (rsi - priorRsi) > 0 && d * (latest[4] - ema) > 0 && d * (latest[4] - rangeLevel) > buffer) {
      add('DIRECTIONAL_IMPULSE_BREAK', `${d === 1 ? 'Bullish' : 'Bearish'} directional impulse break`, rangeLevel, 75)
    }
  }
  return result
}

export function momentumSetupBlockers(candles: AngelOneCandle[], averages: MovingAveragePoint[], indicators: TechnicalIndicatorPoint[], interval: PriceActionInterval, alignment: DirectionalAlignment): string[] {
  const latest = candles[candles.length - 1], point = indicators[indicators.length - 1], ema = averages[averages.length - 1]?.ema20
  if (!latest || !point?.atr14 || ema === undefined) return ['Momentum detection is waiting for warmed candle indicators.']
  const atr = point.atr14, range = latest[2] - latest[3], distance = Math.abs(latest[4] - ema) / atr
  const blockers: string[] = []
  if (distance > 1.8) blockers.push(`Price is ${distance.toFixed(2)} ATR from EMA20; standard momentum needs ≤1.8 ATR, and continuation/impulse entries need ≤3 ATR plus their own price confirmation.`)
  if (range > 2 * atr) blockers.push(`Latest candle range is ${(range / atr).toFixed(2)} ATR; a large expansion needs a qualifying directional impulse break (maximum 3 ATR).`)
  if (range <= 0 || Math.abs(latest[4] - latest[1]) < .35 * range) blockers.push('The latest candle has insufficient directional body; wait for a completed price break.')
  if (!alignment.routes.length) blockers.push('No current EMA, Supertrend or observed-level route matches a completed directional move.')
  const recent = candles.slice(-3)
  if (recent.some((bar, i) => candleSession(bar[0]) !== candleSession(latest[0]) || i > 0 && Date.parse(bar[0]) - Date.parse(recent[i - 1][0]) !== candleIntervalMs(interval))) blockers.push('Setup detection needs consecutive completed candles from this session; a gap cannot establish a fresh break.')
  if (!blockers.length) blockers.push('Direction alone is not an entry: waiting for a fresh range break, local continuation, pullback reclaim or confirmed level reaction.')
  return blockers
}
