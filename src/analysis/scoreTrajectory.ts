import { analyzeSwingTrajectory, type SwingTrajectory } from './swingTrajectory'
export type ScoreSample = { at: number; bullish: number; bearish: number; indicators?: Record<string, number>; supertrendDirection?: 'UP' | 'DOWN' }
export const scoreHistoryKey = 'traders_score_trajectory_v1'
export function scoreDominates(support: number, opposition: number) {
  return Number.isFinite(support) && Number.isFinite(opposition) && support > 0 && opposition >= 0 && support >= 1.5 * opposition
}
export function scoreTrajectory(samples: ScoreSample[], intervalMs = 300000) {
  const recent = samples.slice(-4)
  if (recent.length < 3 || recent.some((s, i) => !Number.isFinite(s.at) || (i > 0 && s.at - recent[i - 1].at !== intervalMs))) return { state: 'WARMING_UP', detail: 'Waiting for three completed score observations.' }
  const first = recent[0], last = recent[recent.length - 1]
  const bullDelta = last.bullish - first.bullish, bearDelta = last.bearish - first.bearish
  const bearishPressure = bearDelta > 0 && bullDelta < 0
  const bullishPressure = bullDelta > 0 && bearDelta < 0
  const state = bearishPressure ? 'BEARISH_PRESSURE' : bullishPressure ? 'BULLISH_PRESSURE' : 'MIXED'
  return { state, bullDelta, bearDelta, detail: `Bullish ${bullDelta >= 0 ? '+' : ''}${bullDelta.toFixed(1)} · Bearish ${bearDelta >= 0 ? '+' : ''}${bearDelta.toFixed(1)} over ${recent.length} completed observations. ${bearishPressure || bullishPressure ? 'Reversal pressure: recheck price setup, EMA, RSI and Supertrend; ATR/VIX remain risk inputs.' : 'No opposing score reversal confirmed.'}` }
}

export function indicatorTrajectorySummary(samples: ScoreSample[]) {
  const recent = samples.slice(-7), last = recent[recent.length - 1]
  if (recent.length < 3 || !last?.indicators) return ''
  return Object.entries(last.indicators).flatMap(([name, current]) => {
    const values = recent.map(s => s.indicators?.[name]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (values.length < 3) return []
    const change = current - values[0], high = Math.max(...values), low = Math.min(...values)
    return [`${name}: ${change > 0 ? 'rising' : change < 0 ? 'falling' : 'flat'} · ${current.toFixed(2)} (recent low ${low.toFixed(2)} / high ${high.toFixed(2)})`]
  }).join(' · ')
}

export type IndicatorTrajectoryRow = {
  structure?: SwingTrajectory; name: string; value?: number; previous?: number; change?: number; low?: number; high?: number
  movement: 'RISING' | 'FALLING' | 'FLAT' | 'WAITING'
  turn?: 'FROM_PEAK' | 'FROM_TROUGH'; risk: boolean; direction?: 'UP' | 'DOWN'
}
/** Each comparison uses adjacent completed observations of this same timeframe. */
export function indicatorTrajectoryRows(samples: ScoreSample[], intervalMs = 300000): IndicatorTrajectoryRow[] {
  const last = samples[samples.length - 1], recent: ScoreSample[] = []
  for (let i = samples.length - 1; i >= 0 && recent.length < 32; i--) {
    if (i < samples.length - 1 && (samples[i + 1].at - samples[i].at !== intervalMs || Math.floor((samples[i].at + 19800000) / 86400000) !== Math.floor((samples[i + 1].at + 19800000) / 86400000))) break
    recent.unshift(samples[i])
  }
  const names = ['EMA20', 'EMA50', 'RSI', 'Supertrend', 'ATR', 'India VIX', 'ADX', '+DI', '-DI', 'SMA20']
  return names.map(name => {
    const finiteValue = (s: ScoreSample | undefined) => { const v = s?.indicators?.[name]; return typeof v === 'number' && Number.isFinite(v) ? v : undefined }
    const value = finiteValue(last), previous = finiteValue(recent[recent.length - 2]), before = finiteValue(recent[recent.length - 3])
    const change = value !== undefined && previous !== undefined ? value - previous : undefined
    const values = recent.map(finiteValue).filter((v): v is number => v !== undefined)
    const movement = change === undefined ? 'WAITING' : change > 0 ? 'RISING' : change < 0 ? 'FALLING' : 'FLAT'
    const turn = previous !== undefined && before !== undefined && value !== undefined ? value < previous && previous >= before ? 'FROM_PEAK' : value > previous && previous <= before ? 'FROM_TROUGH' : undefined : undefined
    const atr = last?.indicators?.ATR
    const noise = ['EMA20', 'EMA50', 'Supertrend', 'SMA20'].includes(name) && atr ? atr * .03 : name === 'RSI' ? 1 : name === 'India VIX' ? .1 : name === 'ATR' ? Math.abs(value ?? 0) * .01 : .5
    const structure = analyzeSwingTrajectory(recent.map(s => ({ at: s.at, value: finiteValue(s) })), intervalMs, noise)
    return { structure, name, value, previous, change, low: values.length ? Math.min(...values) : undefined, high: values.length ? Math.max(...values) : undefined, movement, turn, risk: ['ATR', 'India VIX', 'ADX'].includes(name), ...(name === 'Supertrend' && last?.supertrendDirection ? { direction: last.supertrendDirection } : {}) }
  })
}
