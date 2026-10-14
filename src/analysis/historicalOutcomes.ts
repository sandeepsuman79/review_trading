import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionInterval } from './priceAction'
import { candleIntervalMs, completedCandles, candleBucketTime } from './candleData'
import { calculateMovingAverageSeries } from './movingAverages'
import { calculateTechnicalIndicatorSeries } from './technicalIndicators'
import { candleSession } from './vwap'

export type HistoricalOutcomes = {
  status: 'READY' | 'INSUFFICIENT'; samples: number; sessions: number; horizonBars: number; thresholdAtr: number
  asOf?: string; up: number; down: number; flat: number; bias: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNAVAILABLE'
  upPercent?: number; downPercent?: number; flatPercent?: number
  upInterval?: [number, number]; downInterval?: [number, number]; message: string
}
export function wilsonInterval(successes: number, samples: number): [number, number] | undefined {
  if (!Number.isInteger(samples) || samples <= 0 || !Number.isInteger(successes) || successes < 0 || successes > samples) return undefined
  const z = 1.959963984540054, p = successes / samples, denominator = 1 + z * z / samples
  const center = (p + z * z / (2 * samples)) / denominator
  const margin = z * Math.sqrt(p * (1 - p) / samples + z * z / (4 * samples * samples)) / denominator
  return [Math.max(0, center - margin) * 100, Math.min(1, center + margin) * 100]
}

/** Past analogues are outcome frequencies, not calibrated live trade probabilities. */
export function analyzeHistoricalOutcomes(input: AngelOneCandle[], interval: PriceActionInterval, now: number): HistoricalOutcomes {
  const candles = completedCandles(input, interval, now), end = candles.length - 1, horizonBars = 3, thresholdAtr = .5
  const base: HistoricalOutcomes = { status: 'INSUFFICIENT', samples: 0, sessions: 0, horizonBars, thresholdAtr, asOf: candles[end]?.[0], up: 0, down: 0, flat: 0, bias: 'UNAVAILABLE', message: 'Need at least 30 similar non-overlapping cases across 3 saved sessions.' }
  if (candles.length < 60) return base
  const averages = calculateMovingAverageSeries(candles.map(bar => bar[4]))
  const indicators = calculateTechnicalIndicatorSeries(candles.map(bar => bar[2]), candles.map(bar => bar[3]), candles.map(bar => bar[4]))
  const features = (i: number) => {
    const bar = candles[i], avg = averages[i], point = indicators[i], prior = averages[i - 3]
    if (!bar || !prior || avg.ema20 === undefined || avg.ema50 === undefined || prior.ema20 === undefined || point.rsi14 === undefined || point.adx14 === undefined || !point.atr14 || !point.supertrendDirection) return undefined
    const range = bar[2] - bar[3], body = Math.abs(bar[4] - bar[1]), atr = point.atr14
    const shape = range === 0 || body / range <= .2 ? 0 : bar[4] > bar[1] ? 1 : -1
    const trend = Math.abs(avg.ema20 - avg.ema50) < .03 * atr ? 0 : Math.sign(avg.ema20 - avg.ema50)
    const slope = Math.abs(avg.ema20 - prior.ema20) < .05 * atr ? 0 : Math.sign(avg.ema20 - prior.ema20)
    const distance = (bar[4] - avg.ema20) / atr
    const price = Math.abs(distance) <= .25 ? 0 : Math.sign(distance)
    const rsi = Math.floor(point.rsi14 / 10), strength = point.adx14 < 20 ? 0 : point.adx14 < 25 ? 1 : 2
    return { trend, slope, shape, price, rsi, strength, supertrend: point.supertrendDirection, volatility: atr / bar[4], atr }
  }
  const reference = features(end)
  if (!reference) return base
  const sessionSet = new Set<string>()
  let lastSelected = Infinity
  // Leave a three-bar embargo before the current reference; outcome windows never overlap.
  for (let i = end - 2 * horizonBars; i >= 52; i--) {
    if (i + horizonBars >= lastSelected) continue
    const feature = features(i)
    if (!feature || feature.trend !== reference.trend || feature.slope !== reference.slope || feature.shape !== reference.shape || feature.price !== reference.price || feature.strength !== reference.strength || feature.supertrend !== reference.supertrend || Math.abs(feature.rsi - reference.rsi) > 1 || feature.volatility / reference.volatility < .67 || feature.volatility / reference.volatility > 1.5) continue
    const date = candleSession(candles[i][0]), window = candles.slice(i, i + horizonBars + 1)
    if (window.some((bar, offset) => candleSession(bar[0]) !== date || offset > 0 && Date.parse(bar[0]) - Date.parse(window[offset - 1][0]) !== candleIntervalMs(interval))) continue
    const local = new Date(Date.parse(candles[i][0]) + 330 * 60_000), minute = local.getUTCHours() * 60 + local.getUTCMinutes()
    if (minute < 555 || minute + (horizonBars + 1) * candleIntervalMs(interval) / 60_000 > 930) continue
    const movement = candles[i + horizonBars][4] - candles[i][4]
    if (movement > thresholdAtr * feature.atr) base.up++
    else if (movement < -thresholdAtr * feature.atr) base.down++
    else base.flat++
    lastSelected = i; sessionSet.add(date); base.samples++
  }
  base.sessions = sessionSet.size
  if (base.samples < 30 || base.sessions < 3) { base.message = `${base.samples} similar cases across ${base.sessions} sessions. Need 30 cases and 3 sessions before showing estimates.`; return base }
  const upPercent = base.up / base.samples * 100, downPercent = base.down / base.samples * 100
  const upInterval = wilsonInterval(base.up, base.samples)!, downInterval = wilsonInterval(base.down, base.samples)!
  return { ...base, status: 'READY', upPercent, downPercent, flatPercent: base.flat / base.samples * 100, upInterval, downInterval,
    bias: upPercent >= 60 && upInterval[0] > 50 ? 'BULLISH' : downPercent >= 60 && downInterval[0] > 50 ? 'BEARISH' : 'MIXED',
    message: `Observed next-${horizonBars}-candle outcomes for similar candle shape, EMA trend/slope, Supertrend, RSI, ADX and volatility. A move requires more than ${thresholdAtr} ATR at the historical reference.` }
}

const memory = new WeakMap<AngelOneCandle[], { interval: PriceActionInterval; boundary: number; result: HistoricalOutcomes }>()
export function cachedHistoricalOutcomes(candles: AngelOneCandle[], interval: PriceActionInterval, now: number) {
  const boundary = candleBucketTime(now, interval), saved = memory.get(candles)
  if (saved?.interval === interval && saved.boundary === boundary) return saved.result
  const result = analyzeHistoricalOutcomes(candles, interval, now)
  memory.set(candles, { interval, boundary, result })
  return result
}
