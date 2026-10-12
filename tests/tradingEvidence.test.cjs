const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename)
const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
const { buildEarlyPrediction } = require('../src/analysis/earlyPrediction.ts')
const { createPredictionRecord, readPredictionHistory, writePredictionHistory, observePredictionTick, observePredictionCandles, syncPredictionRecord, registerConfirmedPrediction, canEnterConfirmedPrediction } = require('../src/analysis/predictionHistory.ts')
const { getAiPriceAction } = require('../src/api/ai.ts')
const markets = require('../src/data/globalMarkets.json')
const now = Date.parse('2026-10-13T05:00:00Z'), duration = 300000
const snapshot = data => ({ status: 'AVAILABLE', fetchedAt: new Date(now).toISOString(), sourceUrl: 'https://source.example', data })

function fixture(direction = 1, instrument = 'Nifty 50') {
  const side = direction === 1 ? 'CALL' : 'PUT'
  const candles = Array.from({ length: 80 }, (_, index) => {
    const close = 100 - direction * (79 - index) * .1
    return [new Date(now - (80 - index) * duration).toISOString(), close - direction * .1, close + .2, close - .2, close, 0]
  })
  const analysis = { side, pattern: direction === 1 ? 'BREAKOUT_RETEST' : 'BREAKDOWN_RETEST', phase: direction === 1 ? 'UPTREND' : 'DOWNTREND', structure: direction === 1 ? 'Higher High + Higher Low' : 'Lower High + Lower Low', structureEvent: 'Fixture established structure', location: direction === 1 ? 'At / near support' : 'At / near resistance', setup: 'Fixture completed retest', candleBehavior: direction === 1 ? 'Strong bullish close' : 'Strong bearish close', analyzedCandles: 80, latestCandleTime: candles.at(-1)[0], currentPrice: 100, entry: 100, stopLoss: 100 - direction * 10, target: 100 + direction * 20,
    earlyBias: direction === 1 ? 'BULLISH' : 'BEARISH', earlyStage: 'CONFIRMED', bullishScore: direction === 1 ? 80 : 10, bearishScore: direction === 1 ? 10 : 80,
    bullishEvidence: direction === 1 ? ['Strong bullish candle pressure', 'Higher lows support a breakout', 'Supertrend is bullish'] : [], bearishEvidence: direction === -1 ? ['Strong bearish candle pressure', 'Lower highs support a breakdown', 'Supertrend is bearish'] : [],
    movingAverage20: 100 - direction * 1, exponentialMovingAverage20: 100 - direction * .8, exponentialMovingAverage50: 100 - direction * 2,
    rsi14: direction === 1 ? 70 : 30, rsi14Momentum: direction * 8, atr14: 2, supertrendDirection: direction === 1 ? 'UP' : 'DOWN',
  }
  const articles = Array.from({ length: 8 }, (_, index) => ({ id: String(index), title: 'Fixture market outlook', category: 'india', publishedAt: new Date(now - 1000).toISOString(), publisher: 'Fixture', url: `https://source.example/${index}`, matchedCompanies: [] }))
  const context = { instrument, revision: 'r1', retrievedAt: new Date(now).toISOString(), articles, constituents: { status: 'AVAILABLE' }, feeds: [{ category: 'india', status: 'AVAILABLE' }], inputs: {
    openInterest: snapshot({ asOf: new Date(now).toISOString(), expiry: '15-Oct-2026', symbol: instrument === 'Bank Nifty' ? 'BANKNIFTY' : instrument === 'Sensex' ? 'SENSEX' : 'NIFTY', pcr: direction === 1 ? 1.6 : .4, callOi: 100, putOi: 100, callOiChange: direction === 1 ? 20 : 80, putOiChange: direction === 1 ? 80 : 20, callWall: 120, putWall: 90, maxPain: 100, unit: 'CONTRACTS' }),
    institutional: snapshot({ asOf: new Date(now).toISOString(), fiiCash: direction * 2000, diiCash: direction * 1000, netFlow: direction * 3000, unit: 'INR_CRORE' }),
    participantPositions: snapshot({ asOf: new Date(now).toISOString(), longPercent: direction === 1 ? 80 : 20, shortPercent: direction === 1 ? 20 : 80 }),
    global: markets.filter(item => item.provider !== 'nse').map(item => ({ ...snapshot({ symbol: item.symbol, price: 100, changePercent: direction * item.indiaSign, asOf: new Date(now).toISOString() }), name: item.name })),
    giftNifty: snapshot({ symbol: 'GIFT_NIFTY', price: 100, changePercent: direction, asOf: new Date(now).toISOString() }),
  } }
  const outlook = { bias: direction === 1 ? 'BULLISH' : 'BEARISH', agreement: 'SUPPORTS_CHART', contextRevision: context.revision, evidenceIds: ['0'], summary: 'Fixture news agrees', articleSentiments: articles.map(article => ({ articleId: article.id, sentiment: direction === 1 ? 'POSITIVE' : 'NEGATIVE', impactScore: direction * 2 })) }
  const indiaVix = snapshot({ symbol: '^INDIAVIX', price: 15, changePercent: -2, asOf: new Date(now).toISOString() })
  return { analysis, candles, instrument, interval: 'FIVE_MINUTE', context, outlook, indiaVix, now }
}

