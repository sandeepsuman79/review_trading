import { useMemo, useRef } from 'react'
import type { AngelOneCandle } from '../api/angelOne'
import { completedCandles, candleBucketTime } from '../analysis/candleData'
import type { PriceActionInterval } from '../analysis/priceAction'

/** Forming ticks do not invalidate expensive closed-candle analysis. */
export function useCompletedCandles(candles: AngelOneCandle[], interval: PriceActionInterval, now: number, sessionOpenMinute = 555) {
  const previous = useRef<AngelOneCandle[]>([])
  const boundary = candleBucketTime(now, interval, sessionOpenMinute)
  return useMemo(() => {
    const completed = completedCandles(candles, interval, boundary)
    if (completed.length !== previous.current.length || completed.some((candle, index) => candle !== previous.current[index])) previous.current = completed
    return previous.current
  }, [candles, interval, boundary])
}
