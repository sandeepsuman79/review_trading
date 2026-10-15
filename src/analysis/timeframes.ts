export const candleIntervals = ['ONE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR'] as const
export type CandleInterval = typeof candleIntervals[number]
export const agentInterval: CandleInterval = 'ONE_MINUTE'
export const timeframeInfo = {
  ONE_MINUTE: { milliseconds: 60_000, label: '1-minute', coldDays: 7, requestDays: 29 },
  FIVE_MINUTE: { milliseconds: 300_000, label: '5-minute', coldDays: 14, requestDays: 99 },
  FIFTEEN_MINUTE: { milliseconds: 900_000, label: '15-minute', coldDays: 45, requestDays: 199 },
  ONE_HOUR: { milliseconds: 3_600_000, label: '1-hour', coldDays: 120, requestDays: 399 },
} satisfies Record<CandleInterval, { milliseconds: number; label: string; coldDays: number; requestDays: number }>
