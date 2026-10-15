const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, f)
const { inTradingEntryWindow, squareOffTime } = require('../src/analysis/tradingSession.ts')
const { buildGapOutlook, readGapOutlook, gapOutlookKey } = require('../src/analysis/gapOutlook.ts')
const { createPredictionRecord, syncPredictionRecord, registerConfirmedPrediction, readPredictionHistory, writePredictionHistory } = require('../src/analysis/predictionHistory.ts')
const { predictionEvents } = require('../src/analysis/predictionEvents.ts')
const at = (time, date = '2026-10-15') => Date.parse(`${date}T${time}+05:30`)
const cutoff = at('15:15:00')
function active(instrument, side) {
  const plan = { id: `schedule-${instrument}-${side}`, strategyVersion: 'technical-v2', instrument, side, stage: 'CONFIRMED', interval: 'ONE_MINUTE', generatedAt: cutoff - 180000, expiresAt: cutoff + 180000,
    signalCandleTime: new Date(cutoff - 240000).toISOString(), entry: 100, stopLoss: side === 'CALL' ? 90 : 110, target: side === 'CALL' ? 120 : 80, riskReward: 2, bullishScore: 70, bearishScore: 10, contextMode: 'TECHNICAL_ONLY', newsEvidence: [], technicalEvidence: [], newsSummary: 'Fixture', coverage: [], reason: 'Schedule fixture', targetBasis: 'Observed fixture level' }
  return { ...createPredictionRecord(plan), status: 'ACTIVE', entryAt: cutoff - 120000, entryPrice: 100, observedThrough: cutoff - 1000, latestPrice: 100, latestPriceAt: cutoff - 1000, latestPriceSource: 'LIVE' }
}
const tick = (timestamp, ltp) => ({ timestamp, ltp })

test('entry schedule is Mon–Fri 09:15 inclusive to 15:15 exclusive in IST', () => {
  for (const [time, allowed] of [['09:14:59', false], ['09:15:00', true], ['15:00:00', true], ['15:14:59', true], ['15:15:00', false], ['15:30:00', false]]) assert.equal(inTradingEntryWindow(at(time)), allowed, time)
  for (const day of ['2026-10-17', '2026-10-18']) assert.equal(inTradingEntryWindow(at('12:00:00', day)), false)
  assert.equal(inTradingEntryWindow(NaN), false);assert.equal(squareOffTime(at('12:00:00')), cutoff)
})

test('all indices and both sides square off at the first observed cutoff quote and preserve booked P/L', () => {
  for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty']) for (const side of ['CALL', 'PUT']) {
    const record = active(instrument, side), closed = syncPredictionRecord(record, [], tick(cutoff, 103), cutoff, false, undefined, null)
    assert.equal(closed.status, 'EARLY_EXIT');assert.equal(closed.earlyExitSource, 'SESSION_SQUARE_OFF');assert.equal(closed.exitAt, cutoff)
    assert.equal(closed.exitPrice, 103);assert.equal(closed.points, side === 'CALL' ? 3 : -3)
    assert(predictionEvents([record], [closed])[0].reason.includes('square-off'))
    assert.deepEqual(syncPredictionRecord(closed, [], tick(cutoff + 1000, 99), cutoff + 1000), closed)
    const memory = new Map(), storage = { getItem: k => memory.get(k) ?? null, setItem: (k,v) => memory.set(k,v) }
    writePredictionHistory(storage, [closed]);assert.deepEqual(readPredictionHistory(storage), [closed])
  }
})

test('pending entries expire at cutoff and no same-index replacement is registered after square-off', () => {
  const record = active('Nifty 50', 'CALL'), pending = { ...createPredictionRecord(record), observedThrough: cutoff - 1000 }
  assert.equal(syncPredictionRecord(pending, [], tick(cutoff, 100), cutoff, true).status, 'EXPIRED')
  const closed = syncPredictionRecord(record, [], tick(cutoff, 103), cutoff, false)
  assert.deepEqual(registerConfirmedPrediction([closed], { ...record, id: 'late-put', side: 'PUT' }, cutoff), [closed])
})

test('missing cutoff quotes remain disclosed and later/overnight prices are never backdated to 15:15', () => {
  const record = active('Nifty 50', 'CALL')
  const waiting = syncPredictionRecord(record, [], undefined, cutoff, false, undefined, null)
  assert.equal(waiting.status, 'ACTIVE');assert.equal(waiting.exitPrice, undefined);assert.match(waiting.outcomeNote, /Waiting/)
  const delayed = syncPredictionRecord(waiting, [], tick(cutoff + 5000, 102), cutoff + 5000, false)
  assert.equal(delayed.exitAt, cutoff + 5000);assert.equal(delayed.exitPrice, 102)
  const overnight = syncPredictionRecord(record, [], tick(at('09:15:00','2026-10-16'), 150), at('09:15:00','2026-10-16'), false)
  assert.equal(overnight.status, 'UNVERIFIED');assert.equal(overnight.points, undefined)
})

