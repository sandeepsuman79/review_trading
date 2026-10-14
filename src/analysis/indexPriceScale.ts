export type ScaleView = 'CE' | 'INDEX' | 'PE'
export const scaleViews: ScaleView[] = ['CE', 'INDEX', 'PE']
export const indexPriceStep = (name: string) => name === 'Nifty 50' ? 50 : 100
/** Fixed multiples within the visible domain; do not expand the candle range. */
export function indexPriceLevels(min: number, max: number, name: string) {
  if (![min, max].every(Number.isFinite) || max <= min) return []
  const step = indexPriceStep(name), first = Math.ceil(min / step) * step, last = Math.floor(max / step) * step
  const count = Math.max(0, Math.floor((last - first) / step) + 1)
  if (count > 200) return [] // Avoid rendering thousands of nodes on an extreme saved range.
  return Array.from({ length: count }, (_, index) => last - index * step)
}
export const priceScalePosition = (value: number, min: number, max: number, height: number) => (max - value) / (max - min) * height

/** If the tight candle domain contains no strike, expose the nearest actual level. */
export function indexPriceDomain(min: number, max: number, name: string) {
  const step = indexPriceStep(name)
  if (![min,max].every(Number.isFinite) || max <= min || Math.ceil(min / step) * step <= max) return { min, max }
  const nearest = Math.round((min + max) / 2 / step) * step
  return { min: Math.min(min, nearest - step * .15), max: Math.max(max, nearest + step * .15) }
}
