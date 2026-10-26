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
const { analyzeIndicatorTrajectory } = require('../src/analysis/indicatorTrajectory.ts')
const { getAiPriceAction, newsAssessmentKey, getNewsAssessment } = require('../src/api/ai.ts')
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
    alignment: { at: candles.at(-1)[0], routes: [{ family: 'EMA', side, name: `EMA20/50 trajectory ${direction === 1 ? 'up' : 'down'}` }] },
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
  const leg = close => ({ symbol: 'fixture', token: '1', exchange: 'NFO', close, vwap: 100, volume: 100, asOf: new Date(now).toISOString(), coverage: 'FULL_SESSION' })
  const atmVwap = { index: instrument, strike: 100, expiry: '2026-10-20', fetchedAt: new Date(now).toISOString(), method: 'SESSION_HLC3_VOLUME', referenceIndexPrice: 100, ce: leg(100 + direction * 10), pe: leg(100 - direction * 10) }
  return { analysis, candles, instrument, atmVwap, interval: 'FIVE_MINUTE', context, outlook, indiaVix, now }
}

test('aligned CALL and PUT evidence across all input groups confirms and snapshots real chart levels', () => {
  for (const direction of [1, -1]) for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty']) {
    const input = fixture(direction, instrument), result = analyzeTradingEvidence(input)
    assert.equal(result.canConfirm, true, result.reason)
    assert.equal(result.layers.reduce((sum, item) => sum + item.weight, 0), 100)
    assert.equal(result.coverage, 90, 'unconfirmed RSI swings keep their fixed 10-point budget missing')
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
  for (const change of [{ side: 'WAIT', pattern: 'NO_CONFIRMED_PATTERN' }, { latestCandleTime: new Date(now).toISOString() }, { latestCandleTime: new Date(now - 2 * duration).toISOString() }, { latestCandleTime: new Date(now - 3 * duration).toISOString() }, { analyzedCandles: 10 }]) assert.equal(analyzeTradingEvidence({ ...input, analysis: { ...input.analysis, ...change } }).canConfirm, false)
  const forming = [new Date(now).toISOString(), 100, 1000, 1, 1000, 1000000]
  assert.deepEqual(analyzeTradingEvidence({ ...input, candles: [...input.candles, forming] }), analyzeTradingEvidence(input))
})

test('missing, stale and wrong-index context leave technical confirmation independent of sentiment', () => {
  const input = fixture(), full = analyzeTradingEvidence(input)
  for (const context of [null, { ...input.context, instrument: 'Sensex' }, { ...input.context, retrievedAt: new Date(now - 11 * 60000).toISOString() }]) {
    const result = analyzeTradingEvidence({ ...input, context })
    assert.equal(result.canConfirm, true, result.reason)
    assert.equal(result.coverage, full.coverage - 10)
    assert(result.bullishScore < full.bullishScore, 'missing OI keeps its fixed technical budget')
    assert.equal(result.sentiment.bias, 'UNAVAILABLE')
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
  assert.equal(result.canConfirm, true, result.reason)
  assert.equal(result.layers.find(item => item.key === 'oi').coverage, 0)
  for (const key of ['flows', 'news']) assert.equal(result.sentiment.layers.find(item => item.key === key).coverage, 0)
})

test('opposing sentiment warns without changing technical scores, confirmation or price levels', () => {
  for (const direction of [1, -1]) {
    const input = fixture(direction), opposing = fixture(-direction), initial = analyzeTradingEvidence(input)
    const other = { ...opposing.context, inputs: { ...opposing.context.inputs, openInterest: input.context.inputs.openInterest } }
    const changed = analyzeTradingEvidence({ ...input, context: other, outlook: opposing.outlook })
    for (const key of ['bullishScore', 'bearishScore', 'coverage', 'bias', 'canConfirm', 'reason', 'stopLoss']) assert.equal(changed[key], initial[key], key)
    assert.equal(changed.sentiment.alignment, 'OPPOSES')
    assert.match(changed.sentiment.reason, /counter-sentiment risk/)
    for (const outlook of [opposing.outlook, undefined, { ...opposing.outlook, bias: 'MIXED', agreement: 'CONFLICTS_WITH_CHART' }]) {
      const plan = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now, other, outlook, changed).plan
      assert.equal(plan.stage, 'CONFIRMED')
      assert.equal(plan.side, direction === 1 ? 'CALL' : 'PUT')
      assert.deepEqual([plan.entry, plan.stopLoss, plan.target], [100, input.analysis.stopLoss, input.analysis.target])
      assert.equal(plan.contextMode, 'TECHNICAL_ONLY')
    }
  }
})

