import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMarketInputsService, parseInstitutionalFlows, parseParticipantPositions, parseOptionChain, parseGlobalQuote, parseGiftNifty, parseIndiaVix } from '../server/marketInputs.js'

const now = Date.parse('2026-10-12T12:00:00Z')
const expiry = '13-Oct-2026'
const flows = JSON.stringify([{ category: 'FII/FPI', date: '12-Oct-2026', netValue: '-1,000.25' }, { category: 'DII', date: '12-Oct-2026', netValue: '800' }])
const chain = () => ({ records: { timestamp: '12-Oct-2026 15:40:00', data: [
  [100, 10, 40, -2, 3], [110, 50, 5, 8, -1], [120, 10, 30, 2, 5],
].map(([strikePrice, call, put, callChange, putChange]) => ({ strikePrice, expiryDates: expiry, CE: { underlying: 'NIFTY', expiryDate: '13-10-2026', openInterest: call, changeinOpenInterest: callChange }, PE: { underlying: 'NIFTY', expiryDate: expiry, openInterest: put, changeinOpenInterest: putChange } })) } })

test('daily institutional net flows preserve units, signs, zeroes and IST report dates', () => {
  const report = parseInstitutionalFlows(flows, now)
  assert.equal(report.fiiCash, -1000.25)
  assert.equal(report.netFlow, -200.25)
  assert.equal(report.unit, 'INR_CRORE')
  assert.equal(report.asOf, '2026-10-11T18:30:00.000Z')
  assert.equal(parseInstitutionalFlows(flows.replace('-1,000.25', '0'), now).fiiCash, 0)
  assert.throws(() => parseInstitutionalFlows(flows.replace('800', ' '), now))
  assert.throws(() => parseInstitutionalFlows(flows.replace('"DII","date":"12-Oct', '"DII","date":"11-Oct'), now))
  assert.throws(() => parseInstitutionalFlows(flows.replaceAll('12-Oct', '01-Oct'), now))
})

test('participant positions use actual FII index futures counts rather than total derivatives', () => {
  const value = parseParticipantPositions('Participant report\nClient Type,Future Index Short,Future Stock Long,Future Index Long\nFII,72,999999,28\n')
  assert.deepEqual(value, { longPercent: 28.000000000000004, shortPercent: 72 })
  assert.throws(() => parseParticipantPositions('<html>Blocked</html>'))
  assert.throws(() => parseParticipantPositions('Client Type,Future Index Long,Future Index Short\nFII,0,0'))
})

test('nearest-expiry option chain computes PCR, OI walls, max pain and signed changes', () => {
  const result = parseOptionChain(JSON.stringify(chain()), expiry, 'NIFTY', now)
  assert.equal(result.pcr, 75 / 70)
  assert.equal(result.callWall, 110)
  assert.equal(result.putWall, 100)
  assert.equal(result.maxPain, 110)
  assert.equal(result.callOiChange, 8)
  assert.equal(result.putOiChange, 7)
  assert.equal(result.asOf, '2026-10-12T10:10:00.000Z')
  assert.equal(result.unit, 'CONTRACTS')
})

test('option chain rejects mixed underlyings, duplicates and stale snapshots; missing changes stay unknown', () => {
  const raw = chain(); delete raw.records.data[0].CE.changeinOpenInterest
  assert.equal(parseOptionChain(JSON.stringify(raw), expiry, 'NIFTY', now).callOiChange, null)
  assert.throws(() => parseOptionChain(JSON.stringify(raw), expiry, 'BANKNIFTY', now))
  raw.records.data.push(raw.records.data[0])
  assert.throws(() => parseOptionChain(JSON.stringify(raw), expiry, 'NIFTY', now))
  assert.throws(() => parseOptionChain(JSON.stringify(chain()).replace('12-Oct-2026 15:40', '01-Oct-2026 15:40'), expiry, 'NIFTY', now))
})

