import { indicatorSwingEvidence } from './indicatorSwingStructure'
import type { AngelOneCandle } from '../api/angelOne'
import type { MovingAveragePoint } from './movingAverages'
import type { TechnicalIndicatorPoint } from './technicalIndicators'
import type { PriceActionInterval } from './priceAction'
import { candleIntervalMs } from './candleData'
import { candleSession } from './vwap'

export type AlignmentRoute = { family: 'EMA' | 'SUPERTREND' | 'LEVEL'; side: 'CALL' | 'PUT'; name: string; level?: number }
export type DirectionalAlignment = { at?: string; routes: AlignmentRoute[]; bullish: string[]; bearish: string[] }
export type AlignmentLevels = { support?: number; resistance?: number; priorSupport?: number; priorResistance?: number }

/** OR between directional routes; never a replacement for a completed price setup. */
export function analyzeDirectionalAlignment(candles: AngelOneCandle[], averages: MovingAveragePoint[], indicators: TechnicalIndicatorPoint[], interval: PriceActionInterval, levels: AlignmentLevels = {}): DirectionalAlignment {
  const end = candles.length - 1, current = candles[end], previous = candles[end - 1]
  const avg = averages[end], old = averages[end - 1], point = indicators[end], prior = indicators[end - 1]
  const result: DirectionalAlignment = { at: current?.[0], routes: [], bullish: [], bearish: [] }
  if (!current || !previous || !avg || !old || !point || !prior || !Number.isFinite(point.atr14) || (point.atr14 ?? 0) <= 0) return result
  const sameBars = (length: number) => end >= length && candles.slice(end - length).every((bar, offset, list) => candleSession(bar[0]) === candleSession(current[0]) && (offset === 0 || Date.parse(bar[0]) - Date.parse(list[offset - 1][0]) === candleIntervalMs(interval)))
  if (!sameBars(1)) return result
  const atr = point.atr14!, noise = .03 * atr, buffer = Math.max(.05 * atr, current[4] * .00003)
  const add = (family: AlignmentRoute['family'], side: AlignmentRoute['side'], name: string, level?: number) => result.routes.push({ family, side, name, ...(level === undefined ? {} : { level }) })
  const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value)
  const swings = indicatorSwingEvidence(candles, averages, indicators, candleIntervalMs(interval))
  for (const d of [1, -1] as const) {
    const side = d === 1 ? 'CALL' : 'PUT', direction = d === 1 ? 'up' : 'down'
    if ([avg.ema20, avg.ema50, old.ema20, old.ema50].every(finite)) {
      const before = old.ema20! - old.ema50!, after = avg.ema20! - avg.ema50!
      if (d * before <= 0 && d * after > noise && d * (current[4] - avg.ema20!) > 0) add('EMA', side, `EMA20/50 crossed ${direction}`)
      const older = averages[end - 3]
      if (sameBars(3) && older && finite(older.ema20) && finite(older.ema50)) {
        const fast = avg.ema20! - older.ema20, slow = avg.ema50! - older.ema50
        if (d * fast > noise && d * slow >= -noise && d * (current[4] - avg.ema20!) >= -.25 * atr) add('EMA', side, `EMA20/50 trajectory ${direction}`)
      }
    }
    const turnStart = averages[end - 6], turnMiddle = averages[end - 3]
    if (sameBars(6) && finite(turnStart?.ema20) && finite(turnMiddle?.ema20) && finite(avg.ema20) && finite(point.rsi14) && finite(prior.rsi14)) {
      const before = turnMiddle.ema20 - turnStart.ema20, after = avg.ema20 - turnMiddle.ema20
      const priceBreak = d === 1 ? previous[2] : previous[3]
      // A fast turn needs completed price and RSI confirmation while EMA50 can still lag.
      if (d * before < -noise && d * after > noise && d * (current[4] - avg.ema20) > buffer && d * (current[4] - current[1]) > buffer && d * (current[4] - priceBreak) > buffer && d * (point.rsi14 - prior.rsi14) > 0) {
        add('EMA', side, `EMA20 turned ${direction} with price break and RSI momentum`)
      }
    }
    const reversalDirection = d === 1 ? 'UP' : 'DOWN'
    const matchingSwings = swings.filter(item => item.structure.breakDirection === reversalDirection && item.change !== undefined && item.change * d > 0)
    const emaBreak = matchingSwings.some(item => item.name === 'EMA20' || item.name === 'EMA50')
    const momentumBreak = matchingSwings.some(item => item.name === 'RSI' || item.name === 'Supertrend cushion')
    const freshBreak = matchingSwings.some(item => item.structure.newBreak)
    const priceBreak = d === 1 ? previous[2] : previous[3]
    if (sameBars(6) && emaBreak && momentumBreak && freshBreak && finite(avg.ema20) && finite(point.rsi14) && finite(prior.rsi14)
      && d * (current[4] - priceBreak) > buffer && d * (current[4] - current[1]) > buffer && d * (current[4] - avg.ema20) > buffer && d * (point.rsi14 - prior.rsi14) > 0) {
      add('EMA', side, `Indicator swing reversal ${direction}: ${matchingSwings.map(item => item.name).join(' + ')} with completed price break`)
    }
    const trendDirection = d === 1 ? 'UP' : 'DOWN'
    if (point.supertrendDirection === trendDirection && finite(point.supertrend10) && d * (current[4] - point.supertrend10) > 0) {
      if (prior.supertrendDirection && prior.supertrendDirection !== point.supertrendDirection) add('SUPERTREND', side, `Supertrend flipped ${direction}`, point.supertrend10)
      const older = indicators[end - 3]
      if (sameBars(3) && older?.supertrendDirection === trendDirection && finite(older.supertrend10) && d * (point.supertrend10 - older.supertrend10) > noise) add('SUPERTREND', side, `Supertrend trajectory ${direction}`, point.supertrend10)
    }
    // A Supertrend band can stay flat during an intact trend. A new local
    // price break and directional RSI can confirm continuation without a new flip.
    if (sameBars(3) && finite(point.rsi14) && d * (point.rsi14 - 50) >= 0
      && d * (current[4] - current[1]) > buffer && d * (current[4] - (d === 1 ? previous[2] : previous[3])) > buffer
      && d * (current[4] - candles[end - 3][4]) >= .15 * atr
      && indicators.slice(end - 3).every((p, i) => p.supertrendDirection === trendDirection && finite(p.supertrend10) && d * (candles[end - 3 + i][4] - p.supertrend10) > 0)
      && !result.routes.some(route => route.family === 'SUPERTREND' && route.side === side)) {
      add('SUPERTREND', side, `Supertrend held ${direction} with a fresh local price break`, point.supertrend10)
    }
    const breakLevel = d === 1 ? levels.priorResistance : levels.priorSupport
    if (finite(breakLevel) && d * (previous[4] - breakLevel) <= 0 && d * (current[4] - breakLevel) > buffer) add('LEVEL', side, d === 1 ? 'Resistance crossed upward' : 'Support crossed downward', breakLevel)
    const reaction = d === 1 ? levels.priorSupport ?? levels.support : levels.priorResistance ?? levels.resistance
    const range = current[2] - current[3]
    const touch = finite(reaction) && (d === 1 ? Math.min(current[3], previous[3]) <= reaction + .25 * atr : Math.max(current[2], previous[2]) >= reaction - .25 * atr)
    const closePosition = range > 0 ? d === 1 ? (current[4] - current[3]) / range : (current[2] - current[4]) / range : .5
    if (finite(reaction) && touch && Math.abs(current[4] - reaction) <= 1.5 * atr && d * (current[4] - reaction) > buffer && d * (current[4] - previous[4]) > buffer && closePosition >= .55) add('LEVEL', side, d === 1 ? 'Support reversal upward' : 'Resistance reversal downward', reaction)
  }
  result.bullish = result.routes.filter(route => route.side === 'CALL').map(route => route.name)
  result.bearish = result.routes.filter(route => route.side === 'PUT').map(route => route.name)
  return result
}
