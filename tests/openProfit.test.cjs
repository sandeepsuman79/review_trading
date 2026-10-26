const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
const compile = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, filename)
require.extensions['.ts'] = compile
require.extensions['.tsx'] = compile
const { createPredictionRecord, observePredictionTick, observePredictionCandles, syncPredictionRecord, readPredictionHistory, writePredictionHistory, registerConfirmedPrediction } = require('../src/analysis/predictionHistory.ts')
const { predictionEvents } = require('../src/analysis/predictionEvents.ts')
const { commoditySpecs, mcxSession } = require('../src/analysis/commodities.ts')
const now = Date.parse('2026-10-16T13:00:00+05:30'), duration = 300000
function pending(instrument = 'Nifty 50', side = 'CALL') {
  const d = side === 'CALL' ? 1 : -1, spec = commoditySpecs.find(item => item.name === instrument)
  const contract = spec ? { name: instrument, root: spec.root, token: '12345', symbol: `${spec.root}20NOV26FUT`, expiry: '2026-11-20', expiresAt: mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close, exchange: 'MCX', exchangeType: 5, tickSize: spec.root === 'NATURALGAS' ? .1 : 1 } : undefined
  return createPredictionRecord({ id: `${instrument}:${side}`, instrument, contract, side, interval: 'FIVE_MINUTE', stage: 'CONFIRMED', strategyVersion: 'technical-v2', signalCandleTime: new Date(now - duration).toISOString(), generatedAt: now, expiresAt: now + duration, entry: 1000, stopLoss: 1000 - d * 10, target: 1000 + d * 12, riskReward: 1.2, reason: 'Fixture', technicalEvidence: [], newsEvidence: [], newsSummary: '', contextMode: 'TECHNICAL_ONLY', coverage: [], bullishScore: 70, bearishScore: 10, targetBasis: 'Observed chart reference' })
}
function reload(record) {
  let saved
  writePredictionHistory({ setItem: (_, value) => { saved = value } }, [record])
  return readPredictionHistory({ getItem: () => saved })[0]
}

test('all seven instruments and both directions run beyond 1.2R, 2R, 3R and 5R and close only on the observed TSL breach', () => {
  for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty', ...commoditySpecs.map(item => item.name)]) for (const side of ['CALL', 'PUT']) {
    const d = side === 'CALL' ? 1 : -1, candidate = pending(instrument, side)
    let record = observePredictionTick(candidate, 1000, now + 1)
    for (const [i, gain] of [12, 20, 30, 50].entries()) {
      const previous = record
      record = observePredictionTick(record, 1000 + d * gain, now + i + 2)
      assert.equal(record.status, 'ACTIVE', `${instrument} ${side} +${gain / 10}R`)
      assert.equal(record.points, undefined); assert.equal(record.exitPrice, undefined)
      assert.equal(record.target, candidate.target)
      assert.equal(record.protection.risk, 10)
      assert((record.protection.stop - previous.protection.stop) * d >= 0)
      assert.deepEqual(predictionEvents([previous], [record]), [], 'a reference crossing is not an exit notification')
    }
    assert((record.protection.stop - record.target) * d > 0, 'TSL may move past the reference')
    record = reload(record)
    assert.throws(() => reload({ ...record, protection: { ...record.protection, stop: record.protection.peakPrice + d } }), /invalid format/, 'a trail beyond its observed peak remains invalid')
    assert.equal(registerConfirmedPrediction([record], { ...candidate, id: 'replacement', side: side === 'CALL' ? 'PUT' : 'CALL' }, now + 10).length, 1, 'open runners still prevent overlapping entries')
    const exit = record.protection.stop - d * 2
    const closed = observePredictionTick(record, exit, now + 20)
    assert.equal(closed.status, 'EARLY_EXIT'); assert.equal(closed.earlyExitSource, 'AGENT_PROTECTION')
    assert.equal(closed.exitPrice, exit); assert.equal(closed.points, 33)
    assert.equal(predictionEvents([record], [closed])[0].reason, 'Protective exit')
    assert.deepEqual(reload(closed), closed)
    assert.equal(observePredictionTick(closed, 1000 + d * 100, now + 21), closed)
  }
})

test('entry retains the 1.20 minimum and cannot chase a consumed reference move', () => {
  for (const side of ['CALL', 'PUT']) {
    const d = side === 'CALL' ? 1 : -1, candidate = pending('Nifty 50', side)
    assert.equal(observePredictionTick(candidate, 1000, now + 1).status, 'ACTIVE')
    assert.equal(observePredictionTick(candidate, 1000 + d * .01, now + 1).status, 'EXPIRED')
    assert.equal(observePredictionTick(candidate, candidate.target, now + 1).status, 'EXPIRED')
  }
})

