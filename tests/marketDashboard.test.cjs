const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
const { buildMarketDashboard, observedFlows, openingRange, dashboardWeights, globalMarketRows } = require('../src/analysis/marketDashboard.ts')
const globalMarkets = require('../src/data/globalMarkets.json')
const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
const now = Date.parse('2026-10-12T10:30:00Z')
const candles = Array.from({ length: 60 }, (_, i) => [new Date(now - (60 - i) * 300000).toISOString(), 100, 101, 99, 100, 1000])
const snapshot = data => ({ status: 'AVAILABLE', data, fetchedAt: new Date(now).toISOString(), sourceUrl: 'https://source.example', message: null })
function fixture() {
  const analysis = { ...analyzePriceAction(candles, 'FIVE_MINUTE', now), currentPrice: 100, analyzedCandles: 60, bullishEvidence: ['Bullish candle pressure', 'RSI upward'], bearishEvidence: ['Bearish level pressure'], exponentialMovingAverage20: 100, exponentialMovingAverage50: 100, rsi14: 50, supertrendDirection: 'UP' }
  const article = id => ({ id, title: 'RBI policy update', category: 'india', publishedAt: new Date(now - 1000).toISOString(), url: 'https://news.example', publisher: 'Fixture', matchedCompanies: [] })
  const context = { revision: 'r1', retrievedAt: new Date(now).toISOString(), articles: [article('a'), article('b')], feeds: [{ category: 'india', status: 'AVAILABLE' }], constituents: { status: 'AVAILABLE' }, inputs: {
    openInterest: snapshot({ asOf: new Date(now).toISOString(), pcr: 1, expiry: '13-Oct-2026' }),
    institutional: snapshot({ asOf: new Date(now).toISOString(), fiiCash: -10, diiCash: 10, netFlow: 0 }),
    participantPositions: snapshot({ asOf: new Date(now).toISOString(), longPercent: 20, shortPercent: 80 }),
    global: globalMarkets.filter(spec => spec.provider === 'yahoo').map(spec => snapshot({ asOf: new Date(now).toISOString(), symbol: spec.symbol, price: spec.kind === 'yield' ? 4.2 : 100, change: 0, changePercent: 0 })),
    giftNifty: { status: 'UNAVAILABLE', data: null },
  } }
  const outlook = { contextRevision: 'r1', articleSentiments: [{ articleId: 'a', sentiment: 'POSITIVE' }, { articleId: 'b', sentiment: 'NEGATIVE' }] }
  return { analysis, candles, openingCandles: [], context, outlook, chartCurrent: true, now }
}

test('weights total 100; absent GIFT quote reduces coverage without rescaling the observed subtotal', () => {
  const result = buildMarketDashboard(fixture())
  assert.equal(Object.values(dashboardWeights).reduce((a, b) => a + b), 100)
  assert(Math.abs(result.coverage - (87 + 13 * 10 / 11)) < 1e-8)
  assert.equal(result.subtotal, .11)
  assert.equal(result.tiles.find(tile => tile.key === 'indicators').rows[1][1], 'Mixed', 'equal EMAs must not invent bullish alignment')
  assert.equal(result.tiles.find(tile => tile.key === 'news').score, 0, 'opposing verified headline assessments balance')
})

test('zero-volume VWAP remains unavailable and its unused indicator weight is excluded', () => {
  const args = fixture(); args.candles = candles.map(candle => [...candle.slice(0, 5), 0])
  const result = buildMarketDashboard(args), tile = result.tiles.find(tile => tile.key === 'indicators')
  assert.equal(tile.rows[0][1], 'Unavailable')
  assert.equal(tile.coverage, .75)
  assert(Math.abs(result.coverage - (81.5 + 13 * 10 / 11)) < 1e-8)
  assert.equal(result.subtotal, .11)
})

test('missing/stale reports and unassessed news cannot become neutral directional votes', () => {
  const args = fixture()
  args.context.inputs.openInterest.status = 'STALE'
  args.context.inputs.institutional.status = 'UNAVAILABLE'
  args.context.inputs.global.forEach(quote => quote.status = 'STALE')
  args.outlook.contextRevision = 'old-revision'
  const result = buildMarketDashboard(args)
  for (const key of ['oi', 'flows', 'news', 'global']) assert.equal(result.tiles.find(tile => tile.key === key).score, undefined)
  assert.equal(result.coverage, 44)
  assert.equal(result.tiles.find(tile => tile.key === 'news').rows[1][1], '—')
  assert.match(result.tiles.find(tile => tile.key === 'global').rows.find(([name]) => name === 'S&P 500')[1], /stale/)
})

test('headline scores use only supplied current articles; unclear and stale categories remain unscored', () => {
  const args = fixture()
  args.outlook.articleSentiments = [{ articleId: 'a', sentiment: 'UNCLEAR' }, { articleId: 'invented', sentiment: 'POSITIVE' }]
  let tile = buildMarketDashboard(args).tiles.find(tile => tile.key === 'news')
  assert.equal(tile.score, undefined)
  assert.equal(tile.status, 'Headline impact unclear')
  args.context.feeds[0].status = 'STALE'
  tile = buildMarketDashboard(args).tiles.find(tile => tile.key === 'news')
  assert.equal(tile.rows[0][1], '0')
  assert.equal(tile.coverage, 0)
})

