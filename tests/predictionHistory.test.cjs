const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename)
const { buildEarlyPrediction } = require('../src/analysis/earlyPrediction.ts')
const { createPredictionRecord, observePredictionTick, observePredictionCandles, syncPredictionRecord, observePredictionReversal, exitPredictionEarly, canExitPredictionEarly, predictionSuccessScore, predictionHistoryStats, readPredictionHistory, writePredictionHistory, predictionHistoryKey } = require('../src/analysis/predictionHistory.ts')
const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
const now = Date.parse('2026-10-09T04:30:00Z')
const interval = 'FIVE_MINUTE', duration = 300000
const analysis = (side = 'CALL') => ({
  side, analyzedCandles: 80, latestCandleTime: new Date(now - duration).toISOString(),
  entry: side === 'CALL' ? 100 : 100, stopLoss: side === 'CALL' ? 90 : 110, target: side === 'CALL' ? 120 : 80,
  earlyBias: side === 'PUT' ? 'BEARISH' : 'BULLISH', earlyStage: 'EARLY', currentPrice: side === 'PUT' ? 101 : 99,
  bullishTrigger: 100, bearishTrigger: 100, bullishInvalidation: 90, bearishInvalidation: 110,
  bullishScore: 70, bearishScore: 20, bullishEvidence: ['Bullish structure'], bearishEvidence: ['Bearish structure'],
})
const plan = (side = 'CALL', instrument = 'Nifty 50') => buildEarlyPrediction(analysis(side), instrument, interval, now).plan
const record = (side = 'CALL') => createPredictionRecord(plan(side))
const bar = (time, open, high, low, close = open) => [new Date(time).toISOString(), open, high, low, close, 100]
const context = {
  instrument: 'Nifty 50', revision: 'fixture', retrievedAt: new Date(now).toISOString(),
  articles: [{ id: 'news1', title: 'Constituent update', publisher: 'Fixture', url: 'https://example.com/news', category: 'companies', publishedAt: new Date(now - 60000).toISOString(), matchedCompanies: ['Bank'] }],
  feeds: [{ category: 'companies', status: 'AVAILABLE' }],
}
const outlook = { bias: 'BULLISH', agreement: 'SUPPORTS_CHART', contextRevision: 'fixture', evidenceIds: ['news1'], summary: 'Chart and company news align.' }

test('combined prediction preserves chart levels and snapshots cited news', () => {
  const result = buildEarlyPrediction(analysis(), 'Nifty 50', interval, now, context, outlook)
  assert.equal(result.side, 'CALL'); assert.equal(result.plan.contextMode, 'NEWS_ALIGNED')
  assert.deepEqual([result.plan.entry, result.plan.target, result.plan.stopLoss], [100, 120, 90])
  assert.equal(result.plan.newsEvidence[0].id, 'news1')
  assert.equal(result.plan.riskReward, 2)
})

test('conflicting or mixed news vetoes a new chart setup', () => {
  for (const change of [{ bias: 'BEARISH' }, { agreement: 'CONFLICTS_WITH_CHART' }, { agreement: 'MIXED' }, { bias: 'MIXED' }]) {
    assert.equal(buildEarlyPrediction(analysis(), 'Nifty 50', interval, now, context, { ...outlook, ...change }).side, 'WAIT')
  }
})

test('missing, stale, wrong-index or uncited context is explicitly technical-only', () => {
  for (const [data, view] of [[null, null], [{ ...context, revision: 'different' }, outlook], [{ ...context, retrievedAt: new Date(now - 11 * 60000).toISOString() }, outlook], [{ ...context, instrument: 'Sensex' }, outlook], [{ ...context, feeds: [{ category: 'companies', status: 'STALE' }] }, outlook], [context, { ...outlook, evidenceIds: ['fabricated'] }]]) {
    assert.equal(buildEarlyPrediction(analysis(), 'Nifty 50', interval, now, data, view).plan.contextMode, 'TECHNICAL_ONLY')
  }
})

