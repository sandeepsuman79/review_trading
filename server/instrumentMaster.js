import { nearestIndexOptions } from './optionPremiums.js'
import { commodityInstruments } from './commodityInstruments.js'

export const fallbackIndices = [
  { token: '99926000', name: 'Nifty 50', symbol: 'Nifty 50', exch_seg: 'NSE' },
  { token: '99919000', name: 'Sensex', symbol: 'SENSEX', exch_seg: 'BSE' },
  { token: '99926009', name: 'Bank Nifty', symbol: 'Nifty Bank', exch_seg: 'NSE' },
]
const masterUrl = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json'
/** One download across all consumers. Persist only compact, credential-free metadata. */
export function createInstrumentMasterService({ fetchImpl = fetch, now = Date.now, readCache = async () => null, saveCache = async () => {}, ttlMs = 6 * 3600000 } = {}) {
  let cache, pending, failures = 0, retryAt = 0, initialized
  const valid = value => value && Number.isFinite(value.fetchedAt) && value.fetchedAt <= now() && Array.isArray(value.indices) && value.indices.length >= 3 && value.indices.every(item => typeof item?.token === 'string' && typeof item?.symbol === 'string' && typeof item?.exch_seg === 'string')
    && Array.isArray(value.commodities) && value.commodities.every(item => typeof item?.token === 'string' && typeof item?.symbol === 'string') && value.options && typeof value.options === 'object'
  const initialize = () => initialized ||= (async () => { try { const saved = await readCache(); if (valid(saved)) cache = saved } catch { /* A cold-start download can recover a missing cache. */ } })()
  const optionsCurrent = () => cache && Object.values(cache.options).some(group => group?.expiryAt > now() && Array.isArray(group.contracts) && group.contracts.length)
  async function refresh(force = false, full = false) {
    await initialize()
    if (!force && cache && now() - cache.fetchedAt < ttlMs) return
    if (force && !full && cache && now() - cache.fetchedAt < 60000) return
    if (pending) return pending
    if (now() < retryAt) throw Object.assign(new Error('Instrument metadata refresh is cooling down.'), { status: 503, retryAfterMs: retryAt - now() })
    pending = (async () => {
      try {
        const response = await fetchImpl(masterUrl, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error('Instrument source unavailable')
        const raw = await response.json()
        if (!Array.isArray(raw) || !raw.length || raw.some(item => !item || typeof item !== 'object')) throw new Error('Invalid instrument metadata')
        const options = nearestIndexOptions(raw, now()), commodities = commodityInstruments(raw)
        const actualIndices = raw.filter(item => fallbackIndices.some(index => index.token === String(item.token)) || /INDIAVIX/i.test(`${item.name} ${item.symbol}`.replace(/[^a-z0-9]/gi, '')))
        if (!actualIndices.length && !commodities.length && !Object.values(options).some(group => group.contracts.length)) throw new Error('Empty instrument metadata')
        const indices = [...fallbackIndices.map(index => actualIndices.find(item => String(item.token) === index.token) || index), ...actualIndices.filter(item => !fallbackIndices.some(index => index.token === String(item.token)))].map(item => {
          const name = fallbackIndices.find(index => index.token === String(item.token))?.name, group = options[name]
          const { token, symbol, name: brokerName, exch_seg, instrumenttype, expiry, lotsize, tick_size } = item
          return { token: String(token), symbol, name: brokerName, exch_seg, instrumenttype, expiry, lotsize, tick_size, ...(group?.contracts.length ? { optionExpiry: new Date(group.expiryAt).toISOString().slice(0,10) } : {}) }
        })
        cache = { fetchedAt: now(), indices, commodities, options }; failures = 0; retryAt = 0
        try { await saveCache(cache) } catch { /* In-memory metadata remains usable on ephemeral/read-only hosts. */ }
        return raw
      } catch {
        failures++; retryAt = now() + Math.min(300000, 15000 * 2 ** Math.min(failures - 1, 5))
        throw Object.assign(new Error('Instrument source is temporarily unavailable. Cached metadata is used where available.'), { status: 503, retryAfterMs: retryAt - now() })
      }
    })().finally(() => { pending = undefined })
    return pending
  }
  return {
    async get(scope = 'all') {
      let raw
      try { raw = await refresh(scope === 'all', scope === 'all') } catch (error) { if (!cache && scope !== 'indices') throw error }
      if (scope === 'indices') return { data: (cache?.indices ?? fallbackIndices).map(item => {
        if (!item.optionExpiry || Date.parse(`${item.optionExpiry}T15:30:00+05:30`) > now()) return item
        const current = { ...item }; delete current.optionExpiry; return current
      }), status: !cache ? 'FALLBACK' : retryAt > now() ? 'CACHED' : 'CURRENT', retryAfterMs: Math.max(0, retryAt - now()) }
      if (scope === 'commodities' && cache?.commodities.length) return { data: cache.commodities, status: retryAt > now() ? 'CACHED' : 'CURRENT', retryAfterMs: Math.max(0, retryAt - now()) }
      if (scope === 'all' && raw) return { data: raw, status: 'CURRENT', retryAfterMs: 0 }
      throw Object.assign(new Error('Current contract metadata is unavailable. Please retry shortly.'), { status: 503, retryAfterMs: Math.max(15000, retryAt - now()) })
    },
    async getOptions(index) {
      try { await refresh(!optionsCurrent() || !cache?.options[index]?.contracts.length || cache.options[index].expiryAt <= now()) } catch (error) { if (!cache?.options[index] || cache.options[index].expiryAt <= now()) throw error }
      // Never substitute an expired token even when a cached master is available.
      const group = cache?.options[index]
      if (!group?.contracts.length || group.expiryAt <= now()) throw Object.assign(new Error('Current unexpired option contracts are unavailable. Retrying metadata shortly.'), { status: 503, retryAfterMs: Math.max(15000, retryAt - now()) })
      return { [index]: group }
    },
  }
}
