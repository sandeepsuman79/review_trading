export type TechnicalIndicatorPoint = {
  rsi14?: number
  supertrend10?: number
  supertrendDirection?: 'UP' | 'DOWN'
}

/** Wilder RSI(14) on candle closes. The first value is available at index 14. */
export function calculateRsi14(closes: number[]): Array<number | undefined> {
  const values: Array<number | undefined> = Array(closes.length).fill(undefined)
  if (closes.length <= 14) return values

  let averageGain = 0
  let averageLoss = 0
  for (let index = 1; index <= 14; index += 1) {
    const change = closes[index] - closes[index - 1]
    averageGain += Math.max(change, 0) / 14
    averageLoss += Math.max(-change, 0) / 14
  }

  const rsi = () => {
    if (averageLoss === 0) return averageGain === 0 ? 50 : 100
    const relativeStrength = averageGain / averageLoss
    return 100 - 100 / (1 + relativeStrength)
  }

  values[14] = rsi()
  for (let index = 15; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1]
    averageGain = (averageGain * 13 + Math.max(change, 0)) / 14
    averageLoss = (averageLoss * 13 + Math.max(-change, 0)) / 14
    values[index] = rsi()
  }
  return values
}

/**
 * Supertrend(10, 3): ATR period 10 with the conventional multiplier 3.
 * Uses Wilder-smoothed ATR and returns no value before the initial ATR is formed.
 */
export function calculateSupertrend10(
  highs: number[],
  lows: number[],
  closes: number[],
): Array<{ value?: number; direction?: 'UP' | 'DOWN' }> {
  const length = Math.min(highs.length, lows.length, closes.length)
  const result: Array<{ value?: number; direction?: 'UP' | 'DOWN' }> = Array.from({ length }, () => ({}))
  const period = 10
  const multiplier = 3
  if (length < period) return result

  const trueRanges = Array.from({ length }, (_, index) => {
    if (index === 0) return highs[index] - lows[index]
    return Math.max(
      highs[index] - lows[index],
      Math.abs(highs[index] - closes[index - 1]),
      Math.abs(lows[index] - closes[index - 1]),
    )
  })

  let atr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  let finalUpper = (highs[period - 1] + lows[period - 1]) / 2 + multiplier * atr
  let finalLower = (highs[period - 1] + lows[period - 1]) / 2 - multiplier * atr
  let direction: 'UP' | 'DOWN' = closes[period - 1] >= (highs[period - 1] + lows[period - 1]) / 2 ? 'UP' : 'DOWN'
  result[period - 1] = { value: direction === 'UP' ? finalLower : finalUpper, direction }

  for (let index = period; index < length; index += 1) {
    atr = (atr * (period - 1) + trueRanges[index]) / period
    const midpoint = (highs[index] + lows[index]) / 2
    const basicUpper = midpoint + multiplier * atr
    const basicLower = midpoint - multiplier * atr
    const previousClose = closes[index - 1]
    const previousUpper = finalUpper
    const previousLower = finalLower

    finalUpper = basicUpper < previousUpper || previousClose > previousUpper ? basicUpper : previousUpper
    finalLower = basicLower > previousLower || previousClose < previousLower ? basicLower : previousLower

    if (direction === 'DOWN' && closes[index] > finalUpper) direction = 'UP'
    else if (direction === 'UP' && closes[index] < finalLower) direction = 'DOWN'

    result[index] = { value: direction === 'UP' ? finalLower : finalUpper, direction }
  }

  return result
}

export function calculateTechnicalIndicatorSeries(
  highs: number[],
  lows: number[],
  closes: number[],
): TechnicalIndicatorPoint[] {
  const rsi = calculateRsi14(closes)
  const supertrend = calculateSupertrend10(highs, lows, closes)
  return Array.from({ length: Math.min(highs.length, lows.length, closes.length) }, (_, index) => ({
    rsi14: rsi[index],
    supertrend10: supertrend[index]?.value,
    supertrendDirection: supertrend[index]?.direction,
  }))
}
