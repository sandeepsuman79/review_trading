import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMarketContextService, parseConstituents, parseNews, companyMatches, contextForAi, sanitizeMarketOutlook, sanitizeObservedFlowReports } from '../server/marketContext.js'

const initialNow = Date.parse('2026-10-11T10:00:00Z')
const csv = 'Company Name,Industry,Symbol,Series,ISIN Code\n"HDFC Bank Ltd.",Financial Services,HDFCBANK,EQ,IN1\nTata Consultancy Services Ltd.,IT,TCS,EQ,IN2\nState Bank of India,Financial Services,SBIN,EQ,IN3\nReliance Industries Ltd.,Energy,RELIANCE,EQ,IN4\n"Example, Industries Ltd.",Manufacturing,EXAMPLE,EQ,IN5\n'
const rss = (items = [], title = 'Fixture feed') => `<rss version="2.0"><channel><title>${title}</title>${items.map(item => `<item><title><![CDATA[${item.title}]]></title><link>${item.url || 'https://publisher.example/' + encodeURIComponent(item.title)}</link><pubDate>${new Date(item.time ?? initialNow - 60_000).toUTCString()}</pubDate><source>Fixture publisher</source></item>`).join('')}</channel></rss>`

function fixtureService() {
  let now = initialNow; let fail = false; let calls = 0; let revision = 0
  const service = createMarketContextService({ now: () => now, fetchFn: async url => {
    calls++
    if (fail) throw new Error('fixture outage')
    if (url.includes('/api/marketStatus')) return new Response(JSON.stringify({ giftnifty: { SYMBOL: 'NIFTY', INSTRUMENTTYPE: 'FUTIDX', LASTPRICE: 22420, PERCHANGE: .22, DAYCHANGE: 49.5, EXPIRYDATE: '27-Oct-2026', TIMESTMP: '11-Oct-2026 15:00' } }))
    if (url.includes('fiidiiTradeReact')) return new Response(JSON.stringify([{ category: 'FII/FPI', date: '11-Oct-2026', netValue: '-100' }, { category: 'DII', date: '11-Oct-2026', netValue: '80' }]))
    if (url.includes('fao_participant_oi_')) return new Response('Client Type,Future Index Long,Future Index Short\nFII,20,80\n')
    if (url.includes('option-chain-contract-info')) return new Response(JSON.stringify({ expiryDates: ['12-Oct-2026'] }))
    if (url.includes('option-chain-v3')) return new Response(JSON.stringify({ records: { timestamp: '11-Oct-2026 15:00:00', data: [22000, 22100, 22200].map(strikePrice => ({ strikePrice, expiryDates: '12-Oct-2026', CE: { expiryDate: '12-Oct-2026', underlying: 'NIFTY', openInterest: 10, changeinOpenInterest: 2 }, PE: { expiryDate: '12-Oct-2026', underlying: 'NIFTY', openInterest: 20, changeinOpenInterest: 3 } })) } }))
    if (url.includes('finance.yahoo.com/v8/finance/chart/')) return new Response(JSON.stringify({ chart: { result: [{ meta: { symbol: decodeURIComponent(new URL(url).pathname.split('/').at(-1)), regularMarketPrice: 100, regularMarketTime: Math.floor(now / 1000), regularMarketChangePercent: -.2 } }] } }))
    if (url.includes('IndexConstituent') || url.includes('/content/indices/')) return new Response(csv)
    if (url.includes('Codewise_Indices')) return new Response(JSON.stringify({ Table: Array.from({ length: 30 }, (_, i) => ({ SCRIPNAME: `Bank ${i} Ltd.`, SCRIP_CODE: String(100 + i), Industry_name: 'Financial Services', TransDate: '2026-09-30T00:00:00' })) }))
    if (url.includes('Online_announcements')) return new Response(rss([{ title: 'HDFC Bank earnings announcement' }]))
    const query = new URL(url).searchParams.get('q')
    const title = query.includes('Microsoft') ? `Microsoft earnings ${revision}` : query.includes('Federal Reserve') ? `Federal Reserve policy ${revision}` : `Indian market update ${revision}`
    return new Response(rss([{ title }]))
  } })
  return { service, calls: () => calls, fail: () => { fail = true }, advance: () => { now += 301_000; revision++ } }
}