test('early bias can produce a conditional entry before technical confirmation', () => {
  const input = { ...analysis(), side: 'WAIT' }
  const result = buildEarlyPrediction(input, 'Nifty 50', interval, now)
  assert.equal(result.side, 'CALL'); assert.equal(result.plan.stage, 'EARLY')
  assert.equal(result.plan.target, 120); assert.match(result.plan.targetBasis, /2R projection/)
  assert.equal(buildEarlyPrediction({ ...input, currentPrice: 101 }, 'Nifty 50', interval, now).side, 'WAIT')
})

test('insufficient, stale, future, wrong-sided and low reward setups cannot issue calls', () => {
  for (const change of [{ analyzedCandles: 10 }, { latestCandleTime: new Date(now - 3 * duration).toISOString() }, { latestCandleTime: new Date(now).toISOString() }, { stopLoss: 105 }, { target: 105 }, { target: NaN }]) {
    assert.equal(buildEarlyPrediction({ ...analysis(), ...change }, 'Nifty 50', interval, now).side, 'WAIT')
  }
})

test('CALL and PUT activate at entry and settle directional points correctly', () => {
  for (const side of ['CALL', 'PUT']) {
    let item = observePredictionTick(record(side), 100, now + 1000)
    assert.equal(item.status, 'ACTIVE'); assert.equal(item.entryPrice, 100)
    item = observePredictionTick(item, side === 'CALL' ? 122 : 78, now + 2000)
    assert.equal(item.status, 'TARGET_HIT'); assert.equal(item.points, 20)
    assert.equal(observePredictionTick(item, 1, now + 3000), item)
  }
})

test('live crossed stops use actual quote including adverse gaps', () => {
  for (const [side, exit] of [['CALL', 88], ['PUT', 113]]) {
    const item = observePredictionTick(observePredictionTick(record(side), 100, now + 1000), exit, now + 2000)
    assert.equal(item.status, 'STOP_LOSS_HIT'); assert.equal(item.exitPrice, exit)
    assert.equal(item.points, side === 'CALL' ? -12 : -13)
  }
})

test('old quotes cannot backfill signals; repeated and out-of-order quotes are ignored', () => {
  const item = record()
  assert.equal(observePredictionTick(item, 100, now - 1000), item)
  const active = observePredictionTick(item, 100, now + 1000)
  assert.equal(observePredictionTick(active, 130, now + 500), active)
  assert.equal(observePredictionTick(active, 130, now + 1000), active)
})

test('missed entry gap or entry timeout never creates an instant success', () => {
  assert.equal(observePredictionTick(record(), 125, now + 1000).status, 'EXPIRED')
  assert.equal(observePredictionTick(record(), 100, now + 3 * duration).status, 'EXPIRED')
  assert.equal(observePredictionCandles(record(), [], now + 3 * duration).status, 'EXPIRED')
})

test('invalidation before entry expires a setup instead of rearming it later', () => {
  assert.equal(observePredictionTick(record(), 89, now + 1000).status, 'EXPIRED')
  assert.equal(observePredictionTick(record('PUT'), 111, now + 1000).status, 'EXPIRED')
  const missed = observePredictionCandles(record(), [bar(now, 99, 99, 85)], now + duration)
  assert.equal(missed.status, 'EXPIRED')
  assert.equal(observePredictionTick(missed, 100, now + duration + 1000), missed)
  assert.equal(observePredictionCandles(record(), [bar(now, 89, 125, 85)], now + duration).status, 'EXPIRED')
})

test('completed candle replay respects timeframe and never consumes forming or pre-signal ranges', () => {
  const candles = [bar(now - duration, 100, 130, 90), bar(now, 99, 110, 95)]
  const initial = record()
  assert.equal(observePredictionCandles(initial, candles, now + duration - 1), initial)
  const active = observePredictionCandles(initial, candles, now + duration)
  assert.equal(active.status, 'ACTIVE'); assert.equal(active.entryPrice, 100)
  const settled = observePredictionCandles(active, [...candles, bar(now + duration, 110, 122, 105)], now + 2 * duration)
  assert.equal(settled.status, 'TARGET_HIT'); assert.equal(settled.points, 20)
})