test('aligned CALL and PUT evidence across all input groups confirms and snapshots real chart levels', () => {
  for (const direction of [1, -1]) for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty']) {
    const input = fixture(direction, instrument), result = analyzeTradingEvidence(input)
    assert.equal(result.canConfirm, true, result.reason)
    assert.equal(result.layers.reduce((sum, item) => sum + item.weight, 0), 100)
    assert(result.coverage > 90 && result.coverage < 100, 'zero-volume VWAP keeps a missing fixed budget')
    assert.equal(result.bias, direction === 1 ? 'BULLISH' : 'BEARISH')
    const prediction = buildEarlyPrediction(input.analysis, instrument, input.interval, now, input.context, input.outlook, result)
    assert.equal(prediction.plan.stage, 'CONFIRMED')
    assert.deepEqual([prediction.plan.entry, prediction.plan.stopLoss, prediction.plan.target], [100, input.analysis.stopLoss, input.analysis.target])
    assert.equal(prediction.plan.bullishScore, result.bullishScore)
    const record = createPredictionRecord(prediction.plan)
    let value; writePredictionHistory({ setItem: (_, saved) => { value = saved } }, [record])
    assert.deepEqual(readPredictionHistory({ getItem: () => value }), [record])
  }
})

test('macro support cannot replace a closed chart pattern or allow forming / historical candles', () => {
  const input = fixture()
  for (const change of [{ side: 'WAIT', pattern: 'NO_CONFIRMED_PATTERN' }, { latestCandleTime: new Date(now).toISOString() }, { latestCandleTime: new Date(now - 3 * duration).toISOString() }, { analyzedCandles: 10 }]) assert.equal(analyzeTradingEvidence({ ...input, analysis: { ...input.analysis, ...change } }).canConfirm, false)
  const forming = [new Date(now).toISOString(), 100, 1000, 1, 1000, 1000000]
  assert.deepEqual(analyzeTradingEvidence({ ...input, candles: [...input.candles, forming] }), analyzeTradingEvidence(input))
})

test('missing, stale and wrong-index context do not rescale scores or confirm chart-only trades', () => {
  const input = fixture(), full = analyzeTradingEvidence(input)
  for (const context of [null, { ...input.context, instrument: 'Sensex' }, { ...input.context, retrievedAt: new Date(now - 11 * 60000).toISOString() }]) {
    const result = analyzeTradingEvidence({ ...input, context })
    assert.equal(result.canConfirm, false)
    assert(result.coverage <= 44)
    assert(result.bullishScore < full.bullishScore)
    assert.match(result.reason, /Insufficient market evidence/)
  }
})

test('unavailable Sensex OI stays excluded; other available evidence can still confirm', () => {
  const input = fixture(1, 'Sensex')
  input.context.inputs.openInterest = { ...input.context.inputs.openInterest, status: 'UNAVAILABLE', data: null }
  const result = analyzeTradingEvidence(input)
  assert.equal(result.canConfirm, true, result.reason)
  assert.equal(result.layers.find(item => item.key === 'oi').coverage, 0)
  assert(result.missing.includes('Current, unexpired option-chain data'))
})

test('expired option chains, stale reports and unmatched news assessments contribute nothing', () => {
  const input = fixture()
  input.context.inputs.openInterest.data.expiry = '12-Oct-2026'
  input.context.inputs.institutional.status = 'STALE'
  input.context.inputs.participantPositions.status = 'STALE'
  input.outlook.contextRevision = 'outdated'
  const result = analyzeTradingEvidence(input)
  assert.equal(result.canConfirm, false)
  for (const key of ['oi', 'flows', 'news']) assert.equal(result.layers.find(item => item.key === key).coverage, 0)
})

test('two strongly opposing external groups block a superficially strong chart setup', () => {
  const input = fixture(), bearish = fixture(-1)
  input.context.inputs.openInterest = bearish.context.inputs.openInterest
  input.context.inputs.global = bearish.context.inputs.global
  input.context.inputs.giftNifty = bearish.context.inputs.giftNifty
  const result = analyzeTradingEvidence(input)
  assert.equal(result.canConfirm, false)
  assert.match(result.reason, /Strong disagreement/)
})

