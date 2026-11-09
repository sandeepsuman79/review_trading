import type { AngelOneCandle } from '../api/angelOne'

export type WickExtreme = { index: number; side: 'HIGH' | 'LOW'; value: number }
/** Display only: keep every open/close and the current quote. Isolated distant
 * wick tips can sit outside focused view; original OHLC and agent inputs stay intact. */
export function candlePriceBounds(candles: AngelOneCandle[], tick: number, focus: boolean, livePrice?: number) {
  if (!candles.length) return { low: 0, high: 2 * tick, extremes: [] as WickExtreme[] }
  const bodyLow = Math.min(...candles.map(b => Math.min(b[1], b[4])))
  const bodyHigh = Math.max(...candles.map(b => Math.max(b[1], b[4])))
  const ranges = candles.map(b => b[2] - b[3]).sort((a, b) => a - b)
  const typicalRange = ranges[Math.floor(ranges.length / 2)]
  const allowance = Math.max(6 * typicalRange, (bodyHigh - bodyLow) * .25, 2 * tick)
  const values = candles.flatMap(b => [b[1], b[4]]), candidates: WickExtreme[] = []
  candles.forEach((bar, index) => {
    for (const side of ['HIGH', 'LOW'] as const) {
      const value = bar[side === 'HIGH' ? 2 : 3]
      const outside = side === 'HIGH' ? value > bodyHigh + allowance : value < bodyLow - allowance
      if (focus && candles.length >= 12 && outside) candidates.push({ index, side, value })
      else values.push(value)
    }
  })
  // Focus only isolated tips, not a repeatedly traded volatility range.
  const retained = candidates.filter(p => candidates.filter(other => other.side === p.side).length <= Math.max(1, Math.floor(candles.length * .1)))
  for (const p of candidates) if (!retained.includes(p)) values.push(p.value)
  if (livePrice !== undefined && Number.isFinite(livePrice) && livePrice > 0) values.push(livePrice)
  const low = Math.min(...values), high = Math.max(...values)
  return { low, high, extremes: retained.filter(p => p.value < low || p.value > high) }
}