test('legacy technical OI/PCR is separate from the four market-context budgets', () => {
  const input = fixture(), initial = analyzeTradingEvidence(input)
  const changed = analyzeTradingEvidence({ ...input, context: { ...input.context, inputs: { ...input.context.inputs, openInterest: fixture(-1).context.inputs.openInterest } } })
  assert(changed.bullishScore < initial.bullishScore)
  assert(changed.bearishScore > initial.bearishScore)
  assert.deepEqual(initial.layers.map(layer => layer.key), ['chart', 'indicators', 'rsiVwap', 'oi'])
  assert.equal(initial.sentiment.layers.reduce((sum, layer) => sum + layer.weight, 0), 100)
  assert.equal(initial.sentiment.layers.find(layer => layer.key === 'pcr'), undefined)
  assert.equal(changed.sentiment.bullishScore, initial.sentiment.bullishScore)
  assert.equal(changed.sentiment.bearishScore, initial.sentiment.bearishScore)
})

test('ATR excludes tight invalidation and insufficient reward without manufacturing new targets', () => {
  const input = fixture()
  for (const change of [{ atr14: undefined }, { atr14: 18 }, { target: 110 }]) {
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
  assert(result.layers.find(item => item.key === 'indicators').bullish + result.layers.find(item => item.key === 'indicators').bearish <= 45)
})

test('previous-session OI and VIX cannot masquerade as current intraday confirmation inputs', () => {
  const input = fixture()
  input.context.inputs.openInterest.data.asOf = new Date(now - 31 * 60000).toISOString()
  input.indiaVix.data.asOf = new Date(now - 31 * 60000).toISOString()
  const result = analyzeTradingEvidence(input)
  assert.equal(result.layers.find(layer => layer.key === 'oi').coverage, 0)
  assert.equal(result.indiaVix, undefined)
})

test('a real-volume futures session enables VWAP while missing volume never creates a substitute', () => {
  const input = fixture(1, 'Gold'), absent = analyzeTradingEvidence(input)
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
  assert(result.sentiment.layers.find(item => item.key === 'global').bullish < .1)
})

test('actual saved institutional observations add a bounded multi-session trend and reject future reports', () => {
  const input = fixture(), initial = analyzeTradingEvidence(input)
  const reports = Array.from({ length: 5 }, (_, index) => ({ asOf: new Date(now - index * 86400000).toISOString(), fiiCash: -100, diiCash: 80, netFlow: -20, unit: 'INR_CRORE' }))
  const result = analyzeTradingEvidence({ ...input, flowHistory: [...reports, { ...reports[0], asOf: new Date(now + 86400000).toISOString() }] })
  assert.equal(result.observedFlowReports.length, 5)
  const flows = result.sentiment.layers.find(layer => layer.key === 'flows'), previous = initial.sentiment.layers.find(layer => layer.key === 'flows')
  assert(flows.coverage > previous.coverage)
  assert(flows.bearish > previous.bearish)
  assert(result.sentiment.bearishEvidence.some(item => /selling in 5\/5/.test(item)))
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
  const beyond = observePredictionTick(record, 120, now + 3000, false)
  assert.equal(beyond.status, 'ACTIVE', 'reference target does not cap profit during reassessment')
  assert.equal(observePredictionTick(beyond, beyond.protection.stop, now + 4000, false).earlyExitSource, 'AGENT_PROTECTION', 'reassessment never suspends trailing exits')
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
  assert.equal(plan.strategyVersion, 'technical-v2')
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
  assert.equal(parsed.rules.technicalEvidence.layers.length, 4)
  assert.equal(parsed.rules.technicalEvidence.bullishScore, evidence.bullishScore)
  assert.equal(parsed.rules.marketSentiment.role, 'REFERENCE_ONLY')
  assert.equal(parsed.rules.marketSentiment.bullishScore, evidence.sentiment.bullishScore)
})

test('technical confirmation requires warmed-up indicators even when sentiment is strong', () => {
  const input = fixture()
  for (const change of [{ exponentialMovingAverage50: undefined }, { rsi14: undefined }, { supertrendDirection: undefined }]) {
    const result = analyzeTradingEvidence({ ...input, analysis: { ...input.analysis, ...change } })
    assert.equal(result.canConfirm, false)
    assert.match(result.reason, /warm up/)
  }
  assert.equal(analyzeTradingEvidence({ ...input, candles: input.candles.slice(-49) }).canConfirm, false)
})

test('completed-bar EMA turns and EMA20/50 crossovers are detected in both directions without lookahead', () => {
  for (const direction of [1, -1]) {
    const closes = [...Array.from({ length: 70 }, (_, i) => 110 - i * .15), ...Array.from({ length: 60 }, (_, i) => 99.65 + i * .8)].map(value => direction === 1 ? value : 220 - value)
    let sawTurn = false, sawCross = false
    for (let length = 60; length <= closes.length; length++) {
      const candles = closes.slice(0, length).map((close, i) => [new Date(now - (length - i) * duration).toISOString(), close, close + .2, close - .2, close, 0])
      const result = analyzeIndicatorTrajectory(candles, 'FIVE_MINUTE', now)
      if (result.turns.some(turn => /EMA\(20\) turned/.test(turn.name))) {
        assert(result.turns.filter(turn => /turned/.test(turn.name)).every(turn => turn.side === (direction === 1 ? 'CALL' : 'PUT')))
        sawTurn = true
      }
      if (result.turns.some(turn => /EMA\(20\/50\) crossed/.test(turn.name))) {
        sawCross = true
        assert.equal(result.turns.find(turn => /EMA\(20\/50\) crossed/.test(turn.name)).side, direction === 1 ? 'CALL' : 'PUT')
        assert.deepEqual(analyzeIndicatorTrajectory([...candles, [new Date(now).toISOString(), 100, 1000, 1, 1000, 10000]], 'FIVE_MINUTE', now), result)
        const gap = candles.map((candle, i) => i === candles.length - 2 ? [new Date(Date.parse(candle[0]) - duration).toISOString(), ...candle.slice(1)] : candle)
        const interrupted = analyzeIndicatorTrajectory(gap, 'FIVE_MINUTE', now)
        assert.equal(interrupted.turns.length, 0)
        assert.equal(interrupted.slopeVote, undefined)
      }
    }
    assert(sawTurn, 'must observe a real EMA trajectory reversal')
    assert(sawCross, 'must observe a real EMA20/50 crossover')
  }
})

test('VWAP session reset cannot become a price/VWAP crossover', () => {
  const end = Date.parse('2026-10-13T18:30:00Z')
  const candles = Array.from({ length: 80 }, (_, i) => [new Date(end - (79 - i) * duration).toISOString(), 100, 101, 99, 100, 100])
  candles[78] = [candles[78][0], 99, 100, 98, 99, 100]
  candles[79] = [candles[79][0], 90, 91, 86, 90, 100]
  assert(!analyzeIndicatorTrajectory(candles, 'FIVE_MINUTE', end + duration).turns.some(turn => /Price \/ VWAP/.test(turn.name)))
})

test('new technical records preserve separate sentiment and legacy combined records remain readable', () => {
  const input = fixture(), evidence = analyzeTradingEvidence(input)
  const plan = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now, input.context, input.outlook, evidence).plan
  assert.equal(plan.evidenceSummary.sentiment.alignment, 'SUPPORTS')
  const legacy = { ...plan, id: plan.id.replace('technical-v2', 'combined-v1'), strategyVersion: 'combined-v1', evidenceSummary: { version: 'combined-v1', coverage: 90, atr14: 2, layers: Array.from({ length: 6 }, (_, i) => ({ name: `Legacy ${i}`, weight: i < 4 ? 17 : 16, coverage: .9, bullish: 10, bearish: 0 })) } }
  const records = [createPredictionRecord(legacy), createPredictionRecord(plan)]
  let stored
  writePredictionHistory({ setItem: (_, value) => { stored = value } }, records)
  assert.deepEqual(readPredictionHistory({ getItem: () => stored }), records)
  const invalid = structuredClone(records); invalid[1].evidenceSummary.sentiment.bullishScore = 101
  assert.throws(() => readPredictionHistory({ getItem: () => JSON.stringify({ version: 1, records: invalid }) }), /invalid format/)
  const booked = observePredictionTick(observePredictionTick(createPredictionRecord(legacy), 100, now + 1000), 120, now + 2000)
  assert.deepEqual(registerConfirmedPrediction([booked], plan, now + 2000), [booked], 'strategy change cannot reopen a traded signal')
})

