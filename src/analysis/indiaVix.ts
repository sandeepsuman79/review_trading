import type { AngelOneDataResponse, AngelOneInstrument, AngelOneLtp } from '../api/angelOne'
import type { IndiaVixSnapshot } from '../api/marketContext'

export type IndiaVixInstrument = Pick<AngelOneInstrument, 'token' | 'symbol' | 'exch_seg'>

export function resolveIndiaVixInstrument(master: AngelOneInstrument[]): IndiaVixInstrument | undefined {
  const normalize = (value?: string) => (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const matches = master.filter(item => ['NSE', 'NSECM'].includes(normalize(item.exch_seg))
    && (normalize(item.name) === 'INDIAVIX' || normalize(item.symbol) === 'INDIAVIX')
    && !item.expiry && ['AMXIDX', 'INDEX'].includes(normalize(item.instrumenttype)) && /^\d+$/.test(String(item.token)))
  if (new Set(matches.map(item => String(item.token))).size !== 1) return undefined
  const match = matches[0]
  return { token: String(match.token), symbol: match.symbol, exch_seg: 'NSE' }
}

export function angelIndiaVixSnapshot(response: AngelOneDataResponse<AngelOneLtp | AngelOneLtp[]>, instrument: IndiaVixInstrument, now: number): IndiaVixSnapshot {
  if (response.status !== true) throw new Error(response.message || 'Angel One India VIX quote unavailable.')
  const rows = Array.isArray(response.data) ? response.data : response.data ? [response.data] : []
  const quote = rows.find(row => String(row.symboltoken) === instrument.token && row.exchange?.toUpperCase() === 'NSE')
  const ltp = quote?.ltp, closing = quote?.close
  if (ltp == null || closing == null || String(ltp).trim() === '' || String(closing).trim() === '') throw new Error('India VIX quote has no previous close.')
  const price = Number(ltp), previous = Number(closing)
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(previous) || previous <= 0) throw new Error('India VIX quote has invalid prices.')
  // LTP provides no exchange timestamp. Label this explicitly as a received snapshot.
  const asOf = new Date(now).toISOString()
  return { status: 'AVAILABLE', sourceUrl: 'https://smartapi.angelone.in/docs', fetchedAt: asOf, message: null, data: {
    symbol: '^INDIAVIX', price, changePercent: (price - previous) / previous * 100, change: price - previous, asOf, timeBasis: 'RECEIVED',
  } }
}
