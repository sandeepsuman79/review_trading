import { AngelOneSessionExpiredError, isAngelOneAuthError, recoverAngelOneSession } from './angelOneSession'
export type AtmVwapLeg = { symbol: string; token: string; exchange: string; close: number | null; vwap: number | null; asOf: string | null; priceAsOf?: string | null; volume: number; coverage: 'FULL_SESSION' | 'PARTIAL_SESSION' }
export type AtmVwapSnapshot = { index: string; strike: number; expiry: string; fetchedAt: string; method: 'SESSION_HLC3_VOLUME' | 'BROKER_AVERAGE_PRICE'; referenceIndexPrice: number; message?: string; ce: AtmVwapLeg; pe: AtmVwapLeg }
export async function getAtmVwap(index: string, price: number, signal: AbortSignal): Promise<AtmVwapSnapshot> {
  let token = localStorage.getItem('angelone_jwt_token') || ''
  if (!token) throw new Error('Log in to load ATM option VWAP.')
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch('/api/angelone/atm-vwap', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ index, price }), signal })
    const data = await response.json().catch(() => ({}))
    if (isAngelOneAuthError({ ...data, status: response.status })) { if (attempt === 1) throw new AngelOneSessionExpiredError(); token = await recoverAngelOneSession(token); continue }
    if (!response.ok || data.status === false) throw new Error(data.message || 'ATM option VWAP is unavailable.')
    if (data.index !== index || !['SESSION_HLC3_VOLUME', 'BROKER_AVERAGE_PRICE'].includes(data.method) || !Number.isFinite(data.strike) || data.strike <= 0 || !Number.isFinite(data.referenceIndexPrice) || data.referenceIndexPrice <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(data.expiry) || !Number.isFinite(Date.parse(data.fetchedAt)) || ![data.ce,data.pe].every(leg => leg && typeof leg.symbol === 'string' && typeof leg.token === 'string' && Number.isFinite(leg.volume) && leg.volume >= 0 && ['FULL_SESSION','PARTIAL_SESSION'].includes(leg.coverage) && [leg.close,leg.vwap].every(value=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>0) && (leg.asOf===null||Number.isFinite(Date.parse(leg.asOf))) && (leg.priceAsOf===undefined||leg.priceAsOf===null||Number.isFinite(Date.parse(leg.priceAsOf))))) throw new Error('Invalid ATM VWAP response.')
    return data
  }
  throw new Error('ATM option VWAP unavailable.')
}
export function atmVwapContext(snapshot: AtmVwapSnapshot | undefined, instrument: string, price: number | undefined, now: number): { bias?: 'BULLISH' | 'BEARISH' | 'MIXED'; reason: string } {
  if (!['Nifty 50','Sensex','Bank Nifty'].includes(instrument)) return { reason: 'ATM context is available for Nifty 50, Sensex and Bank Nifty.' }
  if (price === undefined || !Number.isFinite(price) || price <= 0 || !Number.isFinite(now)) return { reason: 'Waiting for a current index price.' }
  if (!snapshot) return { reason: 'Waiting for ATM CE/PE quotes and traded volume.' }
  const step = instrument === 'Nifty 50' ? 50 : 100
  if (snapshot.index !== instrument || snapshot.strike !== Math.round(price / step) * step) return { reason: 'Waiting for quotes at the current index ATM strike.' }
  const expiry = Date.parse(`${snapshot.expiry}T15:30:00+05:30`), fetchedAt = Date.parse(snapshot.fetchedAt)
  if (!Number.isFinite(expiry) || expiry <= now) return { reason: 'Waiting for unexpired ATM contracts.' }
  if (!Number.isFinite(fetchedAt) || now < fetchedAt || now - fetchedAt >= 120_000) return { reason: 'ATM snapshot is stale; waiting for a fresh response.' }
  const session = (time: number) => Math.floor((time + 19_800_000) / 86_400_000)
  const fresh = (time: string | null) => {
    const value = time === null ? NaN : Date.parse(time)
    return Number.isFinite(value) && now >= value && now - value < 120_000 && session(value) === session(now)
  }
  for (const side of ['ce', 'pe'] as const) {
    const leg = snapshot[side], label = side.toUpperCase()
    if (!leg || leg.coverage !== 'FULL_SESSION') return { reason: `${label} session VWAP coverage is incomplete.` }
    if (!Number.isFinite(leg.volume) || leg.volume <= 0) return { reason: `${label} has no reported traded volume.` }
    if (!Number.isFinite(leg.close) || leg.close! <= 0 || !Number.isFinite(leg.vwap) || leg.vwap! <= 0) return { reason: `${label} price or VWAP is unavailable.` }
    if (!fresh(leg.asOf)) return { reason: `${label} VWAP timestamp is missing, stale or from an earlier session.` }
    if (leg.priceAsOf !== undefined && !fresh(leg.priceAsOf)) return { reason: `${label} live price timestamp is missing or stale.` }
  }
  const ce = snapshot.ce.close! - snapshot.ce.vwap!, pe = snapshot.pe.close! - snapshot.pe.vwap!
  const bias = ce > 0 && pe < 0 ? 'BULLISH' : ce < 0 && pe > 0 ? 'BEARISH' : 'MIXED'
  return { bias, reason: bias === 'MIXED' ? 'Current CE/PE prices disagree relative to their VWAPs; neutral VWAP vote.' : `Current ATM CE/PE VWAP supports ${bias.toLowerCase()} direction.` }
}
export function atmVwapBias(snapshot: AtmVwapSnapshot | undefined, instrument: string, price: number | undefined, now: number) {
  return atmVwapContext(snapshot, instrument, price, now).bias
}

// Chart and agent consumers share a request, including across interval changes.
// A consumer unmount must not abort another consumer's broker request.
export const atmVwapRefreshMs = 10_000
const sharedRequests = new Map<string, { until: number; data: AtmVwapSnapshot }>()
const inflight = new Map<string, Promise<AtmVwapSnapshot>>()
export function getSharedAtmVwap(index: string, price: number, now: number): Promise<AtmVwapSnapshot> {
  const step = index === 'Nifty 50' ? 50 : 100
  const key = JSON.stringify([localStorage.getItem('angelone_jwt_token'), index, Math.round(price / step)])
  for (const [key, value] of sharedRequests) if (value.until <= now) sharedRequests.delete(key)
  const saved = sharedRequests.get(key)
  if (saved) return Promise.resolve(saved.data)
  const pending = inflight.get(key)
  if (pending) return pending
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 55_000)
  const task = getAtmVwap(index, price, controller.signal).then(data => {
    sharedRequests.set(key, { until: now + atmVwapRefreshMs, data })
    if (sharedRequests.size > 24) sharedRequests.delete(sharedRequests.keys().next().value!)
    return data
  }).catch(error => {
    if (controller.signal.aborted) throw new Error('ATM quote request timed out. Retrying shortly.')
    throw error
  }).finally(() => { clearTimeout(timeout); inflight.delete(key) })
  inflight.set(key, task)
  return task
}