test('automatic news key ignores macro revisions but changes with headline corrections and source outages', () => {
  const input = fixture(), before = newsAssessmentKey(input.context, now)
  const changed = structuredClone(input.context)
  changed.revision = 'changed-inputs'; changed.inputs.openInterest.data.pcr = .2; changed.inputs.global[0].data.changePercent = -4
  assert.equal(newsAssessmentKey(changed, now), before)
  changed.articles[0].title = 'Corrected headline'
  assert.notEqual(newsAssessmentKey(changed, now), before)
  const stale = structuredClone(input.context); stale.feeds[0].status = 'STALE'
  assert.notEqual(newsAssessmentKey(stale, now), before)
})

test('AI quota failures use concise messages and malformed news responses cannot enter the evidence pipeline', async () => {
  const input = fixture(), original = global.fetch
  try {
    global.fetch = async () => new Response(JSON.stringify({ message: 'Gemini API request failed: You exceeded your current quota. Billing details and more verbose content.' }), { status: 429 })
    await assert.rejects(getAiPriceAction(input.instrument, input.interval, input.candles, input.analysis), error => error.message === 'Gemini quota reached. Technical evaluation continues.')
    global.fetch = async () => new Response(JSON.stringify({ marketContext: input.context, marketOutlook: { contextRevision: 'wrong', articleSentiments: {} }, providerStatus: { state: 'AVAILABLE' } }))
    await assert.rejects(getNewsAssessment(input.instrument), /News assessment is unavailable/)
  } finally { global.fetch = original }
})