test('official CSV and Sensex responses preserve real membership without inventing weights', () => {
  const companies = parseConstituents(csv, 'csv')
  assert.equal(companies.length, 5)
  assert.equal(companies.at(-1).name, 'Example, Industries Ltd.')
  assert.equal(companies[0].symbol, 'HDFCBANK')
  assert.throws(() => parseConstituents('<html>blocked</html>', 'csv'))
  assert.throws(() => parseConstituents('{"Table":[]}', 'json'))
})

test('RSS excludes stale/future headlines, invalid links and duplicate coverage', () => {
  const raw = rss([{ title: 'Fresh event' }, { title: 'Fresh event' }, { title: 'Old event', time: initialNow - 49 * 3600000 }, { title: 'Future event', time: initialNow + 120000 }, { title: 'Bad link', url: 'javascript:alert(1)' }])
  const articles = parseNews(raw, 'india', initialNow)
  assert.equal(articles.length, 1)
  assert.equal(articles[0].publisher, 'Fixture publisher')
  assert.equal(articles[0].title, 'Fresh event')
  assert.throws(() => parseNews('<!DOCTYPE rss><rss/>', 'india', initialNow))
  assert.throws(() => parseNews('<html>Not a feed</html>', 'india', initialNow))
})

test('company headlines must match current constituents, with bounded aliases', () => {
  const companies = parseConstituents(csv, 'csv')
  assert.deepEqual(companyMatches('TCS wins contract and SBI reports results', companies), ['Tata Consultancy Services Ltd.', 'State Bank of India'])
  assert.deepEqual(companyMatches('SuperTCS and nonSBIN are unrelated', companies), [])
  assert.equal(parseNews(rss([{ title: 'HDFC Bank reports results' }, { title: 'Unlisted startup reports results' }]), 'companies', initialNow, companies).length, 1)
})

test('public feeds share concurrent requests, cache results and isolate index membership', async () => {
  const fixture = fixtureService()
  const [first, again, sensex] = await Promise.all([fixture.service.getContext('Nifty 50'), fixture.service.getContext('Nifty 50'), fixture.service.getContext('Sensex')])
  assert.equal(first.constituents.companies.length, 5)
  assert.equal(sensex.constituents.companies.length, 30)
  assert.equal(sensex.feeds.find(f => f.category === 'companies').items.length, 0)
  assert.equal(first.constituents.weightsAvailable, false)
  assert.equal(first.revision, again.revision)
  const before = fixture.calls()
  await fixture.service.getContext('Nifty 50')
  assert.equal(fixture.calls(), before)
  assert.equal(before, 22)
  assert.equal(first.inputs.institutional.data.netFlow, -20)
  assert.equal(first.inputs.openInterest.data.pcr, 2)
  assert.equal(sensex.inputs.openInterest.status, 'UNAVAILABLE')
  await assert.rejects(() => fixture.service.getContext('Unknown index'))
})

test('failed initial feeds produce missing evidence rather than fabricated neutral signals', async () => {
  const fixture = fixtureService(); fixture.fail()
  const context = await fixture.service.getContext('Bank Nifty')
  assert.ok(context.feeds.every(feed => feed.status === 'UNAVAILABLE'))
  assert.equal(context.articles.length, 0)
  assert.equal(context.constituents.status, 'UNAVAILABLE')
  assert.equal(sanitizeMarketOutlook({ bias: 'BULLISH', evidenceIds: ['invented'] }, context).bias, 'UNAVAILABLE')
})

