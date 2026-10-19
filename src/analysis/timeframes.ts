export const chartIntervals = ['FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR'] as const
export const defaultChartInterval = 'FIVE_MINUTE' as const
export const agentIntervals = chartIntervals
export const historyIntervals = ['FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR'] as const
// ONE_MINUTE remains readable for archived candles/trades and raw option VWAP data.
export const candleIntervals = ['ONE_MINUTE', ...chartIntervals] as const
export type CandleInterval = typeof candleIntervals[number]
export const agentInterval = defaultChartInterval
export const timeframeInfo = {
  ONE_MINUTE: { milliseconds: 60_000, label: '1-minute', coldDays: 7, requestDays: 29 },
  FIVE_MINUTE: { milliseconds: 300_000, label: '5-minute', coldDays: 14, requestDays: 99 },
  FIFTEEN_MINUTE: { milliseconds: 900_000, label: '15-minute', coldDays: 45, requestDays: 199 },
  ONE_HOUR: { milliseconds: 3_600_000, label: '1-hour', coldDays: 120, requestDays: 399 },
} satisfies Record<CandleInterval, { milliseconds: number; label: string; coldDays: number; requestDays: number }>
