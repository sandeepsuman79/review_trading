export type SwingTrajectory = {
  trend: 'UPTREND' | 'DOWNTREND' | 'MIXED' | 'WARMING_UP'
  pattern: string; breakDirection?: 'UP' | 'DOWN'; newBreak: boolean
  high?: number; low?: number
}
/** A pivot needs a completed bar to its right. Break levels exclude pivots
 * that become known only on the bar being evaluated; no future bars are read. */
export function analyzeSwingTrajectory(points: Array<{ at: number; value?: number }>, intervalMs: number, noise = 0): SwingTrajectory {
  const tail: Array<{ at: number; value: number }> = []
  for (let i = points.length - 1; i >= 0 && tail.length < 32; i--) {
    const p = points[i], next = points[i + 1]
    if (!Number.isFinite(p.at) || p.value === undefined || !Number.isFinite(p.value) || next && (next.at - p.at !== intervalMs || Math.floor((next.at + 19800000) / 86400000) !== Math.floor((p.at + 19800000) / 86400000))) break
    tail.unshift({ at: p.at, value: p.value })
  }
  const base: SwingTrajectory = { trend: 'WARMING_UP', pattern: 'Waiting for confirmed swings', newBreak: false }
  if (tail.length < 6) return base
  const highs: number[] = [], lows: number[] = [], end = tail.length - 1
  for (let i = 1; i <= end - 2; i++) {
    const left = tail[i - 1].value, v = tail[i].value, right = tail[i + 1].value
    if (v - left > noise && v - right > noise) highs.push(v)
    if (left - v > noise && right - v > noise) lows.push(v)
  }
  if (highs.length < 2 || lows.length < 2) return base
  const high = highs[highs.length - 1], priorHigh = highs[highs.length - 2], low = lows[lows.length - 1], priorLow = lows[lows.length - 2]
  const hh = high > priorHigh + noise, lh = high < priorHigh - noise, hl = low > priorLow + noise, ll = low < priorLow - noise
  const trend = hh && hl ? 'UPTREND' : lh && ll ? 'DOWNTREND' : 'MIXED'
  const current = tail[end].value, previous = tail[end - 1].value
  const breakDirection = trend === 'UPTREND' && current < low - noise ? 'DOWN' : trend === 'DOWNTREND' && current > high + noise ? 'UP' : undefined
  const newBreak = breakDirection === 'DOWN' ? previous >= low - noise : breakDirection === 'UP' ? previous <= high + noise : false
  return { trend, pattern: `${hh ? 'HH' : lh ? 'LH' : 'Equal high'} / ${hl ? 'HL' : ll ? 'LL' : 'Equal low'}`, high, low, ...(breakDirection ? { breakDirection } : {}), newBreak }
}