test('fresh TSL and initial-stop breaches close immediately after quote gaps instead of becoming unverified', () => {
  for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty', ...commoditySpecs.map(item => item.name)]) for (const side of ['CALL', 'PUT']) for (const trailing of [false, true]) {
    const d = side === 'CALL' ? 1 : -1, candidate = pending(instrument, side)
    let active = observePredictionTick(candidate, 1000, now + 1)
    if (trailing) active = observePredictionTick(active, 1000 + d * 50, now + 2)
    const exit = 1000 + d * (trailing ? 30 : -15), observedAt = now + 45000
    const tick = { token: active.contract?.token ?? '99926000', exchangeType: active.contract ? 5 : 1, timestamp: observedAt, ltp: exit }
    const overlap = [[new Date(now).toISOString(), 1000, 1060, 940, exit, 0]]
    const waiting = syncPredictionRecord(active, overlap, undefined, now + duration, false, undefined, null)
    assert.equal(waiting.status, 'ACTIVE', 'history recovery must not permanently retire a saved position before the exit quote arrives')
    assert.match(waiting.outcomeNote, /Recovering saved trade/); assert.equal(waiting.points, undefined)
    const later = now + duration + 1000
    assert.equal(syncPredictionRecord(waiting, overlap, { ...tick, timestamp: later }, later, false, undefined, null).exitPrice, exit)
    // The forming candle includes prices before the saved quote/TSL. After it
    // closes, that overlap used to suppress even an observed exit as UNVERIFIED.
    for (const [time, bars] of [[observedAt, []], [now + duration + 1000, [[new Date(now).toISOString(), 1000, 1060, 940, exit, 0]]]]) {
      const quote = { ...tick, timestamp: time }
      const closed = syncPredictionRecord(active, bars, quote, time, false, undefined, null)
      assert.equal(closed.status, trailing ? 'EARLY_EXIT' : 'STOP_LOSS_HIT', `${instrument} ${side} ${trailing} ${time}`)
      assert.equal(closed.earlyExitSource, trailing ? 'AGENT_PROTECTION' : undefined)
      assert.equal(closed.exitPrice, exit); assert.equal(closed.exitAt, time)
      assert.equal(closed.points, trailing ? 30 : -15)
      assert.match(closed.outcomeNote, /no earlier intrabar fill was assumed/)
      assert.deepEqual(reload(closed), JSON.parse(JSON.stringify(closed)))
      assert.equal(predictionEvents([active], [closed]).length, 1)
    }
    for (const changed of [{ ...tick, timestamp: observedAt - 31000 }, { ...tick, timestamp: observedAt + 1001 }, { ...tick, ltp: NaN }, ...(active.contract ? [{ ...tick, token: 'wrong' }] : [])]) {
      assert.equal(syncPredictionRecord(active, [], changed, observedAt, false, undefined, null).exitPrice, undefined, 'invalid or stale quotes cannot invent an exit')
    }
  }
})

test('recovery uses observed candle closes to trail beyond the reference without inventing intrabar peaks', () => {
  for (const side of ['CALL', 'PUT']) {
    const d = side === 'CALL' ? 1 : -1
    const candidate = pending('Nifty 50', side)
    const active = { ...candidate, status: 'ACTIVE', entryAt: now, entryPrice: 1000 }
    const bar = (start, open, favourable, adverse, close) => [new Date(start).toISOString(), 1000 + d * open, 1000 + (d === 1 ? favourable : -adverse), 1000 + (d === 1 ? adverse : -favourable), 1000 + d * close, 0]
    const first = bar(now, 0, 80, -1, 30)
    const recovered = observePredictionCandles(active, [first], now + duration, false)
    assert.equal(recovered.status, 'ACTIVE'); assert.equal(recovered.protection.peakPrice, 1000 + d * 30)
    assert.equal(recovered.protection.stop, 1000 + d * 15, 'trail the close, not the unobserved 8R extreme')
    const second = bar(now + duration, 30, 60, 20, 50)
    const runner = observePredictionCandles(recovered, [second], now + 2 * duration, false)
    assert.equal(runner.status, 'ACTIVE'); assert.equal(runner.protection.stop, 1000 + d * 35)
    const stopped = observePredictionCandles(runner, [bar(now + 2 * duration, 50, 70, 30, 40)], now + 3 * duration, false)
    assert.equal(stopped.status, 'EARLY_EXIT'); assert.equal(stopped.points, 35)
    const overlapping = observePredictionCandles({ ...active, observedThrough: now + 1000 }, [first], now + duration, false)
    assert.equal(overlapping.status, 'ACTIVE', 'crossing a reference during reconnect is harmless if the saved stop was untouched')
  }
})

