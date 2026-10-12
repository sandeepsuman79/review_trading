import type { AngelOneCandle } from '../api/angelOne'

export function candleSession(timestamp: string) {
  const time = Date.parse(timestamp)
  const date = new Date(time + 330 * 60_000)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''
}

/** Session VWAP = sum(HLC3 × actual candle volume) / sum(volume), resetting by IST date. */
export function calculateSessionVwap(candles: AngelOneCandle[]): Array<number | undefined> {
  let session = '', volume = 0, weightedAverage = 0
  return candles.map(candle => {
    const date = candleSession(candle[0])
    if (!date) return undefined
    if (date !== session) { session = date; volume = 0; weightedAverage = 0 }
    const [, open, high, low, close, quantity] = candle
    if (![open, high, low, close, quantity].every(Number.isFinite) || quantity < 0 || high < low || low > Math.min(open, close) || high < Math.max(open, close)) return undefined
    if (quantity > 0) {
      const total = volume + quantity
      const typical = high / 3 + low / 3 + close / 3
      if (!Number.isFinite(total) || !Number.isFinite(typical)) return undefined
      // Incremental weighted mean avoids overflowing price × cumulative volume.
      weightedAverage += (typical - weightedAverage) * (quantity / total)
      volume = total
    }
    return volume > 0 ? weightedAverage : undefined
  })
}

/** Separate session paths prevent a line joining yesterday's VWAP to today's reset. */
export function buildSessionVwapSeries(candles: AngelOneCandle[], values: Array<number | undefined>) {
  const sessions = new Map<string, { x: number; y: number | null }[]>()
  candles.forEach((candle, x) => {
    const date = candleSession(candle[0])
    if (!date) return
    if (!sessions.has(date)) sessions.set(date, [])
    sessions.get(date)!.push({ x, y: values[x] ?? null })
  })
  return [...sessions.values()].filter(data => data.some(point => point.y !== null)).map(data => ({ name: 'VWAP', type: 'line', data }))
}
