import { readFileSync } from 'node:fs'

const ttl = 5 * 60_000
const nse = 'https://www.nseindia.com'
const flowUrl = `${nse}/api/fiidiiTradeReact`
const symbols = { 'Nifty 50': 'NIFTY', 'Bank Nifty': 'BANKNIFTY' }
const globalSpecs = JSON.parse(readFileSync(new URL('../src/data/globalMarkets.json', import.meta.url), 'utf8')).filter(spec => spec.provider === 'yahoo')

function number(value) {
  if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function exchangeDate(value) {
  const numeric = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value || '')
  const timestamp = Date.parse(numeric ? `${numeric[3]}-${numeric[2]}-${numeric[1]}T00:00:00+05:30` : `${value} GMT+0530`)
  return Number.isFinite(timestamp) ? timestamp : NaN
}

export function parseInstitutionalFlows(raw, now) {
  const rows = JSON.parse(raw)
  if (!Array.isArray(rows)) throw new Error('Invalid institutional report.')
  const fii = rows.find(row => /^FII(?:\/FPI)?$/i.test(row.category))
  const dii = rows.find(row => row.category === 'DII')
  const asOf = exchangeDate(fii?.date)
  if (!fii || !dii || fii.date !== dii.date || !Number.isFinite(asOf) || asOf > now || now - asOf > 7 * 86_400_000) throw new Error('Institutional report is missing or out of date.')
  const fiiCash = number(fii.netValue), diiCash = number(dii.netValue)
  if (fiiCash === null || diiCash === null) throw new Error('Institutional net flows are missing.')
  if (!Number.isFinite(fiiCash + diiCash)) throw new Error('Invalid institutional totals.')
  return { asOf: new Date(asOf).toISOString(), fiiCash, diiCash, netFlow: fiiCash + diiCash, unit: 'INR_CRORE' }
}

export function parseParticipantPositions(raw) {
  const lines = raw.trim().split(/\r?\n/)
  const headerIndex = lines.findIndex(line => line.startsWith('Client Type,'))
  if (headerIndex < 0) throw new Error('Invalid participant report.')
  const header = lines[headerIndex].split(',').map(value => value.trim())
  const fii = lines.slice(headerIndex + 1).map(line => line.split(',').map(value => value.trim())).find(row => row[0] === 'FII')
  const long = number(fii?.[header.indexOf('Future Index Long')]), short = number(fii?.[header.indexOf('Future Index Short')])
  if (long === null || short === null || long < 0 || short < 0 || long + short <= 0) throw new Error('FII index positions are missing.')
  return { longPercent: long / (long + short) * 100, shortPercent: short / (long + short) * 100 }
}

export function parseOptionChain(raw, expiry, symbol, now) {
  const records = JSON.parse(raw)?.records
  const asOf = exchangeDate(records?.timestamp)
  if (!Number.isFinite(asOf) || asOf > now + 60_000 || now - asOf > 4 * 86_400_000) throw new Error('Option-chain snapshot is missing or out of date.')
  const requestedExpiry = exchangeDate(expiry)
  const rows = (Array.isArray(records?.data) ? records.data : []).filter(row =>
    exchangeDate(row.expiryDates || row.expiryDate || row.CE?.expiryDate || row.PE?.expiryDate) === requestedExpiry,
  ).map(row => {
    const strike = number(row.strikePrice)
    for (const leg of [row.CE, row.PE].filter(Boolean)) {
      if (leg.underlying !== symbol || exchangeDate(leg.expiryDate) !== requestedExpiry) throw new Error('Mixed contracts in option-chain response.')
    }
    return { strike, call: row.CE ? number(row.CE.openInterest) : 0, put: row.PE ? number(row.PE.openInterest) : 0, callChange: row.CE ? number(row.CE.changeinOpenInterest) : 0, putChange: row.PE ? number(row.PE.changeinOpenInterest) : 0 }
  }).sort((a, b) => a.strike - b.strike)
  if (rows.length < 2 || rows.length > 1_000 || rows.some(row => row.strike === null || row.strike <= 0 || row.call === null || row.put === null || row.call < 0 || row.put < 0) || new Set(rows.map(row => row.strike)).size !== rows.length) throw new Error('Option-chain response is incomplete.')
  const callOi = rows.reduce((sum, row) => sum + row.call, 0), putOi = rows.reduce((sum, row) => sum + row.put, 0)
  if (callOi <= 0 || putOi <= 0) throw new Error('No usable option open interest.')
  const wall = key => rows.reduce((best, row) => row[key] > best[key] ? row : best).strike
  // Max pain is the strike with the smallest combined intrinsic payout, in OI contracts.
  let maxPain = rows[0].strike, minimum = Infinity
  for (const candidate of rows) {
    const payout = rows.reduce((sum, row) => sum + Math.max(0, candidate.strike - row.strike) * row.call + Math.max(0, row.strike - candidate.strike) * row.put, 0)
    if (payout < minimum) { minimum = payout; maxPain = candidate.strike }
  }
  return { asOf: new Date(asOf).toISOString(), expiry, symbol, pcr: putOi / callOi, callWall: wall('call'), putWall: wall('put'), maxPain, callOi, putOi, callOiChange: rows.every(row => row.callChange !== null) ? rows.reduce((sum, row) => sum + row.callChange, 0) : null, putOiChange: rows.every(row => row.putChange !== null) ? rows.reduce((sum, row) => sum + row.putChange, 0) : null, unit: 'CONTRACTS' }
}