test('global quote change uses the previous trading session, not the first close of a multi-day range', () => {
  const raw = { chart: { result: [{ meta: { symbol: '^GSPC', regularMarketPrice: 110, regularMarketTime: now / 1000, chartPreviousClose: 80, exchangeTimezoneName: 'America/New_York' }, timestamp: [now / 1000 - 4 * 86400, now / 1000 - 3 * 86400, now / 1000], indicators: { quote: [{ close: [80, 100, 110] }] } }] } }
  assert.equal(parseGlobalQuote(JSON.stringify(raw), '^GSPC', now).changePercent, 10)
  raw.chart.result[0].meta.regularMarketChangePercent = -.22
  assert.equal(parseGlobalQuote(JSON.stringify(raw), '^GSPC', now).changePercent, -.22)
  assert.throws(() => parseGlobalQuote(JSON.stringify(raw), '^N225', now))
  raw.chart.result[0].meta.regularMarketTime += 200
  assert.throws(() => parseGlobalQuote(JSON.stringify(raw), '^GSPC', now))
})

test('GIFT Nifty uses the exchange futures quote, its real expiry and IST timestamp', () => {
  const raw = { giftnifty: { SYMBOL: 'NIFTY', INSTRUMENTTYPE: 'FUTIDX', LASTPRICE: 22420, PERCHANGE: .22, DAYCHANGE: 49.5, EXPIRYDATE: '27-Oct-2026', TIMESTMP: '12-Oct-2026 17:25' } }
  const quote = parseGiftNifty(JSON.stringify(raw), now)
  assert.equal(quote.price, 22420)
  assert.equal(quote.symbol, 'GIFT_NIFTY')
  assert.equal(quote.expiry, '27-Oct-2026')
  assert.equal(quote.asOf, '2026-10-12T11:55:00.000Z')
  assert.throws(() => parseGiftNifty(JSON.stringify(raw).replace('"NIFTY"', '"BANKNIFTY"'), now))
  assert.throws(() => parseGiftNifty(JSON.stringify(raw).replace('17:25', '18:25'), now))
  assert.throws(() => parseGiftNifty(JSON.stringify(raw).replace('12-Oct-2026', '01-Oct-2026'), now))
  assert.throws(() => parseGiftNifty('{"giftnifty":[]}', now))
})

test('10-year yield preserves the percentage level and computes absolute yield movement for basis points', () => {
  const raw = { chart: { result: [{ meta: { symbol: '^TNX', regularMarketPrice: 4.25, previousClose: 4.2, regularMarketTime: now / 1000, regularMarketChangePercent: 1.19 } }] } }
  const quote = parseGlobalQuote(JSON.stringify(raw), '^TNX', now)
  assert.equal(quote.price, 4.25)
  assert(Math.abs(quote.change * 100 - 5) < 1e-8)
  delete raw.chart.result[0].meta.previousClose
  assert.equal(parseGlobalQuote(JSON.stringify(raw), '^TNX', now).change, null, 'unknown basis-point movement stays unknown')
})

test('India VIX uses the named NSE index and preserves negative, positive and zero percentage changes', () => {
  const payload = { timestamp: '12-Oct-2026 15:30', data: [{ index: 'NIFTY 50', last: 22500, percentChange: -1 }, { index: 'INDIA VIX', last: 13.6, percentChange: -2.1, variation: -.3 }] }
  const value = parseIndiaVix(JSON.stringify(payload), now)
  assert.equal(value.price, 13.6)
  assert.equal(value.changePercent, -2.1)
  assert.equal(value.asOf, '2026-10-12T10:00:00.000Z')
  payload.data[1].percentChange = 0
  assert.equal(parseIndiaVix(JSON.stringify(payload), now).changePercent, 0)
  payload.data[1].percentChange = 2.1
  assert.equal(parseIndiaVix(JSON.stringify(payload), now).changePercent, 2.1)
  assert.throws(() => parseIndiaVix(JSON.stringify(payload).replace('INDIA VIX', 'CBOE VIX'), now))
  assert.throws(() => parseIndiaVix(JSON.stringify(payload).replace('12-Oct-2026 15:30', '01-Oct-2026 15:30'), now))
})