test('outages retain timestamped stale items for display and remove them from AI evidence', async () => {
  const fixture = fixtureService(); const original = await fixture.service.getContext('Nifty 50')
  fixture.advance(); fixture.fail()
  const context = await fixture.service.getContext('Nifty 50')
  assert.ok(context.feeds.every(feed => feed.status === 'STALE'))
  assert.ok(context.articles.length > 0)
  assert.equal(context.feeds[0].fetchedAt, original.feeds[0].fetchedAt)
  assert.equal(contextForAi(context).articles.length, 0)
  assert.notEqual(context.revision, original.revision)
})

test('new evidence after the cache expires changes the revision used to refresh the agent', async () => {
  const fixture = fixtureService(); const original = await fixture.service.getContext('Nifty 50')
  fixture.advance()
  const fresh = await fixture.service.getContext('Nifty 50')
  assert.notEqual(fresh.revision, original.revision)
  assert.ok(fresh.feeds.every(feed => feed.status === 'AVAILABLE'))
})

test('combined outlook rejects invented citations and historical chart signals', async () => {
  const { service } = fixtureService(); const context = await service.getContext('Nifty 50')
  const value = { bias: 'BULLISH', agreement: 'SUPPORTS_CHART', summary: 'Evidence supports the chart.', evidenceIds: [context.articles[0].id, 'invented'] }
  const result = sanitizeMarketOutlook(value, context)
  assert.equal(result.bias, 'BULLISH')
  assert.deepEqual(result.evidenceIds, [context.articles[0].id])
  assert.equal(result.contextRevision, context.revision)
  assert.equal(sanitizeMarketOutlook(value, context, false).bias, 'UNAVAILABLE')
  assert.equal(sanitizeMarketOutlook({ ...value, evidenceIds: ['invented'] }, context).bias, 'UNAVAILABLE')
})

test('official NSE timestamps without a timezone are read as IST', () => {
  const raw = '<rss><channel><item><title>HDFC Bank results</title><link>https://nseindia.com/announcement</link><pubDate>11-Oct-2026 15:29:00</pubDate></item></channel></rss>'
  const articles = parseNews(raw, 'companies', initialNow, parseConstituents(csv, 'csv'))
  assert.equal(articles.length, 1)
  assert.equal(articles[0].publishedAt, '2026-10-11T09:59:00.000Z')
})

test('per-headline assessments reject invented, duplicate and stale citations and invalid sentiment labels', async () => {
  const fixture = fixtureService(), context = await fixture.service.getContext('Nifty 50')
  const id = context.articles[0].id
  const result = sanitizeMarketOutlook({ bias: 'BULLISH', agreement: 'SUPPORTS_CHART', evidenceIds: [id], articleSentiments: [{ articleId: id, sentiment: 'POSITIVE' }, { articleId: id, sentiment: 'NEGATIVE' }, { articleId: 'invented', sentiment: 'POSITIVE' }, { articleId: context.articles[1].id, sentiment: 'certain profit' }, null] }, context)
  assert.deepEqual(result.articleSentiments, [{ articleId: id, sentiment: 'POSITIVE' }])
  fixture.advance(); fixture.fail()
  const stale = await fixture.service.getContext('Nifty 50')
  assert.equal(sanitizeMarketOutlook({ ...result, bias: 'BULLISH' }, stale).articleSentiments, undefined)
})

test('headline impacts remain available with a historical or insufficient chart outlook without granting trade confirmation', async () => {
  const { service } = fixtureService(), context = await service.getContext('Nifty 50')
  const id = context.articles[0].id
  const articleSentiments = [{ articleId: id, sentiment: 'NEGATIVE', impactScore: -2, reason: 'Policy tightening may weigh on this index.' }]
  for (const [value, current] of [[{ bias: 'BEARISH', agreement: 'SUPPORTS_CHART', evidenceIds: [id] }, false], [{ bias: 'NEUTRAL', agreement: 'INSUFFICIENT', evidenceIds: [] }, true]]) {
    const result = sanitizeMarketOutlook({ ...value, articleSentiments }, context, current)
    assert.equal(result.bias, 'UNAVAILABLE')
    assert.deepEqual(result.evidenceIds, [])
    assert.deepEqual(result.articleSentiments, articleSentiments)
  }
})