export function parseGlobalQuote(raw, symbol, now) {
  const result = JSON.parse(raw)?.chart?.result?.[0], meta = result?.meta
  const price = number(meta?.regularMarketPrice), timestamp = number(meta?.regularMarketTime)
  if (meta?.symbol !== symbol || price === null || price <= 0 || timestamp === null || timestamp * 1000 > now + 60_000 || now - timestamp * 1000 > 7 * 86_400_000) throw new Error('Global quote is missing or out of date.')
  let previous = number(meta.previousClose)
  if (previous === null && typeof meta.exchangeTimezoneName === 'string') {
    const dates = result.timestamp || [], closes = result.indicators?.quote?.[0]?.close || []
    const session = new Intl.DateTimeFormat('en-CA', { timeZone: meta.exchangeTimezoneName }).format(new Date(timestamp * 1000))
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] < timestamp && new Intl.DateTimeFormat('en-CA', { timeZone: meta.exchangeTimezoneName }).format(new Date(dates[i] * 1000)) !== session && number(closes[i]) > 0) { previous = number(closes[i]); break }
    }
  }
  let changePercent = number(meta.regularMarketChangePercent)
  if (changePercent === null) {
    if (previous === null || previous <= 0) throw new Error('Previous session close unavailable.')
    changePercent = (price - previous) / previous * 100
  }
  const change = previous !== null && previous > 0 ? price - previous : null
  return { symbol, price, changePercent, change, asOf: new Date(timestamp * 1000).toISOString() }
}

export function parseGiftNifty(raw, now) {
  const quote = JSON.parse(raw)?.giftnifty
  const price = number(quote?.LASTPRICE), changePercent = number(quote?.PERCHANGE), change = number(quote?.DAYCHANGE)
  const asOf = exchangeDate(quote?.TIMESTMP), expiry = exchangeDate(quote?.EXPIRYDATE)
  if (quote?.SYMBOL !== 'NIFTY' || quote.INSTRUMENTTYPE !== 'FUTIDX' || price === null || price <= 0 || changePercent === null || !Number.isFinite(asOf) || asOf > now + 60_000 || now - asOf > 4 * 86_400_000 || !Number.isFinite(expiry) || expiry + 86_400_000 < asOf) throw new Error('GIFT Nifty futures quote is missing or out of date.')
  return { symbol: 'GIFT_NIFTY', price, changePercent, change, expiry: quote.EXPIRYDATE, asOf: new Date(asOf).toISOString() }
}

export function parseIndiaVix(raw, now) {
  const payload = JSON.parse(raw)
  const quote = Array.isArray(payload.data) ? payload.data.find(row => row.index === 'INDIA VIX' || row.indexSymbol === 'INDIA VIX') : null
  const price = number(quote?.last), changePercent = number(quote?.percentChange)
  const asOf = exchangeDate(payload.timestamp)
  if (price === null || price <= 0 || changePercent === null || !Number.isFinite(asOf) || asOf > now + 60_000 || now - asOf > 7 * 86_400_000) throw new Error('India VIX quote is missing or out of date.')
  return { symbol: '^INDIAVIX', price, changePercent, change: number(quote.variation), asOf: new Date(asOf).toISOString() }
}

