import type { TechnicalIndicatorPoint } from './technicalIndicators'

export function buildSupertrendSegments(points: TechnicalIndicatorPoint[]) {
  const segments: Array<{ direction: 'UP' | 'DOWN'; data: Array<{ x: number; y: number }> }> = []
  let active: typeof segments[number] | undefined
  points.forEach((point, x) => {
    if (point.supertrend10 === undefined || point.supertrendDirection === undefined) {
      active = undefined
      return
    }
    if (active?.direction === point.supertrendDirection) {
      active.data.push({ x, y: point.supertrend10 })
      return
    }
    active = { direction: point.supertrendDirection, data: [] }
    // Start the new color at the previous segment's endpoint so a flip has no gap.
    const previous = points[x - 1]
    if (previous?.supertrend10 !== undefined) active.data.push({ x: x - 1, y: previous.supertrend10 })
    active.data.push({ x, y: point.supertrend10 })
    segments.push(active)
  })
  return segments
}
