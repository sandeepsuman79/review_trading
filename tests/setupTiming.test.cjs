const atmVwapFixture = require('./helpers/atmVwap.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
const { createPredictionRecord, observePredictionTick, syncPredictionRecord } = require('../src/analysis/predictionHistory.ts')
const { currentSetupPrediction, consumedSetupReason } = require('../src/analysis/setupTiming.ts')
const close = Date.parse('2026-10-16T10:00:00+05:30'), duration = 300000
function pending(side = 'CALL') {
  const d = side === 'CALL' ? 1 : -1
  return createPredictionRecord({ id: `timing:${side}`, instrument: 'Nifty 50', interval: 'FIVE_MINUTE', side, stage: 'CONFIRMED', strategyVersion: 'technical-v2', signalCandleTime: new Date(close - duration).toISOString(), generatedAt: close + 5000, expiresAt: close + 3 * duration, entry: 1000, stopLoss: 1000 - d * 10, target: 1000 + d * 20, riskReward: 2, bullishScore: 70, bearishScore: 10, technicalEvidence: [], newsEvidence: [], coverage: [], reason: '', newsSummary: '', targetBasis: '', contextMode: 'TECHNICAL_ONLY' })
}
const tick = (time, ltp) => ({ token: '99926000', exchangeType: 1, mode: 1, timestamp: time, ltp })
test('a target reached while entry is paused consumes the setup; a retracement cannot create a late trade', () => {
  for (const side of ['CALL', 'PUT']) {
    const item = pending(side), d = side === 'CALL' ? 1 : -1
    const spent = observePredictionTick(item, item.target, close + 10000, false)
    assert.equal(spent.status, 'EXPIRED', side)
    assert.equal(observePredictionTick(spent, 1000 + d, close + 11000).entryAt, undefined)
  }
})
test('legacy fifteen-minute pending deadlines cannot admit a technical entry after the next five-minute close', () => {
  const saved = { ...pending(), expiresAt: close + 3 * duration }
  const item = observePredictionTick(saved, 1000, close + duration)
  assert.equal(item.status, 'EXPIRED'); assert.equal(item.entryAt, undefined)
})
test('post-signal candle extremes consume a setup even if the latest reconnect quote has retraced', () => {
  for (const side of ['CALL', 'PUT']) for (const level of ['target', 'stopLoss']) {
    const item = pending(side), d = side === 'CALL' ? 1 : -1, price = item[level]
    const forming = [new Date(close).toISOString(), 1000, Math.max(1001, price), Math.min(999, price), 1000 + d, 0]
    const result = syncPredictionRecord(item, [forming], tick(close + 6000, 1000 + d), close + 6000, true, item, null)
    assert.equal(result.status, 'EXPIRED', `${side} ${level}`); assert.equal(result.entryAt, undefined)
  }
})
test('finished and expired ledger setups cannot reappear as fresh confirmed trade cards', () => {
  const plan = pending(), prediction = { side: plan.side, plan, reason: 'Confirmed' }
  for (const status of ['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT', 'EXPIRED', 'UNVERIFIED', 'AMBIGUOUS']) {
    const result = currentSetupPrediction(prediction, [{ ...plan, status, outcomeNote: 'Recorded outcome' }], [], close + 6000)
    assert.equal(result.side, 'WAIT'); assert.match(result.reason, /setup has ended/)
  }
  assert.equal(currentSetupPrediction(prediction, [plan], [], close + 6000), prediction)
  assert.equal(currentSetupPrediction(prediction, [{ ...plan, id: 'another signal', status: 'TARGET_HIT' }], [], close + 6000), prediction)
})
test('the signal candle, future bars and malformed prices do not consume a valid current setup; active trades retain their lifecycle', () => {
  const plan = pending(), bar = time => [new Date(time).toISOString(), 1000, 1040, 960, 1001, 0]
  assert.equal(consumedSetupReason(plan, [bar(close - duration)], close + 6000), undefined)
  assert.equal(consumedSetupReason(plan, [bar(close + duration)], close + 6000), undefined)
  assert.equal(consumedSetupReason(plan, [[new Date(close).toISOString(), 1000, NaN, 900, 1001, 0]], close + 6000), undefined)
  const active = observePredictionTick(plan, 1000, close + 6000)
  const result = syncPredictionRecord(active, [bar(close)], tick(close + 7000, 1021), close + 7000, true, undefined, null)
  assert.equal(result.status, 'TARGET_HIT'); assert.equal(result.points, 20)
})
test('real five-minute pattern scoring rejects consumed moves symmetrically across all seven instruments', () => {
  const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
  const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
  const { buildEarlyPrediction } = require('../src/analysis/earlyPrediction.ts')
  const { mcxSession } = require('../src/analysis/commodities.ts')
  const at = Date.parse('2026-10-16T14:00:00+05:30')
  const markets = [['Nifty 50',22000,1],['Sensex',74000,3],['Bank Nifty',50000,2],['Natural Gas',300,.2,'NATURALGAS'],['Crude Oil',6000,2,'CRUDEOIL'],['Gold',110000,10,'GOLD'],['Silver',90000,10,'SILVER']]
  for (const [instrument, base, scale, root] of markets) for (const d of [1,-1]) {
    const contract = root ? { name:instrument, root, token:'12345', symbol:`${root}20NOV26FUT`, exchange:'MCX', exchangeType:5, expiry:'2026-11-20', expiresAt:mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close, tickSize:root === 'NATURALGAS' ? .1 : 1 } : undefined
    const candles = Array.from({length:52}, (_,i) => { const o = base + d*(i*.3+Math.sin(i/4)*6)*scale, c = o+d*2*scale; return [new Date(at-(52-i)*duration).toISOString(), o, Math.max(o,c)+.7*scale, Math.min(o,c)-.7*scale, c, root ? 100 : 0] })
    const analysis = analyzePriceAction(candles, 'FIVE_MINUTE', at, instrument)
    const evidence = analyzeTradingEvidence({ analysis, candles, instrument, interval:'FIVE_MINUTE', now:at, atmVwap: root ? undefined : atmVwapFixture(instrument,analysis.currentPrice,at,d) })
    const prediction = buildEarlyPrediction(analysis, instrument, 'FIVE_MINUTE', at, undefined, undefined, evidence, contract)
    assert.equal(prediction.plan?.stage, 'CONFIRMED', `${instrument}: ${prediction.reason}`)
    assert.equal(prediction.plan.side, d === 1 ? 'CALL' : 'PUT')
    assert.equal(prediction.plan.expiresAt, at+duration)
    const entry = prediction.plan.entry, target = prediction.plan.target
    const fresh = [new Date(at).toISOString(),entry,entry,entry,entry,root?100:0]
    assert.equal(currentSetupPrediction(prediction, [], [...candles,fresh], at+10000).side, prediction.side)
    const record = createPredictionRecord({...prediction.plan,generatedAt:at+5000})
    const quote = { ...tick(at+6000,entry), token:contract?.token ?? '99926000', exchangeType:contract?5:1 }
    assert.equal(syncPredictionRecord(record, [...candles,fresh], quote, at+6000, true, prediction.plan, null).status, 'ACTIVE')
    const spent = [new Date(at).toISOString(),entry,Math.max(entry,target),Math.min(entry,target),entry,root?100:0]
    assert.equal(currentSetupPrediction(prediction, [], [...candles, spent], at+10000).side, 'WAIT')
    assert.equal(syncPredictionRecord(record, [...candles, spent], quote, at+6000, true, prediction.plan, null).status, 'EXPIRED')
  }
})
test('an entry reconstructed after the trade ended must not announce a new confirmed trade', () => {
  const { observePredictionCandles } = require('../src/analysis/predictionHistory.ts')
  const { predictionEvents } = require('../src/analysis/predictionEvents.ts')
  const item = { ...pending(), strategyVersion:'early-v1', generatedAt:close, observedThrough:close, expiresAt:close+3*duration }
  const terminal = observePredictionCandles(item, [[new Date(close).toISOString(),1000,1021,999,1020,0]], close+duration)
  assert.equal(terminal.status, 'TARGET_HIT')
  const events = predictionEvents([item],[terminal])
  assert.equal(events.length, 1); assert.doesNotMatch(events[0].reason, /Confirm call|Entry reached/)
})
test('only a fresh live entry can announce confirmation, never a replayed entry refreshed by a later quote', () => {
  const { observePredictionCandles } = require('../src/analysis/predictionHistory.ts')
  const { predictionEvents } = require('../src/analysis/predictionEvents.ts')
  const item = { ...pending(), strategyVersion:'early-v1', generatedAt:close, observedThrough:close, expiresAt:close+3*duration }
  const replayed = observePredictionCandles(item, [[new Date(close).toISOString(),1000,1002,999,1001,0]], close+duration)
  const updated = observePredictionTick(replayed, 1002, close+duration+1000)
  assert.equal(updated.status,'ACTIVE'); assert.equal(updated.entrySource,'CANDLE')
  assert.deepEqual(predictionEvents([item],[updated],close+duration+1000),[])
  const live = observePredictionTick(item,1000,close+1000)
  assert.equal(predictionEvents([item],[live],close+2000).length,1)
  assert.deepEqual(predictionEvents([item],[live],close+32000),[])
})
