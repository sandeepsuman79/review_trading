import type { AngelOneCandle } from '../api/angelOne'
import { candleIntervalMs, completedCandles } from './candleData'
import { calculateMovingAverageSeries } from './movingAverages'
import type { PriceActionInterval } from './priceAction'
import { calculateTechnicalIndicatorSeries } from './technicalIndicators'
import { calculateSessionVwap } from './vwap'

export type IndicatorTurn = { name: string; side: 'CALL' | 'PUT'; at: string }

/** Turns describe completed bars only; they cannot create a trade without a price setup. */
export function analyzeIndicatorTrajectory(candles: AngelOneCandle[], interval: PriceActionInterval, now: number) {
  const closed = completedCandles(candles, interval, now)
  const averages = calculateMovingAverageSeries(closed.map(candle => candle[4]))
  const indicators = calculateTechnicalIndicatorSeries(closed.map(candle => candle[2]), closed.map(candle => candle[3]), closed.map(candle => candle[4]))
  const vwap = calculateSessionVwap(closed)
  const end = closed.length - 1, latest = averages[end], previous = averages[end - 1]
  const consecutive = (start: number) => start >= 0 && closed.slice(start + 1).every((candle, offset) => Date.parse(candle[0]) - Date.parse(closed[start + offset][0]) === candleIntervalMs(interval))
  const turns: IndicatorTurn[] = []
  const record = (name: string, vote: number) => turns.push({ name, side: vote > 0 ? 'CALL' : 'PUT', at: closed[end][0] })
  const atr = indicators[end]?.atr14
  let slopeVote: number | undefined
  const slopeDetails: string[] = []
  if (atr && consecutive(end - 6)) {
    const threshold = atr * .03
    const votes = (['ema20', 'ema50'] as const).map(key => {
      const current = latest?.[key], older = averages[end - 3]?.[key], oldest = averages[end - 6]?.[key]
      if (current === undefined || older === undefined || oldest === undefined) return undefined
      const slope = current - older, priorSlope = older - oldest
      const sign = Math.abs(slope) < threshold ? 0 : Math.sign(slope)
      slopeDetails.push(`${key === 'ema20' ? 'EMA(20)' : 'EMA(50)'} trajectory: ${sign > 0 ? 'rising' : sign < 0 ? 'falling' : 'flat'}`)
      if (sign && priorSlope * sign < -threshold) record(`${key === 'ema20' ? 'EMA(20)' : 'EMA(50)'} turned ${sign > 0 ? 'up' : 'down'}`, sign)
      return sign
    })
    if (votes.every(vote => vote !== undefined)) slopeVote = (votes[0]! + votes[1]!) / 2
  }
  if (consecutive(end - 1)) {
    const cross = (name: string, before?: number, after?: number) => {
      if (before === undefined || after === undefined || !Number.isFinite(before) || !Number.isFinite(after)) return
      if (before <= 0 && after > 0) record(`${name} crossed upward`, 1)
      else if (before >= 0 && after < 0) record(`${name} crossed downward`, -1)
    }
    cross('EMA(20/50)', previous?.ema20 !== undefined && previous.ema50 !== undefined ? previous.ema20 - previous.ema50 : undefined, latest?.ema20 !== undefined && latest.ema50 !== undefined ? latest.ema20 - latest.ema50 : undefined)
    cross('RSI(14) / 50', indicators[end - 1]?.rsi14 === undefined ? undefined : indicators[end - 1].rsi14! - 50, indicators[end]?.rsi14 === undefined ? undefined : indicators[end].rsi14! - 50)
    const previousDirection = indicators[end - 1]?.supertrendDirection, direction = indicators[end]?.supertrendDirection
    if (previousDirection && direction && direction !== previousDirection) record(`Supertrend flipped ${direction === 'UP' ? 'up' : 'down'}`, direction === 'UP' ? 1 : -1)
    // VWAP resets each IST session; crossing yesterday's VWAP is not a crossover.
    const session = (time: string) => new Date(Date.parse(time) + 330 * 60_000).toISOString().slice(0, 10)
    if (session(closed[end - 1][0]) === session(closed[end][0])) cross('Price / VWAP', vwap[end - 1] === undefined ? undefined : closed[end - 1][4] - vwap[end - 1]!, vwap[end] === undefined ? undefined : closed[end][4] - vwap[end]!)
  }
  const turnVote = turns.length ? turns.reduce((sum, turn) => sum + (turn.side === 'CALL' ? 1 : -1), 0) / turns.length : 0
  return { slopeVote, slopeDetails, turns, turnVote: consecutive(end - 1) ? turnVote : undefined }
}
