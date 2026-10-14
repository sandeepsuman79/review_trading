const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
const { analyzeHistoricalOutcomes, cachedHistoricalOutcomes, wilsonInterval } = require('../src/analysis/historicalOutcomes.ts')
const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
const start = Date.parse('2026-10-01T09:15:00+05:30')
const duration = 300000
function fixture(d = 1, sessions = 10) {
  return Array.from({ length: sessions * 75 }, (_, i) => {
    const day = Math.floor(i / 75), slot = i % 75, close = 22000 + d * i * .8
    return [new Date(start + day * 86400000 + slot * duration).toISOString(), close - d * .1, close + 2, close - 2, close, 0]
  })
}
const decisionAt = candles => Date.parse(candles.at(-1)[0]) + duration

test('Wilson ranges are bounded and never claim certainty from all-positive small samples', () => {
  assert.deepEqual(wilsonInterval(0, 0), undefined)
  assert.equal(wilsonInterval(-1, 10), undefined)
  const all = wilsonInterval(30, 30)
  assert(all[0] > 85 && all[0] < 100); assert(Math.abs(all[1] - 100) < 1e-10)
  const half = wilsonInterval(50, 100)
  assert(Math.abs(half[0] - 40.383153) < .001); assert(Math.abs(half[1] - 59.616847) < .001)
})

test('similar indecisive candles have empirical bullish/bearish historical outcomes without overriding confirmation', () => {
  for (const d of [1, -1]) {
    const candles = fixture(d), now = decisionAt(candles)
    const reference = analyzeHistoricalOutcomes(candles, 'FIVE_MINUTE', now)
    assert.equal(reference.status, 'READY'); assert(reference.samples >= 30); assert(reference.sessions >= 3)
    assert.equal(reference.bias, d === 1 ? 'BULLISH' : 'BEARISH')
    assert.equal(d === 1 ? reference.upPercent : reference.downPercent, 100)
    const analysis = analyzePriceAction(candles, 'FIVE_MINUTE', now)
    assert.equal(analysis.side, 'WAIT')
    const ordinary = analyzeTradingEvidence({ analysis, candles, interval: 'FIVE_MINUTE', instrument: 'Nifty 50', now })
    const withHistory = analyzeTradingEvidence({ analysis, candles, interval: 'FIVE_MINUTE', instrument: 'Nifty 50', now, historicalReference: true })
    assert.equal(withHistory.canConfirm, false)
    assert.equal(withHistory.bullishScore, ordinary.bullishScore); assert.equal(withHistory.bearishScore, ordinary.bearishScore)
    assert.equal(withHistory.historicalOutcomes.status, 'READY')
  }
})

test('forming and future candles cannot enter history features or outcome labels', () => {
  const candles = fixture(), now = decisionAt(candles), expected = analyzeHistoricalOutcomes(candles, 'FIVE_MINUTE', now)
  const future = [new Date(now).toISOString(), 22000, 40000, 100, 39000, 0]
  assert.deepEqual(analyzeHistoricalOutcomes([...candles, future], 'FIVE_MINUTE', now), expected)
  assert.deepEqual(analyzeHistoricalOutcomes([...candles, future, [new Date(now + duration).toISOString(), 39000, 40000, 100, 101, 0]], 'FIVE_MINUTE', now), expected)
})

test('small and single-session samples withhold percentages', () => {
  const candles = fixture(1, 1)
  const small = analyzeHistoricalOutcomes(candles, 'FIVE_MINUTE', decisionAt(candles))
  assert.equal(small.status, 'INSUFFICIENT'); assert.equal(small.upPercent, undefined)
  assert.equal(small.bias, 'UNAVAILABLE')
})

test('outcome windows do not count missing bars as a continuous move or bridge sessions', () => {
  const candles = fixture(), now = decisionAt(candles)
  const complete = analyzeHistoricalOutcomes(candles, 'FIVE_MINUTE', now)
  const gapped = candles.filter((_, i) => i % 4 !== 0)
  const result = analyzeHistoricalOutcomes(gapped, 'FIVE_MINUTE', now)
  assert.equal(result.samples, 0); assert(complete.samples <= Math.floor(candles.length / 4))
})

test('memory cache reuses one closed snapshot and invalidates on a new completion boundary', () => {
  const candles = fixture(), now = decisionAt(candles)
  const a = cachedHistoricalOutcomes(candles, 'FIVE_MINUTE', now)
  assert.equal(cachedHistoricalOutcomes(candles, 'FIVE_MINUTE', now + 1000), a)
  assert.notEqual(cachedHistoricalOutcomes(candles, 'FIVE_MINUTE', now + duration), a)
  assert.notEqual(cachedHistoricalOutcomes([...candles], 'FIVE_MINUTE', now), a)
})
