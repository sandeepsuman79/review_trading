import { createHash } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { createMarketInputsService } from './marketInputs.js'

export const indexSources = {
  'Nifty 50': { url: 'https://archives.nseindia.com/content/indices/ind_nifty50list.csv', fallbackUrl: 'https://niftyindices.com/IndexConstituent/ind_nifty50list.csv', kind: 'csv', publisher: 'NSE Indices' },
  'Bank Nifty': { url: 'https://archives.nseindia.com/content/indices/ind_niftybanklist.csv', fallbackUrl: 'https://niftyindices.com/IndexConstituent/ind_niftybanklist.csv', kind: 'csv', publisher: 'NSE Indices' },
  Sensex: { url: 'https://www.bseindices.com/AsiaIndexAPI/api/Codewise_Indices/w?code=16', kind: 'json', publisher: 'BSE Indices' },
}
const announcementsUrl = 'https://archives.nseindia.com/content/RSS/Online_announcements.xml'
const ttl = 5 * 60_000
const maxAge = 48 * 60 * 60_000
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true })
const aliases = { 'TATA CONSULTANCY SERVICES': ['TCS'], 'STATE BANK OF INDIA': ['SBI'], 'RELIANCE INDUSTRIES': ['Reliance'], 'LARSEN TOUBRO': ['L&T', 'Larsen & Toubro'], 'MAHINDRA MAHINDRA': ['M&M', 'Mahindra & Mahindra'] }
export const globalWatchlist = [
  { name: 'Microsoft', channel: 'Technology demand' }, { name: 'Nvidia', channel: 'Technology supply and demand' },
  { name: 'Apple', channel: 'Technology supply chains' }, { name: 'JPMorgan', channel: 'Global banking conditions' },
  { name: 'HSBC', channel: 'Global banking conditions' }, { name: 'Saudi Aramco', channel: 'Energy supply' },
  { name: 'Toyota', channel: 'Automotive supply chains' }, { name: 'Samsung', channel: 'Technology supply chains' },
]

function text(value) { return typeof value === 'string' ? value : value?.['#text'] || '' }
function clean(value, length = 240) { return text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length) }
function normalized(value) { return value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim() }
function safeUrl(value) {
  try { const url = new URL(text(value)); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null } catch { return null }
}

export function parseConstituents(raw, kind) {
  let rows
  if (kind === 'json') {
    const data = JSON.parse(raw)
    rows = (data.Table || []).map(row => ({ name: clean(row.SCRIPNAME, 100), symbol: String(row.SCRIP_CODE || ''), sector: clean(row.Industry_name, 100), asOf: row.TransDate || null }))
  } else {
    // Official constituent CSVs use quoted fields (including commas in names).
    const records = []; let row = []; let field = ''; let quoted = false
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i]
      if (char === '"') { if (quoted && raw[i + 1] === '"') { field += '"'; i++ } else quoted = !quoted }
      else if (char === ',' && !quoted) { row.push(field.trim()); field = '' }
      else if (char === '\n' && !quoted) { row.push(field.trim()); records.push(row); row = []; field = '' }
      else if (char !== '\r') field += char
    }
    if (field || row.length) { row.push(field.trim()); records.push(row) }
    const header = records.shift() || []
    if (!header.includes('Company Name') || !header.includes('Symbol')) throw new Error('Constituent source format changed.')
    rows = records.map(record => ({ name: record[header.indexOf('Company Name')], symbol: record[header.indexOf('Symbol')], sector: record[header.indexOf('Industry')] || '', asOf: null }))
  }
  rows = rows.filter(row => row.name && row.symbol)
  if (rows.length < 5 || rows.length > 100) throw new Error('Constituent source returned an incomplete list.')
  return rows
}

export function companyMatches(title, companies) {
  const words = ` ${normalized(title)} `
  return companies.filter(company => {
    const base = normalized(company.name).replace(/\b(LTD|LIMITED|CORPORATION)\b/g, '').replace(/\s+/g, ' ').trim()
    const candidates = [base, ...(aliases[base] || [])]
    if (company.symbol && !/^\d+$/.test(company.symbol)) candidates.push(company.symbol)
    return candidates.some(candidate => candidate.length >= 3 && words.includes(` ${normalized(candidate)} `))
  }).map(company => company.name)
}