test('standalone cached news is snapshotted as reference without requiring chart agreement', () => {
  const input = fixture(), evidence = analyzeTradingEvidence(input)
  const prediction = buildEarlyPrediction(input.analysis, input.instrument, input.interval, now, input.context, { ...input.outlook, agreement: 'INSUFFICIENT' }, evidence)
  assert.equal(prediction.plan.stage, 'CONFIRMED')
  assert.match(prediction.plan.newsSummary, /Sentiment reference only/)
  assert.equal(prediction.plan.newsEvidence.length, 1)
})


test('full confirmation requires a current matching directional route, not only weighted scores', () => {
  for (const direction of [1,-1]) {
    const input = fixture(direction)
    for(const alignment of [undefined, {at:input.analysis.latestCandleTime,routes:[]}, {at:input.candles.at(-2)[0],routes:input.analysis.alignment.routes}, {at:input.analysis.latestCandleTime,routes:input.analysis.alignment.routes.map(route=>({...route,side:direction===1?'PUT':'CALL'}))}]) {
      const result=analyzeTradingEvidence({...input,analysis:{...input.analysis,alignment}})
      assert.equal(result.canConfirm,false)
      assert.equal(result.checks.find(check=>check.label==='Directional agreement').passed,false)
    }
  }
})

test('full CALL and PUT confirmation accepts one route family despite other indicator disagreement', () => {
  for (const direction of [1,-1]) for (const family of ['EMA','SUPERTREND','LEVEL']) {
    const input=fixture(direction), side=direction===1?'CALL':'PUT'
    input.analysis.alignment={at:input.analysis.latestCandleTime,routes:[{family,side,name:`${family} matched ${side}`} ]}
    input.analysis.rsi14=50; input.analysis.rsi14Momentum=0
    if(family!=='EMA') input.analysis.exponentialMovingAverage50=100+direction*2
    if(family!=='SUPERTREND') input.analysis.supertrendDirection=direction===1?'DOWN':'UP'
    const result=analyzeTradingEvidence(input)
    assert.equal(result.canConfirm,true,`${side} via ${family}: ${result.reason}`)
    const prediction=buildEarlyPrediction(input.analysis,input.instrument,input.interval,input.now,input.context,input.outlook,result)
    assert.equal(prediction.plan.stage,'CONFIRMED');assert.equal(prediction.plan.side,side)
  }
})

 test('ATM CE/PE supplies the technical VWAP allocation for every index and rejects stale or partial legs', () => {
  for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty']) for (const direction of [1, -1]) {
    const input = fixture(direction, instrument)
    const leg = close => ({ symbol: 'fixture', token: '1', exchange: 'NFO', close, vwap: 100, volume: 100, asOf: new Date(now).toISOString(), coverage: 'FULL_SESSION' })
    const atmVwap = { index: instrument, strike: 100, expiry: '2026-10-20', fetchedAt: new Date(now).toISOString(), method: 'SESSION_HLC3_VOLUME', referenceIndexPrice: 100, ce: leg(100 + direction * 10), pe: leg(100 - direction * 10) }
    const baseline = analyzeTradingEvidence({ ...input, atmVwap: undefined })
    const result = analyzeTradingEvidence({ ...input, atmVwap })
    const key = direction === 1 ? 'bullishScore' : 'bearishScore'
    assert(Math.abs(result[key] - baseline[key] - 25) <= .11)
    assert(!result.missing.includes('Current ATM CE/PE VWAP'))
    for (const invalid of [{ ...atmVwap, ce: { ...atmVwap.ce, coverage: 'PARTIAL_SESSION' } }, { ...atmVwap, fetchedAt: new Date(now - 120000).toISOString() }]) {
      const rejected = analyzeTradingEvidence({ ...input, atmVwap: invalid })
      assert.equal(rejected[key], baseline[key])
      assert(rejected.missing.includes('Current ATM CE/PE VWAP'))
    }
  }
 })


