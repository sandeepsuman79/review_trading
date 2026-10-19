import type { AngelOneCandle } from '../api/angelOne'
import { cachedCandleIndicators } from '../analysis/candleIndicatorCache'
import type { PriceActionAnalysis } from '../analysis/priceAction'
import { candleIntervalMs } from '../analysis/candleData'
import { useEffect, useState } from 'react'
import { scoreHistoryKey, scoreTrajectory, indicatorTrajectoryRows, type IndicatorTrajectoryRow, type ScoreSample } from '../analysis/scoreTrajectory'
import type { TradingEvidence } from '../analysis/tradingEvidence'
export function useScoreTrajectory(evidence: TradingEvidence, contract = '', analysis?: PriceActionAnalysis, enabled = true, candles?: AngelOneCandle[]) {
  const [result, setResult] = useState<ReturnType<typeof scoreTrajectory> & { indicators?: IndicatorTrajectoryRow[] }>(() => scoreTrajectory([]))
  const { instrument, interval, asOf, bullishScore, bearishScore } = evidence
  const ema20 = analysis?.exponentialMovingAverage20, ema50 = analysis?.exponentialMovingAverage50, rsi = analysis?.rsi14, atr = evidence.atr14, vix = evidence.indiaVix?.price
  const supertrend = analysis?.supertrend10, supertrendDirection = analysis?.supertrendDirection, adx = analysis?.adx14, plusDi = analysis?.plusDi14, minusDi = analysis?.minusDi14, sma20 = analysis?.movingAverage20
  useEffect(() => {
    if (!asOf) return
    try {
      const key = `${scoreHistoryKey}:${instrument}:${contract}:${interval}`
      const raw = JSON.parse(localStorage.getItem(key) || '[]')
      const at = Date.parse(asOf), session = new Date(at + 330 * 60000).toISOString().slice(0, 10)
      const samples: ScoreSample[] = (Array.isArray(raw) ? raw : []).filter(s => Number.isFinite(s.at) && Number.isFinite(s.bullish) && Number.isFinite(s.bearish) && new Date(s.at + 330 * 60000).toISOString().slice(0, 10) === session && (s.at < at || !enabled && s.at === at))
      const indicators = Object.fromEntries(Object.entries({ EMA20: ema20, EMA50: ema50, RSI: rsi, ATR: atr, 'India VIX': vix, Supertrend: supertrend, ADX: adx, '+DI': plusDi, '-DI': minusDi, SMA20: sma20 }).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
      if (enabled) samples.push({ at, bullish: bullishScore, bearish: bearishScore, indicators, supertrendDirection })
      const bounded = samples.slice(-300)
      if (enabled) localStorage.setItem(key, JSON.stringify(bounded))
      const trend = scoreTrajectory(bounded, candleIntervalMs(interval))
      let indicatorSamples = bounded
      if (candles?.length) {
        const cached = cachedCandleIndicators(candles, interval, at + candleIntervalMs(interval))
        indicatorSamples = cached.closed.slice(-32).map((bar, offset) => {
          const i = cached.closed.length - Math.min(32, cached.closed.length) + offset
          const average = cached.averages[i], point = cached.trajectory.indicatorSeries[i]
          const observed = bounded.find(s => s.at === Date.parse(bar[0]))
          const values = { EMA20: average?.ema20, EMA50: average?.ema50, SMA20: average?.sma20, RSI: point?.rsi14, ATR: point?.atr14, Supertrend: point?.supertrend10, ADX: point?.adx14, '+DI': point?.plusDi14, '-DI': point?.minusDi14, 'India VIX': observed?.indicators?.['India VIX'] }
          return { at: Date.parse(bar[0]), bullish: observed?.bullish ?? 0, bearish: observed?.bearish ?? 0, supertrendDirection: point?.supertrendDirection, indicators: Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))) }
        })
      }
      setResult({ ...trend, indicators: indicatorTrajectoryRows(indicatorSamples, candleIntervalMs(interval)) })
    } catch { setResult({ state: 'UNAVAILABLE', detail: 'Unable to save score trajectory in this browser.' }) }
  }, [instrument, contract, interval, asOf, bullishScore, bearishScore, ema20, ema50, rsi, atr, vix, supertrend, supertrendDirection, adx, plusDi, minusDi, sma20, enabled, candles])
  return result
}
