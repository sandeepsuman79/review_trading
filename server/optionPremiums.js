import { createHash } from 'node:crypto'

export const optionIndices = { 'Nifty 50': { root: 'NIFTY', exchange: 'NFO', step: 50 }, 'Bank Nifty': { root: 'BANKNIFTY', exchange: 'NFO', step: 100 }, Sensex: { root: 'SENSEX', exchange: 'BFO', step: 100 } }
const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
function expiryTime(value) {
  const match = /^(\d{1,2})[- ]?([A-Z]{3})[- ]?(\d{4})$/i.exec(String(value))
  if (!match || !months.includes(match[2].toUpperCase())) return NaN
  const day = Number(match[1]), month = months.indexOf(match[2].toUpperCase()), year = Number(match[3])
  const time = Date.UTC(year, month, day, 10, 0) // 15:30 IST
  const date = new Date(time)
  return date.getUTCDate() === day && date.getUTCMonth() === month ? time : NaN
}

/** Retain only nearest-expiry index options; SmartAPI master strikes are in paise. */
export function nearestIndexOptions(master, now) {
  const result = Object.fromEntries(Object.keys(optionIndices).map(name => [name, { expiryAt: Infinity, contracts: [] }]))
  for (const item of master) {
    const entry = Object.entries(optionIndices).find(([, index]) => index.root === item.name && index.exchange === item.exch_seg)
    if (!entry || item.instrumenttype !== 'OPTIDX' || !/^\d+$/.test(String(item.token)) || !/(CE|PE)$/.test(String(item.symbol))) continue
    const [name, index] = entry, strike = Number(item.strike) / 100, expiryAt = expiryTime(item.expiry)
    if (!Number.isFinite(strike) || strike <= 0 || strike % index.step !== 0 || !Number.isFinite(expiryAt) || expiryAt <= now) continue
    const group = result[name]
    if (expiryAt < group.expiryAt) { group.expiryAt = expiryAt; group.contracts = [] }
    if (expiryAt === group.expiryAt) group.contracts.push({ strike, side: item.symbol.endsWith('CE') ? 'ce' : 'pe', token: String(item.token), symbol: item.symbol, exchange: index.exchange })
  }
  return result
}

export function validateOptionRequest(input) {
  const index = optionIndices[input?.index]
  if (!index || !Array.isArray(input.strikes) || input.strikes.length < 1 || input.strikes.length > 25 || new Set(input.strikes).size !== input.strikes.length || input.strikes.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000 || value % index.step !== 0)) {
    throw Object.assign(new Error('Select an index and up to 25 unique strikes at its 50/100-point interval.'), { status: 400 })
  }
  return { index: input.index, strikes: [...input.strikes].sort((a, b) => a - b) }
}

export function createOptionPremiumService({ loadOptions, fetcher = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), spacing = 1000 }) {
  const cache = new Map(), pending = new Map()
  let queue = Promise.resolve(), nextRequestAt = 0, cooldownUntil = 0
  async function run(input, headers) {
    const options = (await loadOptions(input.index))[input.index]
    if (!options || !options.contracts.length || options.expiryAt <= now()) throw Object.assign(new Error('No unexpired option contracts are available for this index.'), { status: 503 })
    const contracts = options.contracts.filter(contract => input.strikes.includes(contract.strike))
    const tokens = Object.fromEntries([...new Set(contracts.map(contract => contract.exchange))].map(exchange => [exchange, [...new Set(contracts.filter(contract => contract.exchange === exchange).map(contract => contract.token))]]))
    if (Object.values(tokens).flat().length > 50) throw Object.assign(new Error('Too many contracts for one quote request.'), { status: 400 })
    let fetched = [], unfetched = []
    if (contracts.length) {
      if (now() < cooldownUntil) throw Object.assign(new Error('Option quote rate limit reached. Please retry shortly.'), { status: 429 })
      const pause = nextRequestAt - now()
      if (pause > 0) await sleep(pause)
      nextRequestAt = now() + spacing
      const response = await fetcher('https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/', { method: 'POST', headers, body: JSON.stringify({ mode: 'LTP', exchangeTokens: tokens }), signal: AbortSignal.timeout(20_000) })
      const body = await response.json()
      const errorcode = String(body.errorcode || body.errorCode || '').toUpperCase()
      const authError = response.status === 401 || ['AG8001', 'AG8002', 'AG8003'].includes(errorcode) || /(?:invalid|expired|missing)\s+(?:access\s+|jwt\s+)?token|token\s+(?:expired|missing)/i.test(body.message || '')
      if (!authError && (response.status === 429 || /rate limit|access rate|too many|exceed.*rate/i.test(body.message ?? ''))) cooldownUntil = now() + 15_000
      if (authError || !response.ok || body.status === false || body.success === false || !Array.isArray(body.data?.fetched)) throw Object.assign(new Error(body.message || 'Angel One option quotes are unavailable.'), { errorcode, status: authError ? 401 : response.status === 403 ? 403 : cooldownUntil > now() ? 429 : 502 })
      fetched = body.data.fetched; unfetched = body.data.unfetched ?? []
    }
    if (options.expiryAt <= now()) throw Object.assign(new Error('The option contract expired while quotes were loading. Please refresh.'), { status: 503 })
    const receivedAt = new Date(now()).toISOString()
    const rows = input.strikes.map(strike => {
      const row = { strike }
      for (const side of ['ce', 'pe']) {
        const contract = contracts.find(contract => contract.strike === strike && contract.side === side)
        if (!contract) { row[side] = { ltp: null, message: 'Contract unavailable at this strike / expiry' }; continue }
        const quote = fetched.find(quote => quote.exchange === contract.exchange && String(quote.symbolToken) === contract.token && (!quote.tradingSymbol || quote.tradingSymbol === contract.symbol))
        const value = quote?.ltp
        const ltp = (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null
        row[side] = { ...contract, ltp, receivedAt: ltp === null ? null : receivedAt, message: ltp === null ? unfetched.find(quote => quote.exchange === contract.exchange && String(quote.symbolToken) === contract.token)?.message || 'Quote unavailable' : null }
      }
      return row
    })
    return { index: input.index, expiry: new Date(options.expiryAt).toISOString().slice(0, 10), fetchedAt: receivedAt, timeBasis: 'RECEIVED', rows }
  }
  return { async get(raw, headers) {
    const input = validateOptionRequest(raw), key = createHash('sha256').update(`${headers.Authorization}:${input.index}:${input.strikes.join(',')}`).digest('hex')
    const previous = cache.get(key)
    if (previous?.until > now()) return previous.data
    if (pending.has(key)) return pending.get(key)
    if (pending.size >= 20) throw Object.assign(new Error('Option quote requests are busy. Please retry shortly.'), { status: 429 })
    const job = queue.then(() => run(input, headers))
    queue = job.catch(() => {})
    const task = job.then(data => {
      if (data.rows.some(row => row.ce.ltp !== null || row.pe.ltp !== null)) {
        cache.set(key, { until: Math.min(now() + 10_000, Date.parse(`${data.expiry}T15:30:00+05:30`)), data })
        if (cache.size > 80) cache.delete(cache.keys().next().value)
      }
      return data
    }).finally(() => pending.delete(key))
    pending.set(key, task)
    return task
  } }
}