test('same-bar entry/stop and target/stop ambiguity is excluded from success', () => {
  const entryStop = observePredictionCandles(record(), [bar(now, 99, 110, 85)], now + duration)
  assert.equal(entryStop.status, 'AMBIGUOUS')
  const active = { ...record(), status: 'ACTIVE', entryPrice: 100, entryAt: now }
  const both = observePredictionCandles(active, [bar(now, 105, 125, 85)], now + duration)
  assert.equal(both.status, 'AMBIGUOUS'); assert.equal(both.points, undefined)
  assert.equal(predictionHistoryStats([entryStop, both]).successRate, null)
})

test('known opening gap resolves before later ambiguous high/low', () => {
  const active = { ...record(), status: 'ACTIVE', entryPrice: 100, entryAt: now }
  const loss = observePredictionCandles(active, [bar(now, 87, 125, 85)], now + duration)
  assert.equal(loss.status, 'STOP_LOSS_HIT'); assert.equal(loss.points, -13)
})

test('missing or partial periods become unverified instead of retroactive wins', () => {
  for (const item of [record(), { ...record(), observedThrough: now + 1000 }]) {
    const result = observePredictionCandles(item, [bar(now + duration, 110, 125, 105)], now + 2 * duration)
    assert.equal(result.status, 'UNVERIFIED'); assert.equal(result.points, undefined)
  }
  const partial = { ...record(), generatedAt: now + 1000, observedThrough: now + 1000 }
  assert.equal(observePredictionCandles(partial, [bar(now, 100, 125, 95)], now + duration).status, 'UNVERIFIED')
})

test('reconnect quote cannot hide a missing stop even when no candle coverage is available', () => {
  const active = observePredictionTick(record(), 100, now + 1000)
  const late = { timestamp: now + 40000, ltp: 125 }
  const result = syncPredictionRecord(active, [], late, now + 40000)
  assert.equal(result.status, 'UNVERIFIED'); assert.equal(result.points, undefined)
  const current = syncPredictionRecord(active, [], { timestamp: now + 2000, ltp: 120 }, now + 2000)
  assert.equal(current.status, 'TARGET_HIT')
})

test('continuous quotes skip overlapping bars; complete consecutive replay can verify offline results', () => {
  const active = observePredictionTick(record(), 100, now + 1000)
  assert.equal(syncPredictionRecord(active, [bar(now, 100, 125, 85)], { timestamp: now + 2000, ltp: 101 }, now + 2000).status, 'ACTIVE')
  const result = syncPredictionRecord(record(), [bar(now, 99, 110, 95), bar(now + duration, 110, 122, 105)], { timestamp: now + 2 * duration, ltp: 119 }, now + 2 * duration)
  assert.equal(result.status, 'TARGET_HIT'); assert.equal(result.points, 20)
  assert.equal(syncPredictionRecord(record(), [], { timestamp: now + 10000, ltp: 100 }, now).status, 'PENDING')
})

test('legacy target/stop results keep their scores and exclude unresolved calls', () => {
  const win = observePredictionTick(observePredictionTick(record(), 100, now + 1), 120, now + 2)
  const loss = observePredictionTick(observePredictionTick(record('PUT'), 100, now + 1), 110, now + 2)
  const stats = predictionHistoryStats([win, loss, record(), { ...record(), status: 'AMBIGUOUS' }, { ...record(), status: 'EXPIRED' }])
  assert.equal(stats.successRate, 50); assert.equal(stats.netPoints, 10)
  assert.equal(stats.resolved, 2); assert.equal(stats.open, 1); assert.equal(stats.excluded, 2)
})

test('history persists as immutable snapshots and survives unrelated auth removal', () => {
  const values = new Map(), storage = { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value) }
  const item = record(); writePredictionHistory(storage, [item]); values.set('angelone_jwt_token', 'fixture'); values.delete('angelone_jwt_token')
  assert.deepEqual(readPredictionHistory(storage), [item])
  assert.equal(buildEarlyPrediction(analysis(), 'Nifty 50', interval, now + 1000).plan.id, item.id)
  assert.equal(buildEarlyPrediction(analysis(), 'Sensex', interval, now).plan.id === item.id, false)
})