export function parseNews(raw, category, now, companies = []) {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true) throw new Error('News source returned invalid XML.')
  const channel = parser.parse(raw)?.rss?.channel
  if (!channel) throw new Error('News source did not return RSS.')
  const items = !channel.item ? [] : Array.isArray(channel.item) ? channel.item : [channel.item]
  const seen = new Set()
  return items.flatMap(item => {
    const title = clean(item.title)
    const url = safeUrl(item.link)
    const published = text(item.pubDate) || text(item['dc:date'])
    // NSE RSS uses exchange-local timestamps without a timezone suffix.
    const publishedTime = Date.parse(category === 'companies' && /^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}$/.test(published) ? `${published} GMT+0530` : published)
    if (!title || !url || !Number.isFinite(publishedTime) || publishedTime > now + 60_000 || now - publishedTime > maxAge) return []
    const description = category === 'companies' ? clean(item.description) : ''
    const signature = normalized(`${title} ${description}`)
    if (seen.has(signature)) return []
    seen.add(signature)
    const matchedCompanies = companyMatches(`${title} ${description}`, companies)
    if ((category === 'companies' || category === 'globalCompanies') && !matchedCompanies.length) return []
    return [{ id: createHash('sha256').update(url + title).digest('hex').slice(0, 16), title, url, publisher: clean(item.source, 100) || (category === 'companies' ? 'NSE corporate announcements' : 'Publisher unavailable'), publishedAt: new Date(publishedTime).toISOString(), category, matchedCompanies, ...(description ? { description } : {}) }]
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 8)
}