test('saved completed target outcomes stay terminal and readable', () => {
  const active = observePredictionTick(pending(), 1000, now + 1)
  const legacy = reload({ ...active, status: 'TARGET_HIT', exitAt: now + 2, exitPrice: 1012, points: 12, observedThrough: now + 2 })
  assert.equal(observePredictionTick(legacy, 1050, now + 3), legacy)
})

test('observed stop exits stay DONE with booked P/L after persistence and a conflicting recovery snapshot', async () => {
  const { createPredictionHistoryStore } = require('../src/storage/predictionHistoryStore.ts')
  const { predictionHistoryKey } = require('../src/analysis/predictionHistory.ts')
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server')
  const ConfirmedTrades = require('../src/components/ConfirmedTrades.tsx').default
  for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty', ...commoditySpecs.map(item => item.name)]) for (const side of ['CALL', 'PUT']) for (const trailing of [false, true]) {
    const d = side === 'CALL' ? 1 : -1, values = new Map()
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
    let saved
    const backend = { read: async () => saved, transact: async update => { saved = update(saved); return saved } }
    const store = createPredictionHistoryStore({ backend, storage })
    await store.load()
    let active = observePredictionTick(pending(instrument, side), 1000, now + 1)
    if (trailing) active = observePredictionTick(active, 1000 + d * 50, now + 2)
    await store.update(() => [active])
    const exitPrice = 1000 + d * (trailing ? 30 : -15), time = now + 45000
    const tick = { token: active.contract?.token ?? '99926000', exchangeType: active.contract ? 5 : 1, timestamp: time, ltp: exitPrice }
    const closed = await store.update(records => records.map(record => syncPredictionRecord(record, [], tick, time)))
    assert(closed.durable)
    storage.setItem(predictionHistoryKey, JSON.stringify({ version: 1, records: [{ ...active, status: 'UNVERIFIED', observedThrough: now + duration }] }))
    const restored = await createPredictionHistoryStore({ backend, storage }).load()
    const html = renderToStaticMarkup(React.createElement(ConfirmedTrades, { records: restored, now: time + 1, streamConnected: false, storageError: '' }))
    assert.match(html, /DONE/); assert.match(html, /Booked P\/L/)
    assert.match(html, trailing ? /Trailing profit protection/ : /Stop-loss hit/)
    assert.doesNotMatch(html, /unverified|Unverified|UNVERIFIED|Unrealized/)
    assert.equal(restored[0].exitPrice, exitPrice); assert.equal(restored[0].points, trailing ? 30 : -15)
  }
})

test('both confirmed card views show the saved TSL and open profit beyond the reference', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server')
  const ConfirmedTrades = require('../src/components/ConfirmedTrades.tsx').default
  const AgentTradeCard = require('../src/components/AgentTradeCard.tsx').default
  for (const side of ['CALL', 'PUT']) {
    const d = side === 'CALL' ? 1 : -1
    const active = observePredictionTick(observePredictionTick(pending('Nifty 50', side), 1000, now + 1), 1000 + d * 50, now + 2)
    const list = renderToStaticMarkup(React.createElement(ConfirmedTrades, { records: [active], now: now + 3, streamConnected: true, storageError: '' }))
    assert.match(list, /Current TSL/); assert(list.includes(active.protection.stop.toLocaleString('en-IN', { minimumFractionDigits: 2 })))
    assert.match(list, /Open profit/)
    const analysis = { side, analyzedCandles: 80, earlyBias: side === 'CALL' ? 'BULLISH' : 'BEARISH', earlyStrength: 'STRONG', bullishScore: 70, bearishScore: 10, bullishEvidence: [], bearishEvidence: [], structure: 'Fixture', location: 'Fixture', candleBehavior: 'Fixture', setup: 'Fixture' }
    const card = renderToStaticMarkup(React.createElement(AgentTradeCard, { activeTrade: active, records: [active], analysis, prediction: { side: 'WAIT', reason: '' }, instrument: 'Nifty 50', interval: 'FIVE_MINUTE', now: now + 3, streamConnected: true }))
    assert.match(card, /Current TSL/); assert.match(card, /\+5\.00R/); assert.match(card, /Reference target/)
    assert.doesNotMatch(card, /agent-trade-progress-track/, 'an active runner has no bounded target progress meter')
  }
})
