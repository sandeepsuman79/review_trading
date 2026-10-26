import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionInterval } from './priceAction'
import { candleBucketTime, candleIntervalMs, normalizeCandles } from './candleData'
import { isCommodity, mcxSession } from './commodities'
import { tradingSession } from './tradingSession'
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
export function historySyncRange(candles: AngelOneCandle[], interval: PriceActionInterval, now: number, sessionOpenMinute = 555, syncedThrough?: number) {
  const history = normalizeCandles(candles).filter(candle => Date.parse(candle[0]) <= now)
  const days = timeframeInfo[interval].coldDays
  const latest = history.length >= 60 ? Date.parse(history[history.length - 1][0]) : now - days * 86_400_000
  const ist = new Date(now + 330 * 60_000)
  const sessionOpen = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) + (sessionOpenMinute - 330) * 60_000
  const trusted = syncedThrough !== undefined && Number.isFinite(syncedThrough) && syncedThrough <= now && history.length > 0
  const from = trusted ? Math.min(syncedThrough!, Date.parse(history[history.length - 1][0])) - candleIntervalMs(interval) : Math.min(latest - candleIntervalMs(interval), sessionOpen)
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

/** Poll only after a completed candle is due, with a short broker publication grace. */
export function historyRefreshDue(interval: PriceActionInterval, instrument: string, now: number, syncedThrough?: number, lastAttempt?: number) {
  if (!Number.isFinite(now) || lastAttempt !== undefined && now - lastAttempt < 30_000) return false
  const session = tradingSession(now), commodity = isCommodity(instrument)
  const openMinute = commodity ? 540 : 555
  const start = session.start + openMinute * 60_000
  const close = commodity ? mcxSession(now).close : session.start + 930 * 60_000
  if (!session.weekday || now < start || now > close + 120_000) return false
  const boundary = now >= close + 5000 ? close : candleBucketTime(now - 5000, interval, openMinute)
  return boundary > start && (syncedThrough === undefined || !Number.isFinite(syncedThrough) || syncedThrough < boundary)
}

/** A timed-out broker call cancels only that call, never the remaining sync queue. */
export async function runHistoricalRequest<T>(run: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs = 60_000): Promise<T> {
  parent.throwIfAborted()
  const child = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {}
  const cancelled = new Promise<T>((_resolve, reject) => {
    abort = () => { child.abort(); reject(new DOMException('Sync cancelled', 'AbortError')) }
    parent.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      child.abort()
      reject(Object.assign(new Error('Historical request timed out; retrying this instrument without cancelling other charts.'), { status: 408 }))
    }, timeoutMs)
  })
  try { return await Promise.race([Promise.resolve().then(() => run(child.signal)), cancelled]) }
  finally { clearTimeout(timer); parent.removeEventListener('abort', abort) }
}
