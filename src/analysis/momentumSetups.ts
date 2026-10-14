import { analyzeDirectionalAlignment, type DirectionalAlignment } from './directionalAlignment'
import type { AngelOneCandle } from '../api/angelOne'
import type { MovingAveragePoint } from './movingAverages'
import type { TechnicalIndicatorPoint } from './technicalIndicators'
import type { PriceActionInterval } from './priceAction'
import { candleIntervalMs } from './candleData'
import { candleSession } from './vwap'

export type MomentumCandidate = {
  side: 'CALL' | 'PUT'; pattern: 'TREND_MOMENTUM_BREAK' | 'EMA_PULLBACK_RECLAIM' | 'OPENING_RANGE_BREAKOUT' | 'LEVEL_BREAK_REVERSAL'
  setup: string; reason: string; entry: number; stopLoss: number; target: number; score: number
  confluence: string[]; invalidation: string; targetBasis: string
}

/** New opportunities require a completed price event and at least one directional route. */
export function findMomentumSetups(candles: AngelOneCandle[], averages: MovingAveragePoint[], indicators: TechnicalIndicatorPoint[], interval: PriceActionInterval, support?: number, resistance?: number, suppliedAlignment?: DirectionalAlignment): MomentumCandidate[] {
  const end = candles.length - 1, latest = candles[end], previous = candles[end - 1]
  const current = indicators[end], avg = averages[end], oldAvg = averages[end - 1]
  if (!latest || !previous || !current || !avg || !oldAvg || candles.length < 50) return []
  const atr = current.atr14, adx = current.adx14, rsi = current.rsi14
  if (!atr || adx === undefined || rsi === undefined || current.plusDi14 === undefined || current.minusDi14 === undefined || avg.ema20 === undefined || avg.ema50 === undefined || oldAvg.ema20 === undefined) return []
  const local = new Date(Date.parse(latest[0]) + 330 * 60_000)
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  if (minute < 555 || minute + candleIntervalMs(interval) / 60_000 >= 930) return []
  const session = candleSession(latest[0]), recent = candles.slice(-7)
  if (recent.some((bar, i) => candleSession(bar[0]) !== session || i > 0 && Date.parse(bar[0]) - Date.parse(recent[i - 1][0]) !== candleIntervalMs(interval))) return []
  const candleRange = latest[2] - latest[3], body = Math.abs(latest[4] - latest[1])
  // A gap/large spike or a tiny indecisive body is not a fresh momentum entry.
  if (candleRange <= 0 || candleRange > 2 * atr || body < .4 * candleRange || Math.abs(latest[4] - avg.ema20) > 1.8 * atr) return []
  const buffer = Math.max(.05 * atr, latest[4] * .00003), candidates: MomentumCandidate[] = []
  const alignment = suppliedAlignment ?? analyzeDirectionalAlignment(candles, averages, indicators, interval, { support, resistance })
  if (Date.parse(alignment.at ?? '') !== Date.parse(latest[0])) return []
  const sameSession = candles.filter(bar => candleSession(bar[0]) === session)
  const opening = sameSession.filter(bar => {
    const time = new Date(Date.parse(bar[0]) + 330 * 60_000), minute = time.getUTCHours() * 60 + time.getUTCMinutes()
    return minute >= 555 && minute < 570
  })
  const openingReady = interval !== 'ONE_HOUR' && opening.length === (interval === 'FIVE_MINUTE' ? 3 : 1)
    && new Date(Date.parse(opening[0][0]) + 330 * 60_000).toISOString().slice(11, 16) === '09:15'
    && opening.every((bar, i) => Date.parse(bar[0]) === Date.parse(opening[0][0]) + i * candleIntervalMs(interval))
    && Date.parse(latest[0]) >= Date.parse(opening[0][0]) + 900_000
  for (const d of [1, -1] as const) {
    const side = d === 1 ? 'CALL' : 'PUT'
    const routes = alignment.routes.filter(route => route.side === side)
    const priceConfirmed = d * (latest[4] - latest[1]) > 0 && (d === 1 ? (latest[4] - latest[3]) / candleRange : (latest[2] - latest[4]) / candleRange) >= .65
    if (!routes.length || !priceConfirmed) continue
    const add = (pattern: MomentumCandidate['pattern'], setup: string, level: number, score: number) => {
      const structuralStop = d === 1 ? Math.min(latest[3], previous[3], level) - buffer : Math.max(latest[2], previous[2], level) + buffer
      const stopLoss = d === 1 ? Math.min(structuralStop, latest[4] - atr) : Math.max(structuralStop, latest[4] + atr)
      const risk = Math.abs(latest[4] - stopLoss)
      const observedTarget = d === 1 ? resistance : support
      const target = observedTarget !== undefined && d * (observedTarget - latest[4]) > 0 ? observedTarget : latest[4] + d * 2 * risk
      candidates.push({ side, pattern, setup, reason: `${setup}: completed price confirmation with ${routes.map(route => route.name).join(' or ')}.`, entry: latest[4], stopLoss, target, score,
        confluence: ['Completed price confirmation', ...routes.map(route => route.name), `RSI(14) ${rsi.toFixed(1)} · ADX(14) ${adx.toFixed(1)} reference`],
        invalidation: `Loss of the ${setup.toLowerCase()} level invalidates the setup.`, targetBasis: observedTarget !== undefined && d * (observedTarget - latest[4]) > 0 ? 'Observed chart resistance/support' : '2R projection from ATR-aware invalidation; not an observed level' })
    }
    const prior = candles.slice(-4, -1)
    const breakLevel = d === 1 ? Math.max(...prior.map(bar => bar[2])) : Math.min(...prior.map(bar => bar[3]))
    if (d * (latest[4] - breakLevel) > buffer && d * (previous[4] - breakLevel) <= 0) add('TREND_MOMENTUM_BREAK', `${d === 1 ? 'Bullish' : 'Bearish'} trend momentum break`, breakLevel, 73)
    const touchedEma = d === 1 ? previous[3] <= oldAvg.ema20 + .2 * atr : previous[2] >= oldAvg.ema20 - .2 * atr
    const reclaimLevel = d === 1 ? previous[2] : previous[3]
    if (routes.some(route => route.family === 'EMA') && touchedEma && d * (latest[4] - reclaimLevel) > buffer) add('EMA_PULLBACK_RECLAIM', `EMA(20) pullback + ${d === 1 ? 'bullish' : 'bearish'} reclaim`, oldAvg.ema20, 79)
    for (const route of routes.filter(route => route.family === 'LEVEL' && route.level !== undefined)) {
      add('LEVEL_BREAK_REVERSAL', route.name, route.level!, 78)
    }
    if (openingReady) {
      const level = d === 1 ? Math.max(...opening.map(bar => bar[2])) : Math.min(...opening.map(bar => bar[3]))
      if (d * (latest[4] - level) > buffer && d * (previous[4] - level) <= 0) add('OPENING_RANGE_BREAKOUT', `15-minute opening range ${d === 1 ? 'breakout' : 'breakdown'}`, level, 82)
    }
  }
  return candidates
}
