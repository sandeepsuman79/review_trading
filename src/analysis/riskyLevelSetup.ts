import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionAnalysis, PriceActionInterval } from './priceAction'
import { candleIntervalMs } from './candleData'
import { candleSession } from './vwap'

export type RiskyLevelSetup = {
  side: 'CALL' | 'PUT'; entry: number; stopLoss: number; target: number; riskReward: number
  level: number; levelType: 'SUPPORT' | 'RESISTANCE'; passedChecks: number; unmetChecks: string[]
  alignedIndicators: string[]; opposedIndicators: string[]; targetBasis: string
}
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** Partial confirmation may produce a labelled conditional idea, never full confirmation. */
export function findRiskyLevelSetup({ analysis, candles, checks, bullishScore, bearishScore, interval, now }: {
  analysis: PriceActionAnalysis; candles: AngelOneCandle[]; checks: Array<{ label: string; passed: boolean }>
  bullishScore: number; bearishScore: number; interval: PriceActionInterval; now: number
}): RiskyLevelSetup | undefined {
  const passedChecks = checks.filter(check => check.passed).length
  const latest = candles[candles.length - 1], previous = candles[candles.length - 2]
  const atr = analysis.atr14, ema20 = analysis.exponentialMovingAverage20, ema50 = analysis.exponentialMovingAverage50
  const rsi = analysis.rsi14, momentum = analysis.rsi14Momentum
  if (passedChecks < 4 || candles.length < 50 || !latest || !previous || !valid(atr) || !valid(ema20) || !valid(ema50) || rsi === undefined || momentum === undefined || !Number.isFinite(rsi) || !Number.isFinite(momentum)) return undefined
  const time = Date.parse(latest[0]), duration = candleIntervalMs(interval)
  if (Date.parse(analysis.latestCandleTime ?? '') !== time || time + duration > now || now >= time + 2 * duration || candleSession(latest[0]) !== candleSession(previous[0]) || time - Date.parse(previous[0]) !== duration) return undefined
  const local = new Date(now + 330 * 60_000), minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  if (minute < 555 || minute >= 925) return undefined
  const setups: RiskyLevelSetup[] = []
  for (const d of [1, -1] as const) {
    const level = d === 1 ? analysis.support : analysis.resistance
    if (!valid(level) || d * (latest[4] - level) < 0 || Math.abs(latest[4] - level) > 1.5 * atr) continue
    const touchesLevel = d === 1 ? Math.min(latest[3], previous[3]) <= level + .25 * atr : Math.max(latest[2], previous[2]) >= level - .25 * atr
    if (!touchesLevel) continue
    const side = d === 1 ? 'CALL' : 'PUT'
    const routes = analysis.alignment?.routes.filter(route => route.side === side) ?? []
    if (!routes.length || Date.parse(analysis.alignment?.at ?? '') !== time) continue
    const votes = [
      ['EMA20/50 and price', d * (ema20 - ema50) > 0 && d * (latest[4] - ema20) >= -.25 * atr],
      ['RSI and momentum', d === 1 ? rsi >= 50 && rsi < 85 && momentum >= 0 : rsi <= 50 && rsi > 15 && momentum <= 0],
      ['Supertrend', analysis.supertrendDirection === (d === 1 ? 'UP' : 'DOWN')],
      ['ADX/DMI', (analysis.adx14 ?? 0) >= 18 && d * ((analysis.plusDi14 ?? 0) - (analysis.minusDi14 ?? 0)) > 0],
    ] as const
    const alignedIndicators = routes.map(route => route.name)
    const support = d === 1 ? bullishScore : bearishScore, opposition = d === 1 ? bearishScore : bullishScore
    if (support < 40 || support - opposition < 10) continue
    const buffer = Math.max(.05 * atr, latest[4] * .00003)
    const entry = d === 1 ? Math.max(latest[2], previous[2]) + buffer : Math.min(latest[3], previous[3]) - buffer
    const structuralStop = d === 1 ? Math.min(level, latest[3], previous[3]) - buffer : Math.max(level, latest[2], previous[2]) + buffer
    const stopLoss = d === 1 ? Math.min(structuralStop, entry - atr) : Math.max(structuralStop, entry + atr)
    const observedTarget = d === 1 ? analysis.resistance : analysis.support
    // Nearby observed levels must leave enough room; do not replace a failing target.
    if (observedTarget !== undefined && (!valid(observedTarget) || d * (observedTarget - entry) <= 0)) continue
    const target = observedTarget ?? entry + d * 2 * Math.abs(entry - stopLoss)
    const roundedEntry = Math.round(entry * 100) / 100
    const roundedStop = (d === 1 ? Math.floor(stopLoss * 100) : Math.ceil(stopLoss * 100)) / 100
    const roundedTarget = Math.round(target * 100) / 100
    const riskReward = d * (roundedTarget - roundedEntry) / (d * (roundedEntry - roundedStop))
    if (![roundedEntry, roundedStop, roundedTarget].every(valid) || riskReward < 1.5) continue
    setups.push({ side: d === 1 ? 'CALL' : 'PUT', entry: roundedEntry, stopLoss: roundedStop, target: roundedTarget, riskReward,
      level, levelType: d === 1 ? 'SUPPORT' : 'RESISTANCE', passedChecks, unmetChecks: checks.filter(check => !check.passed).map(check => check.label),
      alignedIndicators, opposedIndicators: [...votes.filter(([, aligned]) => !aligned).map(([label]) => label), ...analysis.alignment!.routes.filter(route => route.side !== side).map(route => route.name)],
      targetBasis: observedTarget !== undefined ? 'Observed resistance/support' : '2R projection from ATR-aware invalidation; not an observed level' })
  }
  return setups.length === 1 ? setups[0] : undefined
}