function googleNewsUrl(query) {
  const url = new URL('https://news.google.com/rss/search')
  url.search = new URLSearchParams({ q: `${query} when:2d`, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' }).toString()
  return url.href
}

export function createMarketContextService({ fetchFn = fetch, now = Date.now } = {}) {
  const marketInputs = createMarketInputsService({ fetchFn, now })
  const sourceCache = new Map(); const pending = new Map(); const failures = new Map()
  async function source(url, duration, parse) {
    const cached = sourceCache.get(url)
    if (cached && now() - cached.fetchedAt < duration) return { ...cached, stale: false, error: null }
    const failed = failures.get(url)
    if (failed && now() < failed.retryAt) return failed.result
    if (pending.has(url)) return pending.get(url)
    const request = (async () => {
      try {
        const response = await fetchFn(url, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } })
        if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`)
        // Bound the response before parsing, including when Content-Length is absent.
        let raw = ''; let bytes = 0; const decoder = new TextDecoder()
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > 1_000_000) throw new Error('Source response is too large.')
          raw += decoder.decode(chunk, { stream: true })
        }
        raw += decoder.decode()
        const value = { data: parse(raw), fetchedAt: now() }
        sourceCache.set(url, value)
        failures.delete(url)
        return { ...value, stale: false, error: null }
      } catch {
        // Retain an explicit stale snapshot for display; it cannot influence the AI outlook.
        const result = { data: cached?.data || [], fetchedAt: cached?.fetchedAt || null, stale: true, error: 'Public feed unavailable; retry on the next refresh.' }
        failures.set(url, { retryAt: now() + 60_000, result })
        return result
      }
    })()
    pending.set(url, request)
    try { return await request } finally { pending.delete(url) }
  }

  async function getContext(instrument) {
    if (!Object.hasOwn(indexSources, instrument)) throw new Error('Unsupported index.')
    const inputsPromise = marketInputs.getInputs(instrument)
    const config = indexSources[instrument]
    let membershipSourceUrl = config.url
    let membership = await source(config.url, 24 * 60 * 60_000, raw => parseConstituents(raw, config.kind))
    if (membership.stale && config.fallbackUrl) {
      const fallback = await source(config.fallbackUrl, 24 * 60 * 60_000, raw => parseConstituents(raw, config.kind))
      if (!fallback.stale || !membership.data.length && fallback.data.length) { membership = fallback; membershipSourceUrl = config.fallbackUrl }
    }
    const specs = [
      { category: 'india', name: 'Indian market news', url: googleNewsUrl('("India stock market" OR RBI OR "India inflation")') },
      { category: 'global', name: 'Global market news', url: googleNewsUrl('("Federal Reserve" OR "US inflation" OR "crude oil" OR "Asian stocks")') },
      { category: 'companies', name: 'Index company news', url: announcementsUrl },
      { category: 'globalCompanies', name: 'Global company news', url: googleNewsUrl(globalWatchlist.map(company => `"${company.name}"`).join(' OR ')) },
    ]
    const feeds = await Promise.all(specs.map(async spec => {
      // Cache raw RSS by URL: company filtering differs between the selected indices.
      let result = await source(spec.url, ttl, raw => {
        if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true || !parser.parse(raw)?.rss?.channel) throw new Error('Invalid RSS.')
        return raw
      })
      let items = []
      if (typeof result.data === 'string') items = parseNews(result.data, spec.category, now(), spec.category === 'companies' ? membership.stale ? [] : membership.data : globalWatchlist)
      // Announcement feeds can have no constituent filings in their latest window.
      // Use a targeted public news search to cover earnings and company reporting too.
      if (spec.category === 'companies' && !items.length && !membership.stale && membership.data.length) {
        const companyQuery = membership.data.map(company => `"${company.name.replace(/\b(Ltd\.?|Limited)\b/gi, '').trim()}"`).join(' OR ')
        const mediaUrl = googleNewsUrl(companyQuery)
        const media = await source(mediaUrl, ttl, raw => {
          if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true || !parser.parse(raw)?.rss?.channel) throw new Error('Invalid RSS.')
          return raw
        })
        const mediaItems = typeof media.data === 'string' ? parseNews(media.data, spec.category, now(), membership.data) : []
        if (mediaItems.length) { items = mediaItems; result = media; spec.url = mediaUrl }
      }
      return { ...spec, status: result.error ? result.fetchedAt ? 'STALE' : 'UNAVAILABLE' : 'AVAILABLE', fetchedAt: result.fetchedAt ? new Date(result.fetchedAt).toISOString() : null, message: result.error, items }
    }))
    const articles = []; const seen = new Set()
    for (const feed of [...feeds].sort((a, b) => Number(b.category === 'companies') - Number(a.category === 'companies'))) {
      feed.items = feed.items.filter(item => {
        const key = normalized(`${item.title} ${item.description || ''}`)
        if (seen.has(key)) return false
        seen.add(key); articles.push(item); return true
      })
    }
    const inputs = await inputsPromise
    const revision = createHash('sha256').update(JSON.stringify({ instrument, feeds: feeds.map(({ status, items }) => ({ status, items })), companies: membership.data, membershipStale: membership.stale,
      inputs: { ...Object.fromEntries(['openInterest', 'institutional', 'participantPositions', 'giftNifty'].map(key => [key, { status: inputs[key].status, data: inputs[key].data }])), global: inputs.global.map(({ name, status, data }) => ({ name, status, data })) },
    })).digest('hex').slice(0, 20)
    return {
      instrument, revision, retrievedAt: new Date(now()).toISOString(), delayNotice: 'Free public feeds may be delayed. Headlines are evidence to review, not live prices or confirmed company impacts.',
      constituents: { companies: membership.data, sourceUrl: membershipSourceUrl, publisher: config.publisher, fetchedAt: membership.fetchedAt ? new Date(membership.fetchedAt).toISOString() : null, status: membership.error ? membership.fetchedAt ? 'STALE' : 'UNAVAILABLE' : 'AVAILABLE', message: membership.error, weightsAvailable: false },
      globalWatchlist, feeds, articles, inputs,
    }
  }
  return { getContext, getIndiaVix: marketInputs.getIndiaVix }
}

function inputForAi(snapshot, referenceTime, maxAge) {
  if (!snapshot) return null
  const fetched = referenceTime - Date.parse(snapshot.fetchedAt || ''), age = referenceTime - Date.parse(snapshot.data?.asOf || '')
  const current = snapshot.status === 'AVAILABLE' && Number.isFinite(fetched) && fetched >= -60000 && fetched <= 10 * 60000 && Number.isFinite(age) && age >= -60000 && age <= maxAge
  return { status: current ? 'AVAILABLE' : snapshot.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'STALE', sourceUrl: snapshot.sourceUrl, fetchedAt: snapshot.fetchedAt, data: current ? snapshot.data : null }
}

export function sanitizeObservedFlowReports(value, referenceTime) {
  const reports = new Map()
  for (const item of Array.isArray(value) ? value.slice(0, 20) : []) {
    if (!item || item.unit !== 'INR_CRORE' || ![item.fiiCash, item.diiCash, item.netFlow].every(Number.isFinite)) continue
    const timestamp = Date.parse(item.asOf), age = referenceTime - timestamp
    if (!Number.isFinite(age) || age < 0 || age > 14 * 86400000 || Math.abs(item.netFlow - item.fiiCash - item.diiCash) > .02) continue
    reports.set(new Date(timestamp + 330 * 60000).toISOString().slice(0, 10), { asOf: item.asOf, fiiCash: item.fiiCash, diiCash: item.diiCash, netFlow: item.netFlow, unit: 'INR_CRORE' })
  }
  return [...reports.values()].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)).slice(-5)
}

export function contextForAi(context, indiaVix) {
  const availableCategories = context.feeds.filter(feed => feed.status === 'AVAILABLE').map(feed => feed.category)
  const referenceTime = Date.parse(context.retrievedAt)
  const inputs = context.inputs
  return {
    instrument: context.instrument, revision: context.revision, retrievedAt: context.retrievedAt,
    availableCategories, unavailableCategories: context.feeds.filter(feed => feed.status !== 'AVAILABLE').map(feed => feed.category),
    constituentStatus: context.constituents.status, weightsAvailable: false,
    // Stale feed results and stale membership never become current directional evidence.
    articles: context.articles.filter(article => availableCategories.includes(article.category) && (article.category !== 'companies' || context.constituents.status === 'AVAILABLE')).slice(0, 32),
    ...(inputs ? { inputs: {
      openInterest: inputForAi(inputs.openInterest, referenceTime, 30 * 60000),
      institutional: inputForAi(inputs.institutional, referenceTime, 7 * 86400000),
      participantPositions: inputForAi(inputs.participantPositions, referenceTime, 7 * 86400000),
      giftNifty: inputForAi(inputs.giftNifty, referenceTime, 4 * 86400000),
      global: inputs.global.map(quote => ({ name: quote.name, ...inputForAi(quote, referenceTime, 4 * 86400000) })),
    } } : {}),
    ...(indiaVix ? { indiaVix: inputForAi(indiaVix, referenceTime, 30 * 60000) } : {}),
    limitations: ['Headlines only, not full articles or verified earnings surprises.', 'Current constituent weights and constituent price breadth are unavailable; do not invent them.', 'Global company watchlist indicates potential exposure, not established causal relationships.', 'Public feeds may be delayed; market reaction may already be priced in.', 'OI positioning does not establish call/put writing without price changes; max pain and OI walls are reference levels, not guaranteed price targets.', 'FII/DII flows are market-wide daily reports, not live index transactions.', 'India VIX measures volatility, not a guaranteed equity direction.'],
  }
}

export function sanitizeArticleSentiments(value, context) {
  const available = contextForAi(context)
  return (Array.isArray(value) ? value : []).filter((item, index, list) =>
    available.articles.some(article => article.id === item?.articleId)
    && ['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'UNCLEAR'].includes(item?.sentiment)
    && list.findIndex(other => other?.articleId === item.articleId) === index,
  ).slice(0, 32).map(item => {
    const score = item.impactScore
    const validScore = Number.isInteger(score) && (item.sentiment === 'POSITIVE' ? score === 1 || score === 2
      : item.sentiment === 'NEGATIVE' ? score === -1 || score === -2 : item.sentiment === 'NEUTRAL' && score === 0)
    return { articleId: item.articleId, sentiment: item.sentiment,
      ...(validScore ? { impactScore: score } : {}),
      ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 200) } : {}),
    }
  })
}

export function sanitizeMarketOutlook(value, context, chartCurrent = true) {
  const available = contextForAi(context)
  const sentiments = sanitizeArticleSentiments(value?.articleSentiments, context)
  const headlineAssessment = sentiments.length ? { articleSentiments: sentiments } : {}
  const evidenceIds = [...new Set(Array.isArray(value?.evidenceIds) ? value.evidenceIds.filter(id => available.articles.some(article => article.id === id)).slice(0, 6) : [])]
  const validBias = ['BULLISH', 'BEARISH', 'MIXED', 'NEUTRAL'].includes(value?.bias)
  if (!chartCurrent || !available.articles.length || !validBias || !evidenceIds.length || value?.agreement === 'INSUFFICIENT') {
    return { bias: 'UNAVAILABLE', agreement: 'INSUFFICIENT', summary: !chartCurrent ? 'The chart is historical. Awaiting recent completed candles for a combined outlook.' : 'Not enough current, cited evidence for a combined outlook.', evidenceIds: [], ...headlineAssessment, contextRevision: context.revision, contextRetrievedAt: context.retrievedAt }
  }
  return {
    bias: value.bias,
    agreement: ['SUPPORTS_CHART', 'CONFLICTS_WITH_CHART', 'MIXED', 'INSUFFICIENT'].includes(value.agreement) ? value.agreement : 'INSUFFICIENT',
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 500) : '', evidenceIds,
    ...headlineAssessment,
    contextRevision: context.revision, contextRetrievedAt: context.retrievedAt,
  }
}