test('invalid saved data and quota failures are surfaced without overwriting saved history', () => {
  for (const saved of ['invalid-json', '{}', JSON.stringify({ version: 99, records: [] }), JSON.stringify({ version: 1, records: [{ id: 'broken' }] }), JSON.stringify({ version: 1, records: [record(), record()] })]) {
    const storage = { getItem: () => saved, setItem: () => assert.fail('Must not overwrite') }
    assert.throws(() => readPredictionHistory(storage), /preserved/)
  }
  assert.throws(() => writePredictionHistory({ setItem: () => { throw new Error('Quota exceeded') } }, [record()]), /Quota/)
  assert.equal(predictionHistoryKey.includes('history'), true)
})

test('manual early exits save actual quote price and directional points for CALL and PUT', () => {
  for (const [side, exit] of [['CALL', 105], ['PUT', 95]]) {
    const active = observePredictionTick(observePredictionTick(record(side), 100, now + 1000), exit, now + 2000)
    assert.equal(canExitPredictionEarly(active, now + 3000), true)
    const closed = exitPredictionEarly(active, now + 3000, 'MANUAL', 'Manual close')
    assert.equal(closed.status, 'EARLY_EXIT'); assert.equal(closed.earlyExitSource, 'MANUAL')
    assert.equal(closed.exitPrice, exit); assert.equal(closed.exitAt, now + 2000); assert.equal(closed.points, 5)
    assert.equal(predictionSuccessScore(closed), 100)
    assert.equal(observePredictionTick(closed, side === 'CALL' ? 90 : 110, now + 4000), closed)
    let saved; writePredictionHistory({ setItem: (_, value) => { saved = value } }, [closed])
    assert.deepEqual(readPredictionHistory({ getItem: () => saved }), [closed])
  }
})

test('early exit rejects pending, terminal, stale, future and historical quotes', () => {
  const active = observePredictionTick(record(), 100, now + 1000)
  for (const item of [record(), { ...active, status: 'TARGET_HIT' }, { ...active, latestPriceSource: 'CANDLE' }, { ...active, latestPriceSource: undefined }, { ...active, latestPriceAt: now - 31000 }, { ...active, latestPriceAt: now + 10000 }]) {
    assert.equal(canExitPredictionEarly(item, now + 2000), false)
    assert.equal(exitPredictionEarly(item, now + 2000, 'MANUAL', 'Manual close'), item)
  }
})

test('per-call and overall success scores include profitable, losing and break-even early exits', () => {
  const closeAt = price => exitPredictionEarly(observePredictionTick(observePredictionTick(record(), 100, now + 1000), price, now + 2000), now + 3000, 'MANUAL', 'Manual close')
  const profitable = closeAt(105), losing = closeAt(95), flat = closeAt(100)
  assert.equal(predictionSuccessScore(profitable), 100); assert.equal(predictionSuccessScore(losing), 0); assert.equal(predictionSuccessScore(flat), 0)
  assert.equal(predictionSuccessScore(record()), null)
  const target = observePredictionTick(observePredictionTick(record(), 100, now + 1000), 120, now + 2000)
  const stop = observePredictionTick(observePredictionTick(record(), 100, now + 1000), 90, now + 2000)
  const stats = predictionHistoryStats([profitable, losing, flat, target, stop, record(), { ...record(), status: 'UNVERIFIED' }])
  assert.equal(stats.successRate, 40); assert.equal(stats.resolved, 5); assert.equal(stats.earlyExits, 3)
  assert.equal(stats.wins, 2); assert.equal(stats.losses, 2); assert.equal(stats.breakEven, 1); assert.equal(stats.netPoints, 10)
})

function reversalFixture(direction) {
  const count = direction === 1 ? 33 : 46
  return Array.from({ length: count }, (_, i) => {
    const open = 2000 + direction * i * 3 + Math.sin(i / 4) * 35, closing = open + direction * 2
    return [new Date(now - (count - i) * duration).toISOString(), open, Math.max(open, closing) + 3, Math.min(open, closing) - 3, closing, 1000]
  })
}

