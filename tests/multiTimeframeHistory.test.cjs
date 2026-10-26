const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename)
const {
  createPredictionRecord, registerConfirmedPrediction, canEnterConfirmedPrediction, observePredictionTick,
  observeConfirmedAgentReversal, syncPredictionRecord, readPredictionHistory, writePredictionHistory,
  reconcilePredictionRecords,
} = require('../src/analysis/predictionHistory.ts')
const { matchingProtectionAssessment, updateTradeProtection } = require('../src/analysis/tradeProtection.ts')
const { currentSetupPrediction } = require('../src/analysis/setupTiming.ts')
const { mcxSession } = require('../src/analysis/commodities.ts')
const intervals = ['FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR']
const durations = { ONE_MINUTE: 60000, FIVE_MINUTE: 300000, FIFTEEN_MINUTE: 900000, ONE_HOUR: 3600000 }
const now = Date.parse('2026-10-16T13:15:01+05:30')
const instruments = [
  ['Nifty 50'], ['Sensex'], ['Bank Nifty'], ['Natural Gas', 'NATURALGAS'],
  ['Crude Oil', 'CRUDEOIL'], ['Gold', 'GOLD'], ['Silver', 'SILVER'],
]
function plan(interval = 'FIFTEEN_MINUTE', side = 'CALL', [instrument, root] = instruments[0]) {
  const d = side === 'CALL' ? 1 : -1, duration = durations[interval]
  const open = Date.parse(`2026-10-16T${root ? '09:00' : '09:15'}:00+05:30`)
  const start = open + Math.floor((now - open) / duration) * duration - duration
  const contract = root ? {
    name: instrument, root, token: '12345', symbol: `${root}20NOV26FUT`, exchange: 'MCX', exchangeType: 5,
    expiry: '2026-11-20', expiresAt: mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close,
    tickSize: root === 'NATURALGAS' ? .1 : 1,
  } : undefined
  return {
    id: `${instrument}:${interval}:${side}`, instrument, interval, contract, side, stage: 'CONFIRMED',
    strategyVersion: 'technical-v2', signalCandleTime: new Date(start).toISOString(), generatedAt: now,
    expiresAt: start + 2 * duration, entry: 1000, stopLoss: 1000 - d * 10, target: 1000 + d * 30,
    riskReward: 3, reason: 'Controlled confirmed plan', targetBasis: 'Controlled levels',
    contextMode: 'TECHNICAL_ONLY', bullishScore: side === 'CALL' ? 70 : 10, bearishScore: side === 'PUT' ? 70 : 10,
    technicalEvidence: [], newsEvidence: [], newsSummary: 'Unavailable', coverage: [],
  }
}
function active(interval = 'FIFTEEN_MINUTE', side = 'CALL', instrument = instruments[0]) {
  return {
    ...createPredictionRecord(plan(interval, side, instrument)), status: 'ACTIVE', entryPrice: 1000,
    id: `active:${instrument[0]}:${interval}:${side}`, generatedAt: now - 2 * 3600000 - 1000,
    entryAt: now - 2 * 3600000, observedThrough: now - 1000, latestPrice: 1000,
    latestPriceAt: now, latestPriceSource: 'LIVE', entrySource: 'LIVE',
  }
}
const quote = (record, time, ltp) => ({ token: record.contract?.token ?? '99926000', exchangeType: record.contract ? 5 : 1, timestamp: time, ltp })
const assessment = (record, interval = 'FIFTEEN_MINUTE', atr = 2) => ({
  instrument: record.instrument, contractToken: record.contract?.token, interval,
  asOf: plan(interval, record.side, instruments.find(row => row[0] === record.instrument)).signalCandleTime,
  reviewedAt: now, atr,
})

test('all seven instruments independently register and enter CALL/PUT or LONG/SHORT on 5, 15 and 60 minutes', () => {
  for (const instrument of instruments) for (const interval of intervals) for (const side of ['CALL', 'PUT']) {
    const candidate = plan(interval, side, instrument)
    const registered = registerConfirmedPrediction([], candidate, now)
    assert.equal(registered.length, 1, `${instrument[0]} ${interval} ${side}`)
    assert(canEnterConfirmedPrediction(registered[0], candidate, now, now + 1000))
    const entered = syncPredictionRecord(registered[0], [], quote(registered[0], now + 1000, 1000), now + 1000, true, candidate, null)
    assert.equal(entered.status, 'ACTIVE'); assert.equal(entered.entrySource, 'LIVE')
    assert.equal(entered.interval, interval)
    assert.equal(registerConfirmedPrediction([entered], plan(interval, side === 'CALL' ? 'PUT' : 'CALL', instrument), now + 1000).length, 1, 'a live instrument position cannot overlap')
  }
})

