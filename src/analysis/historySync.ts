import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionInterval } from './priceAction'
import { candleIntervalMs, normalizeCandles } from './candleData'

export type HistoryJob = { token: string; interval: PriceActionInterval }
export function prioritizeHistoryJobs<T extends HistoryJob>(jobs: T[], token: string, interval: PriceActionInterval) {
  return [...jobs].sort((a, b) => {
    const priority = (job: HistoryJob) => job.token === token ? job.interval === interval ? 0 : 1 : job.interval === interval ? 2 : 3
    return priority(a) - priority(b)
  })
}

/** Small cold start; cached history requests only the overlap and missing tail. */
export function historySyncRange(candles: AngelOneCandle[], interval: PriceActionInterval, now: number) {
  const history = normalizeCandles(candles)
  const days = interval === 'FIVE_MINUTE' ? 14 : interval === 'FIFTEEN_MINUTE' ? 45 : 120
  const latest = history.length >= 60 ? Date.parse(history[history.length - 1][0]) : now - days * 86_400_000
  const from = latest - candleIntervalMs(interval)
  const limit = interval === 'FIVE_MINUTE' ? 99 : interval === 'FIFTEEN_MINUTE' ? 199 : 399
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