test('India VIX public feed shares requests, falls back to Yahoo on NSE outage, and retains a labelled stale snapshot', async () => {
  let clock = now, nseFailed = false, allFailed = false, calls = 0
  const service = createMarketInputsService({ now: () => clock, fetchFn: async url => {
    calls++
    if (allFailed || nseFailed && url.includes('nseindia')) throw new Error('Fixture outage')
    if (url.includes('nseindia')) return new Response(JSON.stringify({ timestamp: '12-Oct-2026 15:30', data: [{ index: 'INDIA VIX', last: 13.6, percentChange: -2.1 }] }))
    return new Response(JSON.stringify({ chart: { result: [{ meta: { symbol: '^INDIAVIX', regularMarketPrice: 13.7, regularMarketChangePercent: -1.5, regularMarketTime: now / 1000 } }] } }))
  } })
  const [first, parallel] = await Promise.all([service.getIndiaVix(), service.getIndiaVix()])
  assert.deepEqual(first, parallel); assert.equal(calls, 1)
  assert.equal(first.data.price, 13.6)
  clock += 301000; nseFailed = true
  const fallback = await service.getIndiaVix()
  assert.equal(fallback.status, 'AVAILABLE')
  assert.equal(fallback.data.price, 13.7)
  assert.match(fallback.sourceUrl, /yahoo/)
  clock += 301000; allFailed = true
  const stale = await service.getIndiaVix()
  assert.equal(stale.status, 'STALE')
  assert.equal(stale.data.price, 13.6)
})

test('public inputs deduplicate parallel requests, retain stale values on outages and isolate Sensex OI', async () => {
  let clock = now, failing = false, calls = 0
  const service = createMarketInputsService({ now: () => clock, fetchFn: async url => {
    calls++
    if (failing) throw new Error('Outage')
    if (url.includes('fiidiiTradeReact')) return new Response(flows)
    if (url.includes('fao_participant_oi')) return new Response('Client Type,Future Index Long,Future Index Short\nFII,28,72')
    if (url.includes('/api/marketStatus')) return new Response(JSON.stringify({ giftnifty: { SYMBOL: 'NIFTY', INSTRUMENTTYPE: 'FUTIDX', LASTPRICE: 22420, PERCHANGE: .22, DAYCHANGE: 49.5, EXPIRYDATE: '27-Oct-2026', TIMESTMP: '12-Oct-2026 17:25' } }))
    if (url.includes('contract-info')) return new Response(JSON.stringify({ expiryDates: ['20-Oct-2026', expiry, '01-Oct-2026'] }))
    if (url.includes('option-chain-v3')) { assert(url.includes('13-Oct-2026')); return new Response(JSON.stringify(chain())) }
    const symbol = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
    return new Response(JSON.stringify({ chart: { result: [{ meta: { symbol, regularMarketPrice: 100, regularMarketTime: now / 1000, regularMarketChangePercent: -.2 } }] } }))
  } })
  const [first, same, sensex] = await Promise.all([service.getInputs('Nifty 50'), service.getInputs('Nifty 50'), service.getInputs('Sensex')])
  assert.equal(calls, 15)
  assert.deepEqual(first, same)
  assert.equal(first.openInterest.status, 'AVAILABLE')
  assert.equal(sensex.openInterest.status, 'UNAVAILABLE')
  assert.equal(sensex.giftNifty.status, 'AVAILABLE')
  assert.equal(first.global.length, 10)
  await service.getInputs('Nifty 50'); assert.equal(calls, 15)
  clock += 301000; failing = true
  const outage = await service.getInputs('Nifty 50')
  assert.equal(outage.institutional.status, 'STALE')
  assert.equal(outage.institutional.data.fiiCash, -1000.25)
  assert.equal(outage.global[0].status, 'STALE')
  assert.equal(outage.giftNifty.status, 'STALE')
  assert.equal(outage.giftNifty.data.price, 22420)
  assert.equal(outage.openInterest.data, null, 'stale contract lookup cannot silently switch or reuse expiry')
  const before = calls; await service.getInputs('Nifty 50'); assert.equal(calls, before)
})
