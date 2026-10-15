import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import type { PriceActionInterval } from './priceAction'
import { applyLiveTick, candleBucketTime, normalizeCandles, tickTimestamp } from './candleData'
import { candleIntervals } from './timeframes'

const intervals = candleIntervals
type Snapshot = { token: string; interval: PriceActionInterval; candles: AngelOneCandle[] }

/** Consume every exchange tick synchronously, independently of React's render batching. */
export class LiveCandleBook {
  private snapshots = new Map<string, Snapshot>()
  private lastTicks = new Map<string, AngelOneStreamTick>()
  private observedAt = new Map<string, Map<number, number>>()
  private dirty = new Set<string>()

  constructor(private load: (token: string, interval: PriceActionInterval) => AngelOneCandle[]) {}

  get(token: string, interval: PriceActionInterval) {
    const key = `${token}:${interval}`
    if (!this.snapshots.has(key)) this.snapshots.set(key, { token, interval, candles: normalizeCandles(this.load(token, interval)) })
    return this.snapshots.get(key)!.candles
  }

  accept(tick: AngelOneStreamTick, now = Date.now()) {
    const time = tickTimestamp(tick)
    if (!tick.token || !Number.isFinite(tick.ltp) || tick.ltp! <= 0 || !Number.isFinite(time) || time <= 0 || time > now + 5_000 || !Number.isFinite(new Date(time).getTime())) return false
    const previous = this.lastTicks.get(tick.token)
    if (previous && (time < tickTimestamp(previous) || time === tickTimestamp(previous) && tick.sequence! > 0 && previous.sequence! > 0 && tick.sequence! <= previous.sequence!)) return false
    this.lastTicks.set(tick.token, tick)
    for (const interval of intervals) {
      const key = `${tick.token}:${interval}`
      const candles = this.get(tick.token, interval)
      const updated = applyLiveTick(candles, tick, interval)
      const times = this.observedAt.get(key) || new Map<number, number>()
      times.set(candleBucketTime(time, interval), time)
      this.observedAt.set(key, times)
      if (updated === candles) continue
      this.snapshots.set(key, { token: tick.token, interval, candles: updated })
      this.dirty.add(key)
    }
    return true
  }

  mergeHistory(token: string, interval: PriceActionInterval, incoming: AngelOneCandle[], requestedAt: number) {
    const key = `${token}:${interval}`
    const existing = this.get(token, interval)
    const byTime = new Map(existing.map(candle => [Date.parse(candle[0]), candle]))
    for (const candle of normalizeCandles(incoming)) {
      const time = Date.parse(candle[0])
      const observed = byTime.get(time)
      const receivedAt = this.observedAt.get(key)?.get(candleBucketTime(time, interval))
      // A response requested before these ticks cannot replace their high, low or latest close.
      byTime.set(time, observed && receivedAt !== undefined && receivedAt >= requestedAt
        ? [candle[0], candle[1], Math.max(candle[2], observed[2]), Math.min(candle[3], observed[3]), observed[4], candle[5]]
        : candle)
    }
    const merged = normalizeCandles([...byTime.values()])
    this.snapshots.set(key, { token, interval, candles: merged })
    this.dirty.add(key)
    return merged
  }

  flush(save: (token: string, interval: PriceActionInterval, candles: AngelOneCandle[]) => void, limit = Infinity) {
    let saved = 0
    for (const key of this.dirty) {
      if (saved >= limit) break
      const snapshot = this.snapshots.get(key)!
      save(snapshot.token, snapshot.interval, snapshot.candles)
      this.dirty.delete(key)
      saved++
    }
    return this.dirty.size
  }
}
