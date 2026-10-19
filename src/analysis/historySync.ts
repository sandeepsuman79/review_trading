import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionInterval } from './priceAction'
import { candleIntervalMs, normalizeCandles } from './candleData'
import { defaultChartInterval, timeframeInfo } from './timeframes'

export type HistoryJob = { token: string; interval: PriceActionInterval }
export function prioritizeHistoryJobs<T extends HistoryJob>(jobs: T[], token: string, interval: PriceActionInterval, agentFirst = true) {
  return [...jobs].sort((a, b) => {
    const priority = (job: HistoryJob) => {
      const order = [...new Set([agentFirst ? defaultChartInterval : interval, interval, 'FIVE_MINUTE', 'ONE_HOUR'])]
      const rank = order.indexOf(job.interval)
      return (job.token === token ? 0 : 10) + (rank < 0 ? order.length : rank)
    }
    return priority(a) - priority(b)
  })
}

/** Live-only candles cannot prove that the earlier part of today's session was synced. */
export function historySyncRange(candles: AngelOneCandle[], interval: PriceActionInterval, now: number, sessionOpenMinute = 555) {
  const history = normalizeCandles(candles).filter(candle => Date.parse(candle[0]) <= now)
  const days = timeframeInfo[interval].coldDays
  const latest = history.length >= 60 ? Date.parse(history[history.length - 1][0]) : now - days * 86_400_000
  const ist = new Date(now + 330 * 60_000)
  const sessionOpen = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) + (sessionOpenMinute - 330) * 60_000
  const from = Math.min(latest - candleIntervalMs(interval), sessionOpen)
  const limit = timeframeInfo[interval].requestDays
  return { from, to: Math.min(now, from + limit * 86_400_000) }
}

export function formatHistoricalDate(timestamp: number) {
  return new Date(timestamp + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
}

export function historyRetryDelay(error: unknown, attempt: number) {
  const failure = error as { message?: string; status?: number; retryAfterMs?: number }
  const message = failure?.message ?? ''
  if (failure.status === 401 || failure.status === 403 || /invalid.*token|token.*invalid|expired|AG800[12]/i.test(message)) return undefined
  if (/rate|too many|exceeding access|AB1021/i.test(message) || failure.status === 429) return Math.max(failure.retryAfterMs ?? 0, 15_000 * 2 ** attempt)
  if ([408, 500, 502, 503, 504].includes(failure.status ?? 0) || /network|fetch|connect|timeout|timed out|AB1004|temporarily/i.test(message)) return 2_000 * 2 ** attempt
  return undefined
}

export function abortableWait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Sync cancelled', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