test('confirmed opposite completed-chart setup produces a persisted agent early exit', () => {
  for (const [side, direction] of [['CALL', -1], ['PUT', 1]]) {
    const candles = reversalFixture(direction)
    const analysis = analyzePriceAction(candles, interval, now)
    assert.equal(analysis.side, side === 'CALL' ? 'PUT' : 'CALL')
    const active = { ...record(side), status: 'ACTIVE', generatedAt: now - 3 * duration, entry: 2000, entryPrice: 2000, entryAt: now - 2 * duration, stopLoss: side === 'CALL' ? 1000 : 3000, target: side === 'CALL' ? 4000 : 500,
      observedThrough: now, latestPrice: candles.at(-1)[4], latestPriceAt: now, latestPriceSource: 'LIVE' }
    const closed = observePredictionReversal(active, candles, now)
    assert.equal(closed.status, 'EARLY_EXIT'); assert.equal(closed.earlyExitSource, 'AGENT_REVERSAL')
    assert.equal(closed.exitPrice, active.latestPrice)
    assert.equal(closed.points, Math.round((active.latestPrice - 2000) * (side === 'CALL' ? 1 : -1) * 100) / 100)
    let saved; writePredictionHistory({ setItem: (_, value) => { saved = value } }, [closed])
    assert.deepEqual(readPredictionHistory({ getItem: () => saved }), [closed])
  }
})

test('reversal checking excludes forming/pre-entry bars, stale quotes and unverified calls', () => {
  const candles = reversalFixture(-1)
  const active = { ...record(), status: 'ACTIVE', generatedAt: now - 3 * duration, entryPrice: 100, entryAt: now - 2 * duration, latestPrice: 101, latestPriceAt: now, latestPriceSource: 'LIVE', observedThrough: now }
  for (const item of [{ ...active, entryAt: now }, { ...active, latestPriceAt: now - 31000 }, { ...active, latestPriceSource: 'CANDLE' }, { ...active, status: 'UNVERIFIED' }, { ...active, reversalCheckedCandle: candles.at(-1)[0] }]) {
    assert.equal(observePredictionReversal(item, candles, now), item)
  }
  assert.equal(observePredictionReversal(active, candles.slice(0, 10), now), active)
  const forming = [...candles.slice(0, -1), [new Date(now).toISOString(), 2000, 2500, 500, 600, 100]]
  const result = observePredictionReversal({ ...active, entryAt: now - duration }, forming, now)
  assert.equal(result.status, 'ACTIVE')
})

test('live target and stop events take priority over a simultaneous confirmed reversal', () => {
  const candles = reversalFixture(-1)
  const active = { ...record(), status: 'ACTIVE', generatedAt: now - 3 * duration, entry: 2000, entryPrice: 2000, entryAt: now - 2 * duration,
    stopLoss: 1900, target: 2200, latestPrice: 2000, latestPriceAt: now - 1000, latestPriceSource: 'LIVE', observedThrough: now - 1000 }
  for (const [quote, status, points] of [[1810, 'STOP_LOSS_HIT', -190], [2210, 'TARGET_HIT', 200]]) {
    const result = syncPredictionRecord(active, candles, { timestamp: now, ltp: quote }, now)
    assert.equal(result.status, status); assert.equal(result.points, points)
    assert.equal(result.earlyExitSource, undefined)
  }
})

const { predictionEvents } = require('../src/analysis/predictionEvents.ts')
const { acknowledgePredictionEarlyExit, predictionDisplayStatus } = require('../src/analysis/predictionHistory.ts')

test('all indices generate independent confirmation events without chart selection', () => {
  const calls = ['Nifty 50', 'Sensex', 'Bank Nifty'].map(name => createPredictionRecord(plan('CALL', name)))
  const events = predictionEvents([], calls)
  assert.deepEqual(events.map(event => event.instrument), ['Nifty 50', 'Sensex', 'Bank Nifty'])
  assert.ok(events.every(event => event.side === 'CALL' && event.reason === 'Confirm call'))
  assert.equal(new Set(events.map(event => event.id)).size, 3)
  assert.deepEqual(predictionEvents(calls, calls), [])
})