export function createMarketInputsService({ fetchFn = fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map()
  async function source(url, sourceUrl, parse) {
    const cached = cache.get(url)
    if (cached && now() < cached.retryAt) return cached.snapshot
    if (pending.has(url)) return pending.get(url)
    const request = (async () => {
      let snapshot
      try {
        const response = await fetchFn(url, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/csv,*/*', Referer: `${nse}/option-chain` } })
        if (!response.ok) throw new Error('Source unavailable.')
        let raw = '', bytes = 0
        const decoder = new TextDecoder()
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > 2_000_000) throw new Error('Source response too large.')
          raw += decoder.decode(chunk, { stream: true })
        }
        raw += decoder.decode()
        snapshot = { status: 'AVAILABLE', sourceUrl, fetchedAt: new Date(now()).toISOString(), message: null, data: parse(raw) }
      } catch {
        snapshot = { status: cached?.snapshot.data ? 'STALE' : 'UNAVAILABLE', sourceUrl, fetchedAt: cached?.snapshot.fetchedAt || null, message: 'Public source unavailable. Retrying on the next refresh.', data: cached?.snapshot.data || null }
      }
      cache.set(url, { snapshot, retryAt: now() + (snapshot.status === 'AVAILABLE' ? ttl : 60_000) })
      while (cache.size > 128) cache.delete(cache.keys().next().value)
      return snapshot
    })()
    pending.set(url, request)
    try { return await request } finally { pending.delete(url) }
  }

  async function openInterest(instrument) {
    const symbol = symbols[instrument], sourceUrl = `${nse}/option-chain`
    if (!symbol) return { status: 'UNAVAILABLE', fetchedAt: null, sourceUrl: 'https://www.bseindia.com/markets/Derivatives/DeriReports/DeriOptionchain.html', data: null, message: 'A Sensex option-chain source is not connected.' }
    const contracts = await source(`${nse}/api/option-chain-contract-info?symbol=${symbol}`, sourceUrl, raw => {
      const expiry = JSON.parse(raw)?.expiryDates?.filter(date => exchangeDate(date) + 86_400_000 > now()).sort((a, b) => exchangeDate(a) - exchangeDate(b))[0]
      if (!expiry) throw new Error('No current expiry.')
      return { expiry }
    })
    if (contracts.status !== 'AVAILABLE') return { ...contracts, data: null }
    const expiry = contracts.data.expiry
    return source(`${nse}/api/option-chain-v3?type=Indices&symbol=${symbol}&expiry=${encodeURIComponent(expiry)}`, sourceUrl, raw => parseOptionChain(raw, expiry, symbol, now()))
  }

  async function institutional() {
    const flows = await source(flowUrl, `${nse}/reports/fii-dii`, raw => parseInstitutionalFlows(raw, now()))
    if (!flows.data) return { flows, positions: { status: 'UNAVAILABLE', sourceUrl: `${nse}/all-reports-derivatives`, fetchedAt: null, message: 'A dated participant report is not available.', data: null } }
    const date = new Date(Date.parse(flows.data.asOf) + 330 * 60_000)
    const reportDate = `${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCMonth() + 1).padStart(2, '0')}${date.getUTCFullYear()}`
    const url = `https://archives.nseindia.com/content/nsccl/fao_participant_oi_${reportDate}.csv`
    const positions = await source(url, url, raw => ({ ...parseParticipantPositions(raw), asOf: flows.data.asOf }))
    return { flows, positions }
  }

  async function getInputs(instrument) {
    const [oi, flows, global, giftNifty] = await Promise.all([
      openInterest(instrument), institutional(),
      Promise.all(globalSpecs.map(async spec => ({ name: spec.name, ...await source(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.symbol)}?interval=1d&range=5d`, `https://finance.yahoo.com/quote/${encodeURIComponent(spec.symbol)}/`, raw => parseGlobalQuote(raw, spec.symbol, now())) }))),
      source(`${nse}/api/marketStatus`, 'https://www.nseix.com/', raw => parseGiftNifty(raw, now())),
    ])
    return { openInterest: oi, institutional: flows.flows, participantPositions: flows.positions, global, giftNifty }
  }
  async function getIndiaVix() {
    const primary = await source(`${nse}/api/allIndices`, 'https://www.nseindia.com/static/products-services/indices-indiavix-index', raw => parseIndiaVix(raw, now()))
    if (primary.status === 'AVAILABLE') return primary
    const fallback = await source('https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1d&range=5d', 'https://finance.yahoo.com/quote/%5EINDIAVIX/', raw => parseGlobalQuote(raw, '^INDIAVIX', now()))
    return fallback.status === 'AVAILABLE' ? fallback : primary.data ? primary : fallback
  }
  return { getInputs, getIndiaVix }
}