test('cutoff replay preserves pre-cutoff stops and excludes later candle profits', () => {
  const record = { ...active('Nifty 50', 'CALL'), observedThrough: cutoff - 120000 }
  const bar = (offset, low = 99, high = 101) => [new Date(cutoff + offset).toISOString(),100,high,low,100,0]
  const stopped = syncPredictionRecord(record,[bar(-120000),bar(-60000,89)],tick(cutoff+60000,105),cutoff+60000,false)
  assert.equal(stopped.status,'STOP_LOSS_HIT');assert.equal(stopped.points,-10)
  const delayed = syncPredictionRecord(record,[bar(-120000),bar(-60000),bar(0,99,130)],tick(cutoff+60000,105),cutoff+60000,false)
  assert.equal(delayed.status,'EARLY_EXIT');assert.equal(delayed.earlyExitSource,'SESSION_SQUARE_OFF');assert.equal(delayed.exitAt,cutoff+60000);assert.equal(delayed.points,5)
  const gap = syncPredictionRecord(record,[],tick(cutoff+60000,105),cutoff+60000,false)
  assert.equal(gap.status,'UNVERIFIED');assert.equal(gap.points,undefined)
})

function outlookFixture(d = 1, instrument = 'Nifty 50', date = '2026-10-15') {
  const now = at('15:00:00', date), candles = Array.from({ length: 60 }, (_, i) => [new Date(now - (60-i)*300000).toISOString(), 22000 + d*i, 22100 + i, 21900 - i, 22000 + d*(i+1), 0])
  const analysis = { latestCandleTime: candles.at(-1)[0], structure: 'Fixture structure', setup: 'Fixture setup' }
  const evidence = { instrument, interval: 'FIVE_MINUTE', asOf: analysis.latestCandleTime, bullishScore: d === 1 ? 70 : 10, bearishScore: d === -1 ? 70 : 10, coverage: 85,
    checks: [{ label: 'Indicator warmup', passed: true }], missing: ['Spot-index VWAP unavailable'], sentiment: { bias: d === 1 ? 'BULLISH' : 'BEARISH', bullishScore: d === 1 ? 65 : 10, bearishScore: d === -1 ? 65 : 10, coverage: 80, missing: [] } }
  return { now, candles, analysis, evidence, instrument }
}
const build = x => buildGapOutlook(x.instrument, x.candles, x.analysis, x.evidence, x.now)
test('15:00 gap outlook supports all indices, mirrors direction and never claims a probability', () => {
  for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty']) for (const d of [1,-1]) {
    const input = outlookFixture(d, instrument), result = build(input)
    assert.equal(result.bias, d === 1 ? 'GAP_UP_BIAS' : 'GAP_DOWN_BIAS');assert.equal(result.evidenceScore, 58*d);assert.equal(result.referencePrice, input.candles.at(-1)[4]);assert.equal(result.generatedAt, input.now)
    assert.equal(result.probability, undefined)
    const memory = new Map([[gapOutlookKey(instrument), JSON.stringify(result)]]), storage = { getItem: key => memory.get(key) ?? null }
    assert.deepEqual(readGapOutlook(storage,instrument),result)
  }
})

test('gap snapshots cannot use future, forming, gapped, unwarmed or late data or run on weekends', () => {
  for (const time of ['14:59:59','15:01:00','16:00:00']) { const input = outlookFixture();input.now = at(time);assert.equal(build(input), undefined) }
  for (const date of ['2026-10-17','2026-10-18']) assert.equal(build(outlookFixture(1,'Nifty 50',date)), undefined)
  for (const mutate of [x => x.candles.pop(), x => x.candles.splice(-3,1), x => x.evidence.coverage = 69, x => x.evidence.checks[0].passed = false, x => x.evidence.interval = 'ONE_MINUTE', x => x.analysis.latestCandleTime = new Date(x.now).toISOString()]) { const input = outlookFixture();mutate(input);assert.equal(build(input), undefined) }
})

test('missing sentiment produces a mixed outlook with missing coverage retained; malformed storage is preserved', () => {
  const input = outlookFixture();input.evidence.sentiment = { ...input.evidence.sentiment, bias: 'UNAVAILABLE', coverage: 0, bullishScore: 0, bearishScore: 0, missing: ['Unavailable news and global inputs'] }
  const result = build(input);assert.equal(result.bias,'MIXED');assert.equal(result.coverage,51);assert(result.missing.includes('Unavailable news and global inputs'))
  for (const raw of ['bad json', JSON.stringify({ ...result, generatedAt: result.generatedAt + 60000 }), JSON.stringify({ ...result, referencePrice: -1 })]) assert.throws(() => readGapOutlook({ getItem: () => raw },input.instrument))
})

test('previous one-minute outlook snapshots remain readable after switching agent analysis',()=>{
 const input=outlookFixture(),result=build(input),legacy={...result,asOf:new Date(input.now-60000).toISOString()}
 assert.deepEqual(readGapOutlook({getItem:()=>JSON.stringify(legacy)},input.instrument),legacy)
})