test('RSI level, momentum and VWAP have fixed 8/7/25 budgets and cannot borrow missing swing points', () => {
 for (const direction of [1,-1]) {
  const input=fixture(direction), result=analyzeTradingEvidence(input)
  const group=result.layers.find(layer=>layer.key==='rsiVwap')
  assert.equal(group.weight,50)
  assert.equal(group[direction===1?'bullish':'bearish'],40)
  assert.equal(group[direction===1?'bearish':'bullish'],0)
  assert.equal(group.coverage,.8)
  assert(result.missing.includes('Confirmed RSI HH/HL/LH/LL swings'))
  const missing=analyzeTradingEvidence({...input,atmVwap:undefined})
  assert.equal(missing.layers.find(layer=>layer.key==='rsiVwap')[direction===1?'bullish':'bearish'],15)
  assert.equal(missing.coverage,65)
  assert.equal(missing.canConfirm,false)
  const reversed=analyzeTradingEvidence({...input,analysis:{...input.analysis,rsi14:direction===1?30:70,rsi14Momentum:-8*direction},atmVwap:fixture(-direction).atmVwap})
  assert.equal(reversed.canConfirm,false,'opposing RSI/VWAP must affect the full confirmation pipeline')
 }
})

test('actual completed RSI HH/HL and LH/LL swings contribute ten points; a structure break reverses that vote', () => {
 const time=Date.parse('2026-10-16T14:00:00+05:30')
 for (const [frequency,slope,acceleration,trend,jump,breakDirection] of [[1,-3,.05,'HH / HL',-100,'DOWN'],[.7,0,-.05,'LH / LL',100,'UP']]) {
  const candles=Array.from({length:52},(_,i)=>{const close=1000+slope*i+acceleration*i*i+20*Math.sin(i*frequency);return[new Date(time-(52-i)*duration).toISOString(),close-1,close+2,close-2,close,0]})
  const input=fixture()
  const analyze=bars=>analyzeTradingEvidence({...input,candles:bars,now:time,atmVwap:undefined,analysis:{...input.analysis,latestCandleTime:bars[51][0],currentPrice:bars[51][4],rsi14:50,rsi14Momentum:0}})
  const group=analyze(candles).layers.find(layer=>layer.key==='rsiVwap')
  assert(group.details.includes(`RSI structure: ${trend}`))
  assert.equal(group[trend==='HH / HL'?'bullish':'bearish'],10)
  const close=candles[51][4]+jump
  const broken=[...candles.slice(0,-1),[candles[51][0],close-1,close+2,close-2,close,0]]
  const reversed=analyze(broken).layers.find(layer=>layer.key==='rsiVwap')
  assert(reversed.details.includes(`RSI structure: ${trend} · broken ${breakDirection.toLowerCase()}`))
  assert.equal(reversed[breakDirection==='UP'?'bullish':'bearish'],10)
  const forming=[new Date(time).toISOString(),close,close+500,close-500,close+400,1000]
  assert.deepEqual(analyze([...candles,forming]).layers.find(layer=>layer.key==='rsiVwap'),group)
 }
})


test('a fresh current ATM snapshot is matched to its index quote rather than a slower completed candle close', () => {
 const input=fixture()
 const atmVwap={...input.atmVwap,strike:250,referenceIndexPrice:251}
 const result=analyzeTradingEvidence({...input,atmVwap})
 assert(!result.missing.includes('Current ATM CE/PE VWAP'))
 assert.equal(result.layers.find(layer=>layer.key==='rsiVwap').bullish,40)
 assert.equal(analyzeTradingEvidence({...input,atmVwap:{...atmVwap,index:'Sensex'}}).layers.find(layer=>layer.key==='rsiVwap').bullish,15)
})
