import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionInterval } from './priceAction'
import { completedCandles, candleBucketTime } from './candleData'
import { calculateMovingAverageSeries } from './movingAverages'
import { calculateSessionVwap } from './vwap'
import { analyzeIndicatorTrajectory } from './indicatorTrajectory'

function calculate(candles: AngelOneCandle[], interval: PriceActionInterval, now: number) {
  const closed = completedCandles(candles, interval, now)
  return {
    closed,
    averages: calculateMovingAverageSeries(closed.map(candle => candle[4])),
    trajectory: analyzeIndicatorTrajectory(closed, interval, now),
    vwap: calculateSessionVwap(closed),
  }
}

// The candle book uses immutable snapshots. Weak keys release unused histories automatically.
const cache = new WeakMap<AngelOneCandle[], { interval: PriceActionInterval; boundary: number; inputs: ReturnType<typeof calculate> }>()
export function cachedCandleIndicators(candles: AngelOneCandle[], interval: PriceActionInterval, now: number) {
  const boundary = candleBucketTime(now, interval)
  const cached = cache.get(candles)
  if (cached?.interval === interval && cached.boundary === boundary) return cached.inputs
  const inputs = calculate(candles, interval, now)
  cache.set(candles, { interval, boundary, inputs })
  return inputs
}
