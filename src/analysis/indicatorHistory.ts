import type { AngelOneCandle } from '../api/angelOne'
import { instrumentSession, tradingSession } from './tradingSession'

/** Indicator observations follow trading bars, including the regular overnight
 * closure and dated special sessions. Missing intraday bars or an absent
 * scheduled session still break trajectories; unknown holidays are not guessed. */
export function adjacentIndicatorBars(from: number, to: number, intervalMs: number, instrument?: string) {
  if (![from, to, intervalMs].every(Number.isFinite) || intervalMs <= 0 || to <= from) return false
  const before = instrumentSession(from, instrument), after = instrumentSession(to, instrument)
  if (before.date === after.date) return to - from === intervalMs
  if (!before.tradingDay || !after.tradingDay) return false
  const lastBar = before.open + Math.floor((before.close - before.open - 1) / intervalMs) * intervalMs
  if (from !== lastBar || to !== after.open) return false
  let next = before.start + 86_400_000
  while (next < after.start && !instrumentSession(next, instrument).tradingDay) next += 86_400_000
  return next === after.start
}

export function indicatorHistoryCounts(candles: AngelOneCandle[], now: number) {
  const date = tradingSession(now).date
  const currentSessionBars = candles.filter(bar => tradingSession(Date.parse(bar[0])).date === date).length
  return { completedBars: candles.length, currentSessionBars, previousSessionBars: candles.length - currentSessionBars }
}