test('conditional early setups are not called confirmed until entry is observed', () => {
  const early = createPredictionRecord({ ...plan(), stage: 'EARLY' })
  assert.equal(predictionEvents([], [early])[0].reason, 'Early setup')
  const active = observePredictionTick(early, 100, now + 1000)
  assert.equal(predictionEvents([early], [active])[0].reason, 'Confirm call · Entry reached')
  assert.deepEqual(predictionEvents([active], [observePredictionTick(active, 101, now + 2000)]), [])
})

test('target, stop, early exit and expiry events carry index, direction and reason exactly once', () => {
  const pending = record('PUT')
  const active = observePredictionTick(pending, 100, now + 1000)
  for (const [terminal, reason] of [
    [observePredictionTick(active, 80, now + 2000), 'Target achieved · Exit'],
    [observePredictionTick(active, 112, now + 2000), 'Stop loss · Exit'],
    [exitPredictionEarly(active, now + 2000, 'MANUAL', 'Manual exit'), 'Early exit'],
  ]) {
    const events = predictionEvents([active], [terminal])
    assert.equal(events.length, 1)
    assert.equal(events[0].instrument, 'Nifty 50'); assert.equal(events[0].side, 'PUT')
    assert.equal(events[0].reason, reason)
    assert.deepEqual(predictionEvents([terminal], [terminal]), [])
  }
  const expired = observePredictionTick(pending, 100, now + 3 * duration)
  assert.equal(predictionEvents([pending], [expired])[0].reason, 'Exit · Setup expired')
})

test('candle replay that enters and exits in one sync announces both events', () => {
  const pending = record()
  const terminal = observePredictionCandles(pending, [bar(now, 100, 121, 99)], now + duration)
  assert.equal(terminal.status, 'TARGET_HIT')
  assert.deepEqual(predictionEvents([pending], [terminal]).map(event => event.reason), ['Confirm call · Entry reached', 'Target achieved · Exit'])
})

test('Live and Done status include pending calls and all terminal outcomes', () => {
  const pending = record()
  assert.equal(predictionDisplayStatus(pending), 'Live')
  assert.equal(predictionDisplayStatus(observePredictionTick(pending, 100, now + 1000)), 'Live')
  for (const status of ['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT', 'EXPIRED', 'AMBIGUOUS', 'UNVERIFIED']) {
    assert.equal(predictionDisplayStatus({ ...pending, status }), 'Done')
  }
})

test('OK acknowledges early exit persistently without changing outcome or repeating events', () => {
  const active = observePredictionTick(record(), 100, now + 1000)
  const exited = exitPredictionEarly(active, now + 2000, 'AGENT_REVERSAL', 'Confirmed opposite chart setup')
  const acknowledged = acknowledgePredictionEarlyExit(exited, now + 3000)
  assert.equal(acknowledged.earlyExitAcknowledgedAt, now + 3000)
  assert.equal(acknowledged.status, 'EARLY_EXIT'); assert.equal(acknowledged.points, exited.points)
  assert.equal(acknowledgePredictionEarlyExit(acknowledged, now + 4000), acknowledged)
  assert.equal(acknowledgePredictionEarlyExit(active, now + 3000), active)
  assert.equal(acknowledgePredictionEarlyExit(exited, now), exited)
  assert.deepEqual(predictionEvents([exited], [acknowledged]), [])
  let saved
  writePredictionHistory({ setItem: (_key, value) => { saved = value } }, [acknowledged])
  assert.deepEqual(readPredictionHistory({ getItem: () => saved }), [acknowledged])
  const corrupted = { ...acknowledged, earlyExitAcknowledgedAt: 'invalid' }
  assert.throws(() => readPredictionHistory({ getItem: () => JSON.stringify({ version: 1, records: [corrupted] }) }), /invalid format/)
})
