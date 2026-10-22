import { AngelOneSessionExpiredError, isAngelOneAuthError, recoverAngelOneSession } from './angelOneSession'
export type AtmVwapLeg = { symbol: string; token: string; exchange: string; close: number | null; vwap: number | null; asOf: string | null; volume: number; coverage: 'FULL_SESSION' | 'PARTIAL_SESSION' }
export type AtmVwapSnapshot = { index: string; strike: number; expiry: string; fetchedAt: string; method: 'SESSION_HLC3_VOLUME'; referenceIndexPrice: number; ce: AtmVwapLeg; pe: AtmVwapLeg }
export async function getAtmVwap(index: string, price: number, signal: AbortSignal): Promise<AtmVwapSnapshot> {
  let token = localStorage.getItem('angelone_jwt_token') || ''
  if (!token) throw new Error('Log in to load ATM option VWAP.')
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch('/api/angelone/atm-vwap', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ index, price }), signal })
    const data = await response.json().catch(() => ({}))
    if (isAngelOneAuthError({ ...data, status: response.status })) { if (attempt === 1) throw new AngelOneSessionExpiredError(); token = await recoverAngelOneSession(token); continue }
    if (!response.ok || data.status === false) throw new Error(data.message || 'ATM option VWAP is unavailable.')
    if (data.index !== index || data.method !== 'SESSION_HLC3_VOLUME' || !Number.isFinite(data.strike) || data.strike <= 0 || !Number.isFinite(data.referenceIndexPrice) || data.referenceIndexPrice <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(data.expiry) || !Number.isFinite(Date.parse(data.fetchedAt)) || ![data.ce,data.pe].every(leg => leg && typeof leg.symbol === 'string' && typeof leg.token === 'string' && Number.isFinite(leg.volume) && leg.volume >= 0 && ['FULL_SESSION','PARTIAL_SESSION'].includes(leg.coverage) && [leg.close,leg.vwap].every(value=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>0) && (leg.asOf===null||Number.isFinite(Date.parse(leg.asOf))))) throw new Error('Invalid ATM VWAP response.')
    return data
  }
  throw new Error('ATM option VWAP unavailable.')
}
export function atmVwapBias(snapshot: AtmVwapSnapshot | undefined, instrument: string, price: number | undefined, now: number) {
  if (!['Nifty 50','Sensex','Bank Nifty'].includes(instrument) || price === undefined || !Number.isFinite(price) || price <= 0) return undefined
  const step = instrument === 'Nifty 50' ? 50 : 100
  if (!snapshot || snapshot.index !== instrument || price === undefined || Math.abs(snapshot.strike - price) > step || Date.parse(`${snapshot.expiry}T15:30:00+05:30`) <= now || now < Date.parse(snapshot.fetchedAt) || now - Date.parse(snapshot.fetchedAt) >= 120_000) return undefined
  const session = (time: number) => Math.floor((time + 19_800_000) / 86_400_000)
  if (![snapshot.ce,snapshot.pe].every(leg => leg.coverage === 'FULL_SESSION' && leg.volume > 0 && leg.close !== null && leg.vwap !== null && leg.asOf !== null && now >= Date.parse(leg.asOf) && now - Date.parse(leg.asOf) < 120_000 && session(Date.parse(leg.asOf)) === session(now))) return undefined
  const ce = snapshot.ce.close! - snapshot.ce.vwap!, pe = snapshot.pe.close! - snapshot.pe.vwap!
  return ce > 0 && pe < 0 ? 'BULLISH' : ce < 0 && pe > 0 ? 'BEARISH' : 'MIXED'
}

// Chart and agent consumers share a request, including across interval changes.
// A consumer unmount must not abort another consumer's broker request.
const sharedRequests = new Map<string, { until: number; task: Promise<AtmVwapSnapshot> }>()
export function getSharedAtmVwap(index: string, price: number, now: number): Promise<AtmVwapSnapshot> {
  const step = index === 'Nifty 50' ? 50 : 100
  const key = JSON.stringify([localStorage.getItem('angelone_jwt_token'), index, Math.round(price / step), Math.floor(now / 60_000)])
  for (const [key, value] of sharedRequests) if (value.until <= now) sharedRequests.delete(key)
  const saved = sharedRequests.get(key)
  if (saved) return saved.task
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 55_000)
  const task = getAtmVwap(index, price, controller.signal).catch(error => {
    sharedRequests.delete(key)
    if (controller.signal.aborted) throw new Error('ATM candle request timed out. Retrying shortly.')
    throw error
  }).finally(() => clearTimeout(timeout))
  sharedRequests.set(key, { until: (Math.floor(now / 60_000) + 1) * 60_000, task })
  if (sharedRequests.size > 24) sharedRequests.delete(sharedRequests.keys().next().value!)
  return task
}