test('ATR excludes tight invalidation and insufficient reward without manufacturing new targets', () => {
  const input = fixture()
  for (const change of [{ atr14: undefined }, { atr14: 15 }, { target: 110 }]) {
    const result = analyzeTradingEvidence({ ...input, analysis: { ...input.analysis, ...change } })
    assert.equal(result.canConfirm, false)
    assert.match(result.reason, /ATR|risk/)
  }
})

test('ATR can widen a tight stop while the original chart target remains fixed and sufficient', () => {
  const input = fixture()
  input.analysis.stopLoss = 99
  const evidence = analyzeTradingEvidence(input)
  assert.equal(evidence.canConfirm, true, evidence.reason)
  const prediction = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now, input.context, input.outlook, evidence)
  assert.equal(prediction.plan.stopLoss, 98)
  assert.equal(prediction.plan.target, 120)
  assert.match(prediction.plan.targetBasis, /ATR/)
})

test('India VIX changes risk threshold without adding bullish or bearish votes', () => {
  const input = fixture(), normal = analyzeTradingEvidence(input)
  const elevated = analyzeTradingEvidence({ ...input, indiaVix: snapshot({ ...input.indiaVix.data, price: 30, changePercent: 12 }) })
  assert.equal(elevated.requiredScore, 65)
  assert.equal(elevated.bullishScore, normal.bullishScore)
  assert.equal(elevated.bearishScore, normal.bearishScore)
  const stale = analyzeTradingEvidence({ ...input, indiaVix: { ...input.indiaVix, status: 'STALE' } })
  assert.equal(stale.indiaVix, undefined)
})

test('RSI level and slowing momentum can produce opposing evidence inside the same capped indicator budget', () => {
  const input = fixture()
  input.analysis.rsi14 = 65
  input.analysis.rsi14Momentum = -6
  const result = analyzeTradingEvidence(input)
  assert(result.bullishEvidence.some(item => /RSI\(14\): 65/.test(item)))
  assert(result.bearishEvidence.some(item => /RSI\(14\) momentum: -6/.test(item)))
  assert(result.layers.find(item => item.key === 'indicators').bullish + result.layers.find(item => item.key === 'indicators').bearish <= 22)
})

test('previous-session OI and VIX cannot masquerade as current intraday confirmation inputs', () => {
  const input = fixture()
  input.context.inputs.openInterest.data.asOf = new Date(now - 31 * 60000).toISOString()
  input.indiaVix.data.asOf = new Date(now - 31 * 60000).toISOString()
  const result = analyzeTradingEvidence(input)
  assert.equal(result.layers.find(layer => layer.key === 'oi').coverage, 0)
  assert.equal(result.indiaVix, undefined)
})

test('a real-volume session enables VWAP while missing volume never creates a substitute', () => {
  const input = fixture(), absent = analyzeTradingEvidence(input)
  assert.equal(absent.vwap, undefined)
  const real = analyzeTradingEvidence({ ...input, candles: input.candles.map(candle => [...candle.slice(0, 5), 100]) })
  assert(real.vwap > 0)
  assert(real.coverage > absent.coverage)
})

test('tiny global moves carry tiny evidence rather than a full bullish/bearish vote', () => {
  const input = fixture()
  input.context.inputs.global.forEach(quote => quote.data.changePercent *= .001)
  input.context.inputs.giftNifty.data.changePercent *= .001
  const result = analyzeTradingEvidence(input)
  assert(result.layers.find(item => item.key === 'global').bullish < .1)
})

test('actual saved institutional observations add a bounded multi-session trend and reject future reports', () => {
  const input = fixture(), initial = analyzeTradingEvidence(input)
  const reports = Array.from({ length: 5 }, (_, index) => ({ asOf: new Date(now - index * 86400000).toISOString(), fiiCash: -100, diiCash: 80, netFlow: -20, unit: 'INR_CRORE' }))
  const result = analyzeTradingEvidence({ ...input, flowHistory: [...reports, { ...reports[0], asOf: new Date(now + 86400000).toISOString() }] })
  assert.equal(result.observedFlowReports.length, 5)
  const flows = result.layers.find(layer => layer.key === 'flows'), previous = initial.layers.find(layer => layer.key === 'flows')
  assert(flows.coverage > previous.coverage)
  assert(flows.bearish > previous.bearish)
  assert(result.bearishEvidence.some(item => /selling in 5\/5/.test(item)))
})