test('historical chart has no current subtotal, even when public reports are available', () => {
  const args = fixture(); args.chartCurrent = false
  const result = buildMarketDashboard(args)
  assert.equal(result.subtotal, undefined)
  assert.equal(result.coverage, 0)
})

test('15-minute opening range requires all three completed 5-minute bars from the same IST session', () => {
  const start = Date.parse('2026-10-12T03:45:00Z')
  const bars = [0, 1, 2].map(i => [new Date(start + i * 300000).toISOString(), 100, 102 + i, 99 - i, 100, 0])
  assert.equal(openingRange(bars, '2026-10-12', start + 899999), undefined)
  assert.deepEqual(openingRange(bars, '2026-10-12', start + 900000), { high: 104, low: 97 })
  assert.equal(openingRange([bars[0], bars[2]], '2026-10-12', now), undefined)
  assert.equal(openingRange(bars, '2026-10-11', now), undefined)
})

test('flow observations replace same IST day corrections, preserve signed values, reject malformed cache and remain bounded', () => {
  const flow = { unit: 'INR_CRORE', asOf: '2026-10-11T18:30:00Z', fiiCash: -10, diiCash: 5, netFlow: -5 }
  const next = { ...flow, asOf: '2026-10-12T00:00:00Z', fiiCash: -20, netFlow: -15 }
  assert.deepEqual(observedFlows([flow, { ...flow, fiiCash: 'invented' }], next), [next])
  assert.deepEqual(observedFlows(null), [])
  assert.equal(observedFlows(Array.from({ length: 30 }, (_, i) => ({ ...flow, asOf: new Date(now - i * 86400000).toISOString() }))).length, 20)
})

test('all requested markets have prices and moves; oil, FX and yield cues separate actual direction from India impact', () => {
  const args = fixture()
  args.context.inputs.giftNifty = snapshot({ symbol: 'GIFT_NIFTY', price: 22420, changePercent: .22, asOf: new Date(now).toISOString(), expiry: '27-Oct-2026' })
  const brent = args.context.inputs.global.find(quote => quote.data.symbol === 'BZ=F')
  const fx = args.context.inputs.global.find(quote => quote.data.symbol === 'INR=X')
  const yieldQuote = args.context.inputs.global.find(quote => quote.data.symbol === '^TNX')
  Object.assign(brent.data, { price: 106.7, changePercent: 1.2 })
  Object.assign(fx.data, { price: 95.76, changePercent: -.8 })
  Object.assign(yieldQuote.data, { price: 4.25, change: .05, changePercent: 1.19 })
  const result = globalMarketRows(args.context, now)
  assert.equal(result.rows.length, 11)
  assert.equal(result.votes.length, 11)
  assert.match(result.rows.find(([name]) => name === 'GIFT Nifty')[1], /22,420.00\n↑ \+0.22%/)
  assert.match(result.rows.find(([name]) => name === 'Brent Crude')[1], /\$106.70 \/ bbl\n↑ \+1.20%/)
  assert.equal(result.details['Brent Crude'].caption, 'Bearish India cue')
  assert.match(result.rows.find(([name]) => name === 'USD\/INR')[1], /₹95.76 \/ USD\n↓ -0.80%/)
  assert.equal(result.details['USD/INR'].caption, 'Bullish India cue')
  assert.match(result.rows.find(([name]) => name === 'US 10Y Yield')[1], /4.250%\n↑ \+5.00 bps/)
  assert.equal(result.details['US 10Y Yield'].caption, 'Bearish India cue')
  assert.equal(buildMarketDashboard(args).coverage, 100)
})

test('macro declines show upward India cues; stale or unknown changes do not invent a bullish/bearish call', () => {
  const args = fixture()
  for (const symbol of ['BZ=F', 'INR=X', '^TNX']) {
    const quote = args.context.inputs.global.find(item => item.data.symbol === symbol)
    Object.assign(quote.data, { changePercent: -.5, change: -.05 })
  }
  let result = globalMarketRows(args.context, now)
  for (const name of ['Brent Crude', 'USD/INR', 'US 10Y Yield']) assert.equal(result.details[name].caption, 'Bullish India cue')
  const yieldQuote = args.context.inputs.global.find(item => item.data.symbol === '^TNX')
  yieldQuote.data.change = null
  result = globalMarketRows(args.context, now)
  assert.match(result.rows.find(([name]) => name === 'US 10Y Yield')[1], /-0.50% relative/)
  yieldQuote.status = 'STALE'
  result = globalMarketRows(args.context, now)
  assert.equal(result.details['US 10Y Yield'].caption, undefined)
  assert.equal(result.details['US 10Y Yield'].tone, 'missing')
  assert.match(result.rows.find(([name]) => name === 'US 10Y Yield')[1], /stale/)
  assert.equal(result.votes.length, 9)
})
