const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
// Run the TypeScript analysis modules without adding a browser or test dependency.
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename)
}
const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
const { applyLiveTick, completedCandles, normalizeCandles } = require('../src/analysis/candleData.ts')
const { calculateMovingAverageSeries } = require('../src/analysis/movingAverages.ts')
const { calculateTechnicalIndicatorSeries } = require('../src/analysis/technicalIndicators.ts')
const interval = 'FIVE_MINUTE'
const start = Date.parse('2026-10-09T03:45:00Z')
const fixture = (count = 260, direction = 1) => Array.from({ length: count }, (_, i) => {
  const open = 22000 + direction * i * 3 + Math.sin(i / 4) * 35
  const close = open + direction * 2
  return [new Date(start + i * 300000).toISOString(), open, Math.max(open, close) + 3, Math.min(open, close) - 3, close, 1000]
})
const now = start + 261 * 300000

test('completed analysis excludes forming/future candles and survives invalid and duplicate history', () => {
  const candles = fixture()
  const last = candles.at(-1)
  const bad = [last[0], 22000, 1, 30000, 23000, 0]
  const future = [new Date(now).toISOString(), 30000, 40000, 1, 39000, 0]
  const expected = analyzePriceAction(candles, interval, now)
  assert.deepEqual(analyzePriceAction([...candles.reverse(), last, bad, future], interval, now), expected)
  assert.equal(normalizeCandles([last, bad, last]).length, 1)
})

test('forming candle changes cannot repaint completed early bias or trade status', () => {
  const candles = fixture(60)
  const boundary = start + 60 * 300000
  const forming = [new Date(boundary).toISOString(), 23000, 25000, 18000, 18000, 0]
  assert.deepEqual(analyzePriceAction([...candles, forming], interval, boundary + 1000), analyzePriceAction(candles, interval, boundary + 1000))
  assert.equal(completedCandles([...candles, forming], interval, boundary + 300000).length, 61)
})

test('agent indicators match full chart history at the latest completed candle', () => {
  const candles = fixture()
  const result = analyzePriceAction(candles, interval, now)
  const averages = calculateMovingAverageSeries(candles.map(c => c[4])).at(-1)
  const indicators = calculateTechnicalIndicatorSeries(candles.map(c => c[2]), candles.map(c => c[3]), candles.map(c => c[4])).at(-1)
  assert.equal(result.movingAverage20, averages.sma20)
  assert.equal(result.exponentialMovingAverage20, averages.ema20)
  assert.equal(result.exponentialMovingAverage50, averages.ema50)
  assert.equal(result.rsi14, indicators.rsi14)
  assert.equal(result.supertrend10, indicators.supertrend10)
  assert.equal(result.supertrendDirection, indicators.supertrendDirection)
})

test('bullish and bearish pressure produce respective early directional views', () => {
  for (const [direction, bias] of [[1, 'BULLISH'], [-1, 'BEARISH']]) {
    const result = analyzePriceAction(fixture(260, direction), interval, now)
    assert.equal(result.earlyBias, bias)
    if (direction === -1) {
      assert.equal(result.earlyStage, 'EARLY')
      assert.equal(result.side, 'WAIT')
    }
    assert.ok(result.bullishScore >= 0 && result.bullishScore <= 100)
    assert.ok(result.bearishScore >= 0 && result.bearishScore <= 100)
    if (result.earlyStage === 'TRIGGER') {
      assert.ok(bias === 'BULLISH' ? result.currentPrice > result.bullishTrigger : result.currentPrice < result.bearishTrigger)
    }
  }
})

test('insufficient history cannot produce a trade or early prediction', () => {
  const result = analyzePriceAction(fixture(10), interval, now)
  assert.equal(result.side, 'WAIT')
  assert.equal(result.earlyBias, 'NEUTRAL')
})

test('old ticks never fabricate new bars and cumulative volume never becomes candle volume', () => {
  const candles = fixture(60)
  const time = new Date(candles.at(-1)[0]).getTime()
  const tick = { timestamp: time, ltp: candles.at(-1)[4] + 2, volume: 9999999 }
  const updated = applyLiveTick(candles, tick, interval)
  assert.equal(updated.length, candles.length)
  assert.equal(updated.at(-1)[5], 1000)
  assert.equal(applyLiveTick(candles, { ...tick, timestamp: time - 300000 }, interval), candles)
  const next = applyLiveTick(updated, { ...tick, timestamp: time + 300000 }, interval)
  assert.equal(next.length, 61)
  assert.equal(next.at(-1)[5], 0)
  assert.deepEqual(applyLiveTick(candles, { ...tick, timestamp: time / 1000 }, interval), updated)
})

test('all timeframe close boundaries are respected', () => {
  for (const [selected, duration] of [['FIVE_MINUTE', 300000], ['FIFTEEN_MINUTE', 900000], ['ONE_HOUR', 3600000]]) {
    const candles = fixture(1)
    assert.equal(completedCandles(candles, selected, start + duration - 1).length, 0)
    assert.equal(completedCandles(candles, selected, start + duration).length, 1)
  }
})
