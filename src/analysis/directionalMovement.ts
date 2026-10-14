/** Wilder DMI(14) and ADX(14), seeded from actual consecutive price changes. */
export function calculateDirectionalMovement(highs: number[], lows: number[], closes: number[], period = 14) {
  const length = Math.min(highs.length, lows.length, closes.length)
  const result: Array<{ adx14?: number; plusDi14?: number; minusDi14?: number }> = Array.from({ length }, () => ({}))
  if (!Number.isInteger(period) || period < 1) return result
  let count = 0, tr = 0, positive = 0, negative = 0, dxCount = 0, dxSum = 0, adx: number | undefined
  const valid = (i: number) => i >= 0 && [highs[i], lows[i], closes[i]].every(Number.isFinite) && highs[i] >= lows[i] && closes[i] >= lows[i] && closes[i] <= highs[i]
  for (let i = 1; i < length; i++) {
    if (!valid(i) || !valid(i - 1)) { count = 0; tr = 0; positive = 0; negative = 0; dxCount = 0; dxSum = 0; adx = undefined; continue }
    const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i]
    const p = up > down && up > 0 ? up : 0, n = down > up && down > 0 ? down : 0
    const range = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]))
    if (count < period) { tr += range; positive += p; negative += n; count++ }
    else { tr = tr - tr / period + range; positive = positive - positive / period + p; negative = negative - negative / period + n }
    if (count < period) continue
    const plusDi14 = tr ? 100 * positive / tr : 0, minusDi14 = tr ? 100 * negative / tr : 0
    const dx = plusDi14 + minusDi14 ? 100 * Math.abs(plusDi14 - minusDi14) / (plusDi14 + minusDi14) : 0
    if (adx === undefined) { dxSum += dx; dxCount++; if (dxCount === period) adx = dxSum / period }
    else adx = (adx * (period - 1) + dx) / period
    result[i] = { adx14: adx, plusDi14, minusDi14 }
  }
  return result
}
