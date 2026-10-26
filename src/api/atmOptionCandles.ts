import { getHistoricalCandles, type AngelOneCandle } from './angelOne'
import { isAngelOneAuthError, recoverAngelOneSession } from './angelOneSession'
import type { AtmVwapSnapshot } from './atmVwap'
import { normalizeCandles } from '../analysis/candleData'
import { formatHistoricalDate, historySyncRange, runHistoricalRequest } from '../analysis/historySync'
import { chartIntervals, type CandleInterval } from '../analysis/timeframes'

export type AtmOptionCandles = {
  index: string; strike: number; expiry: string; interval: CandleInterval; fetchedAt: number
  ce: AngelOneCandle[]; pe: AngelOneCandle[]
}
const saved = new Map<string, { data: AtmOptionCandles; checkedMinute: number; through: { ce?: number; pe?: number } }>()
const pending = new Map<string, Promise<AtmOptionCandles>>()
export function atmOptionChartKey(snapshot: AtmVwapSnapshot, interval: CandleInterval) {
  return JSON.stringify([localStorage.getItem('angelone_jwt_token'), snapshot.index, snapshot.strike, snapshot.expiry,
    snapshot.ce.exchange, snapshot.ce.token, snapshot.pe.exchange, snapshot.pe.token, interval])
}

/** Only the visible ATM chart loads history; never substitute option volume into spot candles. */
export function getAtmOptionCandles(snapshot: AtmVwapSnapshot, interval: CandleInterval, now: number): Promise<AtmOptionCandles> {
  if (!['Nifty 50', 'Sensex', 'Bank Nifty'].includes(snapshot.index) || !(chartIntervals as readonly string[]).includes(interval)
    || !Number.isFinite(now) || ![snapshot.ce, snapshot.pe].every(leg => /^\d+$/.test(leg.token) && leg.exchange === (snapshot.index === 'Sensex' ? 'BFO' : 'NFO'))) {
    return Promise.reject(new Error('Valid index ATM contracts and chart interval are required.'))
  }
  const key = atmOptionChartKey(snapshot, interval), minute = Math.floor((now - 5000) / 60_000)
  const previous = saved.get(key)
  if (previous?.checkedMinute === minute) return Promise.resolve(previous.data)
  const waiting = pending.get(key)
  if (waiting) return waiting
  if (pending.size >= 6) return Promise.reject(new Error('ATM chart history is loading. Retrying shortly.'))
  const controller = new AbortController()
  const task = (async () => {
    let token = localStorage.getItem('angelone_jwt_token') || ''
    if (!token) throw new Error('Log in to load ATM option candles.')
    const through: { ce?: number; pe?: number } = {}
    const load = async (side: 'ce' | 'pe') => {
      const leg = snapshot[side], cached = previous?.data[side] ?? []
      const range = historySyncRange(cached, interval, now, 555, previous?.through[side])
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await runHistoricalRequest(signal => getHistoricalCandles(token, {
            exchange: leg.exchange, symboltoken: leg.token, interval,
            fromdate: formatHistoricalDate(range.from), todate: formatHistoricalDate(range.to),
          }, signal), controller.signal)
          const incoming = normalizeCandles(result.data ?? []).filter(bar => Date.parse(bar[0]) <= now && bar.slice(1, 5).every(value => typeof value === 'number' && value > 0))
          if (!incoming.length) throw new Error(`${side.toUpperCase()} option candles are unavailable from the broker.`)
          // Re-fetch the last saved bar, including broker corrections and the forming bar.
          through[side] = Date.parse(incoming[incoming.length - 1][0])
          return normalizeCandles([...cached, ...incoming]).slice(-2000)
        } catch (error) {
          if (attempt === 0 && error instanceof Error && isAngelOneAuthError(error)) { token = await recoverAngelOneSession(token); continue }
          throw error
        }
      }
      throw new Error('ATM option history unavailable.')
    }
    const legs = await Promise.allSettled([load('ce'), load('pe')])
    const failed = legs.find((leg): leg is PromiseRejectedResult => leg.status === 'rejected')
    if (failed) throw failed.reason
    const [ce, pe] = legs.map(leg => (leg as PromiseFulfilledResult<AngelOneCandle[]>).value)
    const data: AtmOptionCandles = { index: snapshot.index, strike: snapshot.strike, expiry: snapshot.expiry, interval, fetchedAt: Date.now(), ce, pe }
    saved.set(key, { data, checkedMinute: minute, through })
    while (saved.size > 18) saved.delete(saved.keys().next().value!)
    return data
  })().finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}
