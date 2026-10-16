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
    if (data.index !== index || data.method !== 'SESSION_HLC3_VOLUME' || !Number.isFinite(data.strike) || data.strike <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(data.expiry) || !Number.isFinite(Date.parse(data.fetchedAt)) || ![data.ce,data.pe].every(leg => leg && typeof leg.symbol === 'string' && typeof leg.token === 'string' && Number.isFinite(leg.volume) && leg.volume >= 0 && ['FULL_SESSION','PARTIAL_SESSION'].includes(leg.coverage) && [leg.close,leg.vwap].every(value=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>0) && (leg.asOf===null||Number.isFinite(Date.parse(leg.asOf))))) throw new Error('Invalid ATM VWAP response.')
    return data
  }
  throw new Error('ATM option VWAP unavailable.')
}
export function atmVwapBias(snapshot: AtmVwapSnapshot | undefined, instrument: string, price: number | undefined, now: number) {
  if (!['Nifty 50','Sensex','Bank Nifty'].includes(instrument) || price === undefined || !Number.isFinite(price) || price <= 0) return undefined
  const step = instrument === 'Nifty 50' ? 50 : 100
  if (!snapshot || snapshot.index !== instrument || price === undefined || Math.abs(snapshot.strike - price) > step || Date.parse(`${snapshot.expiry}T15:30:00+05:30`) <= now || now < Date.parse(snapshot.fetchedAt) || now - Date.parse(snapshot.fetchedAt) >= 120_000) return undefined
  if (![snapshot.ce,snapshot.pe].every(leg => leg.coverage === 'FULL_SESSION' && leg.volume > 0 && leg.close !== null && leg.vwap !== null && leg.asOf !== null && now >= Date.parse(leg.asOf) && now - Date.parse(leg.asOf) < 120_000)) return undefined
  const ce = snapshot.ce.close! - snapshot.ce.vwap!, pe = snapshot.pe.close! - snapshot.pe.vwap!
  return ce > 0 && pe < 0 ? 'BULLISH' : ce < 0 && pe > 0 ? 'BEARISH' : 'MIXED'
}