test('fresh confirmed opposite setups on any supported timeframe exit the existing position automatically', () => {
  for (const instrument of instruments) for (const interval of intervals) for (const side of ['CALL', 'PUT']) {
    const record = active('FIFTEEN_MINUTE', side, instrument), opposite = plan(interval, side === 'CALL' ? 'PUT' : 'CALL', instrument)
    const closed = syncPredictionRecord(record, [], quote(record, now, 1000 + (side === 'CALL' ? 2 : -2)), now, false, undefined, opposite)
    assert.equal(closed.status, 'EARLY_EXIT', `${instrument[0]} ${interval} ${side}`)
    assert.equal(closed.earlyExitSource, 'AGENT_REVERSAL'); assert.equal(closed.reversalInterval, interval)
    assert.equal(closed.points, 2); assert.equal(closed.exitAt, now)
  }
})

test('forming, old, same-side and wrong-contract plans cannot create reversal exits', () => {
  const record = active('FIFTEEN_MINUTE', 'CALL', instruments[4])
  for (const interval of intervals) {
    const opposite = plan(interval, 'PUT', instruments[4]), start = Date.parse(opposite.signalCandleTime)
    for (const changed of [
      { ...opposite, generatedAt: now - 30001 }, { ...opposite, generatedAt: now + 1 },
      { ...opposite, signalCandleTime: new Date(now).toISOString() }, { ...opposite, stage: 'EARLY' },
      { ...opposite, side: 'CALL' }, { ...opposite, contract: { ...opposite.contract, token: 'wrong' } },
      { ...opposite, contract: { ...opposite.contract, symbol: 'different-contract' } },
    ]) assert.equal(observeConfirmedAgentReversal(record, changed, now).status, 'ACTIVE')
    assert.equal(observeConfirmedAgentReversal({ ...record, entryAt: start + 1 }, opposite, now).status, 'ACTIVE', 'only full post-entry candles may reverse')
    assert.equal(observeConfirmedAgentReversal({ ...record, latestPriceAt: start + durations[interval] - 1 }, opposite, now).status, 'ACTIVE', 'quote must arrive after the signal close')
    assert.equal(observeConfirmedAgentReversal(record, { ...opposite, generatedAt: now - 30000 }, now).status, 'EARLY_EXIT', 'thirty seconds is the inclusive freshness boundary')
  }
})

test('original stops settle first; supported-timeframe reversals still exit beyond reference targets', () => {
  for (const interval of intervals) for (const side of ['CALL', 'PUT']) {
    const record = active('FIFTEEN_MINUTE', side, instruments[4]), opposite = plan(interval, side === 'CALL' ? 'PUT' : 'CALL', instruments[4])
    const d = side === 'CALL' ? 1 : -1
    const stopped = syncPredictionRecord(record, [], quote(record, now, record.stopLoss - d), now, false, undefined, opposite)
    assert.equal(stopped.status, 'STOP_LOSS_HIT'); assert.equal(stopped.exitPrice, record.stopLoss - d)
    const target = syncPredictionRecord(record, [], quote(record, now, record.target + d), now, false, undefined, opposite)
    assert.equal(target.status, 'EARLY_EXIT'); assert.equal(target.earlyExitSource, 'AGENT_REVERSAL'); assert.equal(target.exitPrice, record.target + d)
  }
})

test('1-minute records remain readable but cannot register, enter, reverse or run minute protection', () => {
  const candidate = plan('ONE_MINUTE'), pending = createPredictionRecord(candidate)
  assert.deepEqual(registerConfirmedPrediction([], candidate, now), [])
  assert.equal(canEnterConfirmedPrediction(pending, candidate, now, now), false)
  assert.equal(observePredictionTick(pending, 1000, now + 1).status, 'EXPIRED')
  assert.equal(reconcilePredictionRecords([pending])[0].status, 'EXPIRED')
  const record = active('ONE_MINUTE'), opposite = plan('ONE_MINUTE', 'PUT')
  assert.equal(observeConfirmedAgentReversal(record, opposite, now).status, 'ACTIVE')
  const removedMinuteReview = { ...assessment(record), interval: 'ONE_MINUTE', current: true, pressure: { side: 'PUT', confirmed: true, reasons: ['minute noise'] } }
  assert.equal(syncPredictionRecord(record, [], quote(record, now, 999), now, false, undefined, null, removedMinuteReview).status, 'ACTIVE')
  let saved
  writePredictionHistory({ setItem: (_, value) => { saved = value } }, [pending, record])
  assert.deepEqual(readPredictionHistory({ getItem: () => saved }), JSON.parse(saved).records)
  assert.equal(observeConfirmedAgentReversal(record, plan('FIVE_MINUTE', 'PUT'), now).status, 'EARLY_EXIT', 'legacy positions still receive supported timeframe reversals')
})

