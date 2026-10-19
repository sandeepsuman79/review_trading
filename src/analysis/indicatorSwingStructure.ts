import type { AngelOneCandle } from '../api/angelOne'
import type { MovingAveragePoint } from './movingAverages'
import type { TechnicalIndicatorPoint } from './technicalIndicators'
import { analyzeSwingTrajectory } from './swingTrajectory'

export function indicatorSwingEvidence(candles: AngelOneCandle[], averages: MovingAveragePoint[], indicators: TechnicalIndicatorPoint[], intervalMs: number) {
  const end = candles.length - 1, atr = indicators[end]?.atr14
  const specs = [
    { name: 'EMA20', values: averages.map(p => p.ema20), noise: (atr ?? 0) * .03 },
    { name: 'EMA50', values: averages.map(p => p.ema50), noise: (atr ?? 0) * .03 },
    { name: 'RSI', values: indicators.map(p => p.rsi14), noise: 1 },
    { name: 'Supertrend cushion', values: indicators.map((p,i) => p.supertrend10 === undefined ? undefined : candles[i][4] - p.supertrend10), noise: (atr ?? 0) * .03 },
  ]
  return specs.map(spec => {
    const points = candles.slice(-32).map((bar, i) => ({ at: Date.parse(bar[0]), value: spec.values[candles.length - Math.min(32, candles.length) + i] }))
    const previous = spec.values[end - 1], current = spec.values[end]
    return { name: spec.name, structure: analyzeSwingTrajectory(points, intervalMs, spec.noise), change: previous !== undefined && current !== undefined ? current - previous : undefined }
  })
}
