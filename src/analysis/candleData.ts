import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import type { PriceActionInterval } from './priceAction'
import { timeframeInfo } from './timeframes'

export function candleIntervalMs(interval: PriceActionInterval) {
  return timeframeInfo[interval].milliseconds
}

/** SmartAPI limits each historical request to 100 / 200 / 400 calendar days. */
export function historicalCandleRequestStart(candles: AngelOneCandle[], interval: PriceActionInterval, now: number) {
  const days = timeframeInfo[interval].requestDays + 1
  const earliest = now - days * 86_400_000
  const history = normalizeCandles(candles)
  // A few live-only bars must not prevent loading the history needed for indicators.
  if (history.length < 60) return earliest
  const ist = new Date(now + 330 * 60_000)
  const sessionStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 3, 30)
  const latest = Date.parse(history[history.length - 1][0])
  return Math.max(earliest, Math.min(sessionStart, latest - candleIntervalMs(interval)))
}

/** One ordered, validated candle per exchange timestamp. Last correction wins. */
export function normalizeCandles(candles: AngelOneCandle[]): AngelOneCandle[] {
  const byTime = new Map<number, AngelOneCandle>()
  for (const candle of candles) {
    if (!Array.isArray(candle) || candle.length < 6 || typeof candle[0] !== 'string') continue
    const time = new Date(candle[0]).getTime()
    const [, open, high, low, close, volume] = candle
    if (!Number.isFinite(time) || ![open, high, low, close, volume].every(Number.isFinite)) continue
    if (low > Math.min(open, close) || high < Math.max(open, close) || high < low || volume < 0) continue
    byTime.set(time, candle)
  }
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([, candle]) => candle)
}

export function completedCandles(candles: AngelOneCandle[], interval: PriceActionInterval, now: number) {
  return normalizeCandles(candles).filter((candle) => new Date(candle[0]).getTime() + candleIntervalMs(interval) <= now)
}

export function tickTimestamp(tick: AngelOneStreamTick) {
  return tick.timestamp < 1_000_000_000_000 ? tick.timestamp * 1000 : tick.timestamp
}

export function isFreshTick(tick: AngelOneStreamTick | undefined, now: number) {
  if (!tick || !Number.isFinite(tick.ltp) || tick.ltp! <= 0) return false
  const age = now - tickTimestamp(tick)
  return Number.isFinite(age) && age >= -5_000 && age <= 60_000
}

export function candleBucketTime(timestamp: number, interval: PriceActionInterval) {
  const intervalMs = candleIntervalMs(interval)
  const alignment = interval === 'ONE_HOUR' ? 45 * 60_000 : 0
  return Math.floor((timestamp - alignment) / intervalMs) * intervalMs + alignment
}

/** Never advance an old tick into a candle for the current wall-clock time. */
export function applyLiveTick(candles: AngelOneCandle[], tick: AngelOneStreamTick | undefined, interval: PriceActionInterval) {
  if (!tick || !Number.isFinite(tick.ltp) || tick.ltp! <= 0 || !Number.isFinite(tickTimestamp(tick)) || tickTimestamp(tick) <= 0 || !Number.isFinite(new Date(tickTimestamp(tick)).getTime())) return candles
  const price = tick.ltp!
  const bucket = candleBucketTime(tickTimestamp(tick), interval)
  const last = candles[candles.length - 1]
  const lastBucket = last ? candleBucketTime(new Date(last[0]).getTime(), interval) : -Infinity
  if (bucket < lastBucket) return candles
  // Stream volume is session cumulative; it is not the volume of this interval.
  if (last && bucket === lastBucket) {
    if (price === last[4] && price <= last[2] && price >= last[3]) return candles
    return [...candles.slice(0, -1), [last[0], last[1], Math.max(last[2], price), Math.min(last[3], price), price, last[5]] as AngelOneCandle]
  }
  return [...candles, [new Date(bucket).toISOString(), price, price, price, price, 0] as AngelOneCandle]
}
