import type { AngelOneCandle } from '../api/angelOne'

/** Chart-only direction guide. It is neither a support/resistance fit nor entry
 * confirmation. Caller supplies one uninterrupted completed-candle section. */
export function recentChartTrend(bars: AngelOneCandle[], candles: AngelOneCandle[], tick: number) {
  const indices = new Map(candles.map((bar, i) => [Date.parse(bar[0]), i]))
  const recent = bars.slice(-12)
  const points = [] as Array<{ x: number; y: number; marker: { size: number; fillColor: string; strokeColor: string; strokeWidth: number }; label: { text: string; offsetY: number; borderColor: string; style: { background: string; color: string; fontSize: string } } }>
  // The last two completed bars cannot yet be confirmed pivots. Show candidates
  // separately, and invalidate them as soon as an observed neighbour exceeds them.
  for (let i = Math.max(2, bars.length - 2); i < bars.length; i++) {
    const neighbours = [...bars.slice(i - 2, i), ...bars.slice(i + 1)]
    const x = indices.get(Date.parse(bars[i][0]))
    if (x === undefined) continue
    for (const kind of ['HIGH', 'LOW'] as const) {
      const column = kind === 'HIGH' ? 2 : 3, y = bars[i][column]
      if (!neighbours.every(b => kind === 'HIGH' ? y > b[column] : y < b[column])) continue
      points.push({ x, y, marker: { size: 4, fillColor: '#fff', strokeColor: '#2563EB', strokeWidth: 1.5 },
        label: { text: kind === 'HIGH' ? 'H?' : 'L?', offsetY: kind === 'HIGH' ? -12 : 20, borderColor: 'transparent', style: { background: 'transparent', color: '#1D4ED8', fontSize: '9px' } } })
    }
  }
  if (recent.length < 2) return { line: undefined, points, direction: 'WAITING' as const, bars: recent.length }
  const meanX = (recent.length - 1) / 2, meanY = recent.reduce((sum, b) => sum + b[4], 0) / recent.length
  let numerator = 0, denominator = 0
  recent.forEach((bar, i) => { numerator += (i - meanX) * (bar[4] - meanY); denominator += (i - meanX) ** 2 })
  const slope = numerator / denominator, movement = slope * (recent.length - 1)
  const direction = Math.abs(movement) <= tick ? 'FLAT' as const : slope > 0 ? 'UP' as const : 'DOWN' as const
  const data = recent.flatMap((bar, i) => {
    const x = indices.get(Date.parse(bar[0])), y = meanY + (i - meanX) * slope
    return x === undefined || y <= 0 ? [] : [{ x, y }]
  })
  return { line: { name: `Recent price trend · ${recent.length} closed bars`, type: 'line' as const, validated: false, color: '#2563EB', data }, points, direction, bars: recent.length }
}
