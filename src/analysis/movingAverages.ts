export type MovingAveragePoint = {
  sma20?: number
  ema20?: number
  ema50?: number
}

/** Calculates close-based SMA(20), EMA(20), and EMA(50). */
export function calculateMovingAverageSeries(closes: number[]): MovingAveragePoint[] {
  const values: MovingAveragePoint[] = Array.from({ length: closes.length }, () => ({}))

  for (let index = 19; index < closes.length; index += 1) {
    const window = closes.slice(index - 19, index + 1)
    values[index].sma20 = window.reduce((sum, close) => sum + close, 0) / 20
  }

  if (closes.length >= 20) {
    let ema = closes.slice(0, 20).reduce((sum, close) => sum + close, 0) / 20
    values[19].ema20 = ema
    const multiplier = 2 / 21
    for (let index = 20; index < closes.length; index += 1) {
      ema = (closes[index] - ema) * multiplier + ema
      values[index].ema20 = ema
    }
  }

  if (closes.length >= 50) {
    let ema = closes.slice(0, 50).reduce((sum, close) => sum + close, 0) / 50
    values[49].ema50 = ema
    const multiplier = 2 / 51
    for (let index = 50; index < closes.length; index += 1) {
      ema = (closes[index] - ema) * multiplier + ema
      values[index].ema50 = ema
    }
  }

  return values
}