test('headline impact magnitudes reject mismatched signs, out-of-range scores and unknown citations', async () => {
  const { service } = fixtureService(), context = await service.getContext('Nifty 50')
  const id = context.articles[0].id
  for (const [sentiment, impactScore] of [['POSITIVE', -2], ['NEGATIVE', 1], ['NEUTRAL', 2], ['UNCLEAR', 0], ['POSITIVE', 3], ['NEGATIVE', -1.5], ['POSITIVE', '2']]) {
    const result = sanitizeMarketOutlook({ bias: 'BULLISH', agreement: 'SUPPORTS_CHART', evidenceIds: [id], articleSentiments: [{ articleId: id, sentiment, impactScore }] }, context)
    assert.equal(result.articleSentiments[0].impactScore, undefined)
  }
})

test('failed public requests are briefly cached to avoid repeated outage retries', async () => {
  const fixture = fixtureService(); fixture.fail()
  await fixture.service.getContext('Nifty 50')
  const calls = fixture.calls()
  await fixture.service.getContext('Nifty 50')
  assert.equal(fixture.calls(), calls)
})

test('an official alternate download can recover blocked constituent responses', async () => {
  const service = createMarketContextService({ now: () => initialNow, fetchFn: async url => {
    if (url.includes('/content/indices/')) return new Response('<html>Unavailable</html>')
    if (url.includes('IndexConstituent')) return new Response(csv)
    return new Response(rss([]))
  } })
  const context = await service.getContext('Nifty 50')
  assert.equal(context.constituents.status, 'AVAILABLE')
  assert.equal(context.constituents.companies.length, 5)
  assert.match(context.constituents.sourceUrl, /niftyindices\.com/)
})

test('AI context includes current OI, daily flows, futures positions, global markets and VIX while excluding stale values', async () => {
  const { service } = fixtureService(), context = await service.getContext('Nifty 50')
  const vix = { status: 'AVAILABLE', sourceUrl: 'https://nseindia.com', fetchedAt: context.retrievedAt, data: { symbol: '^INDIAVIX', price: 15, changePercent: -2, asOf: context.retrievedAt } }
  const payload = contextForAi(context, vix)
  assert.equal(payload.inputs.openInterest.data.pcr, context.inputs.openInterest.data.pcr)
  assert.equal(payload.inputs.institutional.data.fiiCash, -100)
  assert.equal(payload.inputs.participantPositions.data.longPercent, 20)
  assert.equal(payload.inputs.global.length, 10)
  assert.equal(payload.indiaVix.data.price, 15)
  context.inputs.openInterest.status = 'STALE'
  context.inputs.institutional.data.asOf = '2020-01-01T00:00:00Z'
  const unavailable = contextForAi(context, { ...vix, status: 'STALE' })
  assert.equal(unavailable.inputs.openInterest.data, null)
  assert.equal(unavailable.inputs.institutional.data, null)
  assert.equal(unavailable.indiaVix.data, null)
})

test('saved flow observations reject invalid units, future dates and inconsistent totals before AI interpretation', () => {
  const item = { asOf: new Date(initialNow - 86400000).toISOString(), fiiCash: -100, diiCash: 80, netFlow: -20, unit: 'INR_CRORE' }
  const result = sanitizeObservedFlowReports([item, { ...item, fiiCash: -90, netFlow: -10 }, { ...item, asOf: 'invalid' }, { ...item, asOf: new Date(initialNow + 1000).toISOString() }, { ...item, unit: 'USD' }, { ...item, netFlow: 10000 }, null], initialNow)
  assert.deepEqual(result, [{ ...item, fiiCash: -90, netFlow: -10 }])
})
