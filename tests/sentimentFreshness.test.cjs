const atmVwapFixture = require('./helpers/atmVwap.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename)
const { sentimentAgeRules, sentimentFreshness } = require('../src/analysis/sentimentFreshness.ts')
const { buildNewsEvidence } = require('../src/analysis/newsEvidence.ts')
const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
const markets = require('../src/data/globalMarkets.json')
const now = Date.parse('2026-10-16T07:00:00Z'), iso = age => new Date(now - age).toISOString()
const snapshot = data => ({ status: 'AVAILABLE', fetchedAt: iso(0), data })

function fixture(direction = 1) {
  const side = direction === 1 ? 'CALL' : 'PUT'
  const candles = Array.from({ length: 80 }, (_, i) => {
    const close = 100 - direction * (79 - i) * .1
    return [iso((80 - i) * 300_000), close - direction * .1, close + .2, close - .2, close, 0]
  })
  const analysis = { side, pattern: direction === 1 ? 'BREAKOUT_RETEST' : 'BREAKDOWN_RETEST', phase: direction === 1 ? 'UPTREND' : 'DOWNTREND', structure: 'Fixture structure', structureEvent: 'Established structure', location: 'At / near support', setup: 'Completed retest', candleBehavior: 'Directional close', analyzedCandles: 80, latestCandleTime: candles.at(-1)[0], currentPrice: 100, entry: 100, stopLoss: 100 - direction * 10, target: 100 + direction * 20,
    bullishEvidence: direction === 1 ? ['Bullish candle pressure', 'Higher lows'] : [], bearishEvidence: direction === -1 ? ['Bearish candle pressure', 'Lower highs'] : [],
    movingAverage20: 100 - direction, exponentialMovingAverage20: 100 - direction * .8, exponentialMovingAverage50: 100 - direction * 2,
    alignment: { at: candles.at(-1)[0], routes: [{ family: 'EMA', side, name: 'Matching EMA trajectory' }] }, rsi14: direction === 1 ? 70 : 30, rsi14Momentum: direction * 8, atr14: 2, supertrendDirection: direction === 1 ? 'UP' : 'DOWN' }
  const context = { instrument: 'Nifty 50', revision: 'r1', retrievedAt: iso(0), constituents: { status: 'AVAILABLE' }, feeds: [{ category: 'india', status: 'AVAILABLE' }],
    articles: [{ id: 'one', category: 'india', title: 'Fixture market news', publishedAt: iso(0), url: 'https://publisher.example/one' }], inputs: {
      openInterest: snapshot({ asOf: iso(0), expiry: '2026-10-20', symbol: 'NIFTY', pcr: direction === 1 ? 1.6 : .4, callOiChange: direction === 1 ? 20 : 80, putOiChange: direction === 1 ? 80 : 20, callOi: 100, putOi: 100, unit: 'CONTRACTS' }),
      institutional: snapshot({ asOf: iso(0), fiiCash: direction * 2000, diiCash: direction * 1000, netFlow: direction * 3000, unit: 'INR_CRORE' }),
      participantPositions: snapshot({ asOf: iso(0), longPercent: direction === 1 ? 80 : 20, shortPercent: direction === 1 ? 20 : 80 }),
      global: markets.filter(item => item.provider !== 'nse').map(item => snapshot({ symbol: item.symbol, price: 100, changePercent: direction * item.indiaSign, asOf: iso(0) })),
      giftNifty: snapshot({ symbol: 'GIFT_NIFTY', price: 100, changePercent: direction, asOf: iso(0) }),
    } }
  const outlook = { contextRevision: 'r1', articleSentiments: [{ articleId: 'one', sentiment: direction === 1 ? 'POSITIVE' : 'NEGATIVE', impactScore: direction * 2, assessedAt: iso(0), scope: 'MARKET_IMPACT' }] }
  return { analysis, candles, atmVwap: atmVwapFixture('Nifty 50',100,now,direction), interval: 'FIVE_MINUTE', instrument: 'Nifty 50', context, outlook, now }
}

test('sentiment age factors halve at published defaults, stay bounded, and enforce hard expiry', () => {
  for (const [kind, rules] of Object.entries(sentimentAgeRules)) {
    assert.equal(sentimentFreshness(kind, iso(0), now).factor, 1)
    assert.equal(sentimentFreshness(kind, iso(rules.halfLifeMs), now).factor, .5)
    assert(sentimentFreshness(kind, iso(rules.maxAgeMs), now).factor > 0)
    assert.equal(sentimentFreshness(kind, iso(rules.maxAgeMs + 1), now), undefined)
    for (const asOf of [undefined, '', 'invalid', iso(-60_001)]) assert.equal(sentimentFreshness(kind, asOf, now), undefined)
    assert.equal(sentimentFreshness(kind, iso(-30_000), now).factor, 1, 'small tolerated source-clock skew is capped')
  }
  assert.equal(sentimentFreshness('news', iso(0), NaN), undefined)
})

test('publication age survives refetch/reassessment while raw headline impacts remain readable', () => {
  const input = fixture(), recent = buildNewsEvidence(input.context, input.outlook, now)
  input.context.articles[0].publishedAt = iso(12 * 3_600_000)
  const old = buildNewsEvidence(input.context, input.outlook, now)
  assert.equal(recent.score, 2)
  assert.equal(old.score, 2, 'raw +ve/-ve magnitude is unchanged')
  assert.equal(old.ageAdjustedScore, 1)
  assert.equal(old.headlines[0].freshness.factor, .5)
  assert.equal(old.headlines[0].ageAdjustedScore, 1)
  assert.equal(old.ageAdjustedScore, buildNewsEvidence({ ...input.context, retrievedAt: iso(0), revision: 'refetched' }, { ...input.outlook, contextRevision: 'refetched' }, now).ageAdjustedScore)
  assert.equal(buildNewsEvidence({ ...input.context, retrievedAt: iso(11 * 60_000) }, input.outlook, now).ageAdjustedScore, undefined)
})

test('all reference groups decay independently without changing CALL/PUT technical confirmation or OI', () => {
  for (const direction of [1, -1]) {
    const input = fixture(direction), before = analyzeTradingEvidence(input)
    assert.equal(before.canConfirm, true, before.reason)
    const aged = structuredClone(input)
    aged.context.articles[0].publishedAt = iso(sentimentAgeRules.news.halfLifeMs)
    aged.context.inputs.institutional.data.asOf = iso(sentimentAgeRules.flows.halfLifeMs)
    aged.context.inputs.participantPositions.data.asOf = iso(sentimentAgeRules.flows.halfLifeMs)
    for (const quote of [...aged.context.inputs.global, aged.context.inputs.giftNifty]) quote.data.asOf = iso(sentimentAgeRules.global.halfLifeMs)
    aged.context.inputs.openInterest.data.asOf = iso(sentimentAgeRules.pcr.halfLifeMs)
    const after = analyzeTradingEvidence(aged)
    for (const key of ['bullishScore', 'bearishScore', 'coverage', 'bias', 'canConfirm', 'reason', 'requiredScore', 'stopLoss']) assert.deepEqual(after[key], before[key], key)
    assert.deepEqual(after.layers, before.layers, 'technical OI keeps its existing freshness gate and allocation')
    for (const layer of after.sentiment.layers) {
      const original = before.sentiment.layers.find(item => item.key === layer.key)
      assert.equal(layer.coverage, original.coverage, 'age does not invent missing coverage')
      assert.equal(layer.bullish, original.bullish / 2)
      assert.equal(layer.bearish, original.bearish / 2)
      assert(layer.details.some(detail => /age weight 50\.0%/.test(detail)), layer.key)
    }
  }
})

test('unrated and stale evidence never redistributes its fixed weight to other headlines', () => {
  const input = fixture()
  input.context.articles.push({ ...input.context.articles[0], id: 'unrated', url: 'https://publisher.example/unrated' })
  const initial = analyzeTradingEvidence(input).sentiment.layers.find(layer => layer.key === 'news')
  assert.equal(initial.bullish, 7.5)
  input.context.articles[0].publishedAt = iso(12 * 3_600_000)
  const aged = analyzeTradingEvidence(input).sentiment.layers.find(layer => layer.key === 'news')
  assert.equal(aged.bullish, 3.75)
  assert.equal(aged.coverage, .5)
  input.context.feeds[0].status = 'STALE'
  const stale = analyzeTradingEvidence(input).sentiment.layers.find(layer => layer.key === 'news')
  assert.equal(stale.coverage, 0)
  assert.equal(stale.bullish, 0)
})

test('PCR retains its legacy technical allocation but has zero market-context weight', () => {
  const input = fixture()
  input.context.articles = []
  input.context.inputs.institutional = { status: 'UNAVAILABLE' }
  input.context.inputs.participantPositions = { status: 'UNAVAILABLE' }
  input.context.inputs.global = []
  input.context.inputs.giftNifty = { status: 'UNAVAILABLE' }
  input.context.inputs.openInterest.data.asOf = iso(15 * 60_000)
  const result = analyzeTradingEvidence(input)
  assert.equal(result.layers.filter(layer => layer.key === 'oi').length, 1)
  assert.equal(result.layers.some(layer => layer.key === 'pcr'), false)
  assert.equal(result.sentiment.layers.filter(layer => layer.key === 'pcr').length, 0)
  assert.equal(result.sentiment.coverage, 0)
  assert.equal(result.sentiment.bias, 'UNAVAILABLE')
})
test('all indices use FII/DII 40, GIFT 30, global 15 and news 15 with independently counted GIFT',()=>{
 for(const instrument of ['Nifty 50','Sensex','Bank Nifty'])for(const d of [1,-1]){
  const input=fixture(d);input.instrument=instrument;input.context.instrument=instrument
  const result=analyzeTradingEvidence(input),layers=result.sentiment.layers
  assert.deepEqual(Object.fromEntries(layers.map(l=>[l.key,l.weight])),{flows:40,news:15,gift:30,global:15})
  assert.equal(layers.reduce((sum,l)=>sum+l.weight,0),100)
  const gift=layers.find(l=>l.key==='gift'),global=layers.find(l=>l.key==='global')
  assert.equal(gift[d===1?'bullish':'bearish'],30);assert.equal(global[d===1?'bullish':'bearish'],15)
  assert(!global.details.some(text=>text.includes('GIFT Nifty')))
  const other=structuredClone(input);other.context.inputs.giftNifty.data.changePercent=-d
  const changed=analyzeTradingEvidence(other)
  assert.deepEqual(changed.sentiment.layers.find(l=>l.key==='global'),global)
  assert.equal(changed.sentiment.layers.find(l=>l.key==='gift')[d===1?'bearish':'bullish'],30)
  for(const key of ['bullishScore','bearishScore','coverage','canConfirm','stopLoss'])assert.equal(changed[key],result[key],key)
 }
})
test('full configured context reaches 100% coverage; missing GIFT loses exactly 30 points without redistribution',()=>{
 const input=fixture(),flowHistory=[0,86400000,2*86400000].map(age=>({...input.context.inputs.institutional.data,asOf:iso(age)}))
 const full=analyzeTradingEvidence({...input,flowHistory})
 assert.equal(full.sentiment.coverage,100)
 const absent=structuredClone(input);absent.context.inputs.giftNifty.status='UNAVAILABLE'
 const missing=analyzeTradingEvidence({...absent,flowHistory})
 assert.equal(missing.sentiment.coverage,70)
 for(const key of ['flows','news','global'])assert.deepEqual(missing.sentiment.layers.find(l=>l.key===key),full.sentiment.layers.find(l=>l.key===key))
 const old=structuredClone(input);old.context.inputs.giftNifty.data.asOf=iso(sentimentAgeRules.global.halfLifeMs)
 const aged=analyzeTradingEvidence({...old,flowHistory})
 assert.equal(aged.sentiment.coverage,100);assert.equal(aged.sentiment.layers.find(l=>l.key==='gift').bullish,15)
 for(const key of ['flows','news','global'])assert.deepEqual(aged.sentiment.layers.find(l=>l.key===key),full.sentiment.layers.find(l=>l.key===key))
 const stale=structuredClone(input);stale.context.inputs.giftNifty.data.asOf=iso(sentimentAgeRules.global.maxAgeMs+1)
 assert.equal(analyzeTradingEvidence({...stale,flowHistory}).sentiment.layers.find(l=>l.key==='gift').coverage,0)
})