test('trailing ATR uses only a fresh current completed 5/15/60 assessment for the same contract and never loosens', () => {
  for (const side of ['CALL', 'PUT']) for (const interval of intervals) {
    const record = active(interval, side, instruments[4]), d = side === 'CALL' ? 1 : -1, context = assessment(record, interval)
    assert(matchingProtectionAssessment(record, context, now))
    for (const changed of [
      { ...context, reviewedAt: now - 30001 }, { ...context, reviewedAt: now + 1 },
      { ...context, asOf: new Date(now).toISOString() }, { ...context, asOf: new Date(now - 3 * durations[interval]).toISOString() },
      { ...context, instrument: 'Gold' }, { ...context, contractToken: 'wrong' }, { ...context, interval: 'ONE_MINUTE' },
    ]) {
      assert.equal(matchingProtectionAssessment(record, changed, now), false)
      assert.equal(updateTradeProtection(record, 1000 + d * 8, now, changed).protection.atr, 10, 'invalid assessment uses saved or entry ATR/risk')
    }
    let tracked = observePredictionTick(record, 1000 + d * 8, now, true, context)
    assert(tracked.protection.armed); assert.equal(tracked.protection.atr, 2)
    tracked = observePredictionTick(tracked, 1000 + d * 15, now + 1, true, context)
    const stop = tracked.protection.stop
    tracked = observePredictionTick(tracked, 1000 + d * 14, now + 2, true, { ...context, atr: 100 })
    assert.equal(tracked.protection.stop, stop)
    const closed = observePredictionTick(tracked, stop - d, now + 3, true, context)
    assert.equal(closed.status, 'EARLY_EXIT'); assert.equal(closed.earlyExitSource, 'AGENT_PROTECTION'); assert(closed.points > 0)
  }
})

test('a reversal cannot reopen the exited direction from an older competing timeframe; opposite and genuinely newer setups remain automatic', () => {
  for (const instrument of [instruments[0], instruments[4]]) for (const side of ['CALL', 'PUT']) for (const interval of intervals) {
    const previous = { ...active('FIFTEEN_MINUTE', side, instrument), status: 'EARLY_EXIT', earlyExitSource: 'AGENT_REVERSAL', exitAt: now, exitPrice: 1000, points: 0 }
    const candidate = plan(interval, side, instrument), prediction = { side, plan: candidate, reason: 'Current technical confirmation' }
    assert.equal(registerConfirmedPrediction([previous], candidate, now).length, 1)
    const held = currentSetupPrediction(prediction, [previous], [], now)
    assert.equal(held.side, 'WAIT'); assert.match(held.reason, /newly completed setup/)
    const opposite = plan(interval, side === 'CALL' ? 'PUT' : 'CALL', instrument)
    assert.equal(registerConfirmedPrediction([previous], opposite, now).length, 2, 'opposite replacement has no added delay')
    assert.equal(currentSetupPrediction({ ...prediction, side: opposite.side, plan: opposite }, [previous], [], now).side, opposite.side)
    const closedAt = Date.parse(candidate.signalCandleTime) + 2 * durations[interval], later = closedAt + 1000
    const fresh = { ...candidate, id: `${candidate.id}:next`, signalCandleTime: new Date(closedAt - durations[interval]).toISOString(), generatedAt: later, expiresAt: closedAt + durations[interval] }
    assert.equal(registerConfirmedPrediction([previous], fresh, later).length, 2, 'newly completed candle may re-enter the exited side')
    assert.equal(currentSetupPrediction({ ...prediction, plan: fresh }, [previous], [], later).side, side)
  }
})

test('a preceding exit clock skew cannot move a technical candidate issue time onto its anchored deadline', () => {
  for (const interval of intervals) {
    const candidate = { ...plan(interval), expiresAt: now + 3 * durations[interval] }
    const deadline = Date.parse(candidate.signalCandleTime) + 2 * durations[interval]
    const previous = { ...active(interval, 'PUT'), status: 'TARGET_HIT', exitAt: deadline, exitPrice: 970, points: 30 }
    assert.equal(registerConfirmedPrediction([previous], candidate, deadline - 1000).length, 1, 'do not create an invalid expiresAt <= generatedAt record')
  }
})