test('entry pauses during reassessment, continues observing stops and resumes on a new confirmed quote', () => {
  const input = fixture(), prediction = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now)
  let record = createPredictionRecord(prediction.plan)
  record = observePredictionTick(record, 100, now + 1000, false)
  assert.equal(record.status, 'PENDING')
  assert.equal(record.entryPrice, undefined)
  const stopped = observePredictionTick(record, 89, now + 2000, false)
  assert.equal(stopped.status, 'EXPIRED')
  record = observePredictionTick(record, 100, now + 2000, true)
  assert.equal(record.status, 'ACTIVE')
  assert.equal(observePredictionTick(record, 120, now + 3000, false).status, 'TARGET_HIT', 'reassessment never suspends exit tracking')
  const candle = [new Date(now).toISOString(), 99, 102, 98, 101, 0]
  const waiting = observePredictionCandles(createPredictionRecord(prediction.plan), [candle], now + duration, false)
  assert.equal(waiting.status, 'PENDING')
  const synced = syncPredictionRecord(waiting, [], { timestamp: now + duration + 1000, ltp: 100 }, now + duration + 1000, false)
  assert.equal(synced.status, 'PENDING')
})

test('a stale rendered confirmation cannot enter after the next candle closes or after levels change', () => {
  const input = fixture(), evidence = analyzeTradingEvidence(input)
  const plan = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now, input.context, input.outlook, evidence).plan
  const record = createPredictionRecord(plan)
  assert.equal(canEnterConfirmedPrediction(record, plan, now, now + 1000), true)
  assert.equal(canEnterConfirmedPrediction(record, plan, now, now + 31000), false)
  assert.equal(canEnterConfirmedPrediction(record, plan, now + duration, now + duration), false)
  assert.equal(canEnterConfirmedPrediction(record, { ...plan, stopLoss: 89 }, now, now + 1000), false)
  assert.equal(syncPredictionRecord(record, [], { timestamp: now + duration, ltp: 100 }, now + duration, true, plan).entryPrice, undefined)
})

test('new strategy retires legacy unentered candidates without reopening an already entered signal', () => {
  const input = fixture(), evidence = analyzeTradingEvidence(input)
  const legacy = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now).plan
  const plan = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now, input.context, input.outlook, evidence).plan
  assert.equal(plan.strategyVersion, 'combined-v1')
  const pending = registerConfirmedPrediction([createPredictionRecord(legacy)], plan, now)
  assert.deepEqual(pending.map(record => record.status), ['EXPIRED', 'PENDING'])
  const completed = observePredictionTick(observePredictionTick(createPredictionRecord(legacy), 100, now + 1000), 120, now + 2000)
  assert.deepEqual(registerConfirmedPrediction([completed], plan, now + 2000), [completed])
})

test('corrected unentered levels preserve the original deadline and entry snapshots use current evidence', () => {
  const input = fixture(), evidence = analyzeTradingEvidence(input)
  const plan = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now, input.context, input.outlook, evidence).plan
  const candidate = createPredictionRecord(plan)
  const corrected = { ...plan, stopLoss: 88, generatedAt: now + 1000, expiresAt: plan.expiresAt + 1000 }
  const current = registerConfirmedPrediction([candidate], corrected, now + 1000)[0]
  assert.equal(current.stopLoss, 88)
  assert.equal(current.expiresAt, candidate.expiresAt)
  const refreshed = { ...corrected, bullishScore: corrected.bullishScore - 1, newsSummary: 'Refreshed current news' }
  const entered = syncPredictionRecord(current, [], { timestamp: now + 1000, ltp: 100 }, now + 1000, true, refreshed)
  assert.equal(entered.status, 'ACTIVE')
  assert.equal(entered.bullishScore, refreshed.bullishScore)
  assert.equal(entered.newsSummary, refreshed.newsSummary)
})

test('AI request includes location, pattern, all chart indicator readings and weighted evidence within body bound', async () => {
  const input = fixture(), evidence = analyzeTradingEvidence(input), original = global.fetch
  let body
  global.fetch = async (_, request) => { body = request.body; return new Response(JSON.stringify({ model: 'fixture' })) }
  try { await getAiPriceAction(input.instrument, input.interval, input.candles, input.analysis, undefined, true, evidence) } finally { global.fetch = original }
  const parsed = JSON.parse(body)
  assert(body.length < 10000)
  assert.equal(parsed.candles.length, 40)
  for (const key of ['structure', 'structureEvent', 'location', 'candleBehavior', 'pattern', 'setup', 'rsi14', 'atr14']) assert.equal(parsed.rules[key], input.analysis[key])
  assert.equal(parsed.rules.combinedEvidence.layers.length, 6)
  assert.equal(parsed.rules.combinedEvidence.bullishScore, evidence.bullishScore)
})
