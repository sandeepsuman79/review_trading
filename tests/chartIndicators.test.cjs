const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename)
const { calculateAtr, calculateTechnicalIndicatorSeries } = require('../src/analysis/technicalIndicators.ts')
const { candleSession, calculateSessionVwap, buildSessionVwapSeries } = require('../src/analysis/vwap.ts')
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
const candle = (time, typical, volume) => [time, typical, typical + 2, typical - 2, typical, volume]

test('ATR(14) warms up using 14 true ranges and includes gaps from the preceding close', () => {
  const highs = [...Array(14).fill(100), 125, 122], lows = [...Array(14).fill(99), 123, 120], closes = [...Array(14).fill(100), 124, 121]
  const values = calculateAtr(highs, lows, closes)
  assert(values.slice(0, 13).every(value => value === undefined))
  assert.equal(values[13], 1)
  near(values[14], (13 + 25) / 14)
  near(values[15], ((13 + 25) / 14 * 13 + 4) / 14)
  assert.deepEqual(calculateAtr(highs.slice(0, 13), lows, closes), Array(13).fill(undefined))
})

test('ATR uses Wilder smoothing with custom periods and returns genuine zero in a flat market', () => {
  assert.deepEqual(calculateAtr([110, 125, 127], [100, 115, 126], [105, 120, 126.5], 2), [undefined, 15, 11])
  assert.deepEqual(calculateAtr(Array(15).fill(100), Array(15).fill(100), Array(15).fill(100)).slice(13), [0, 0])
  for (const period of [0, -1, 1.5, Infinity]) assert.deepEqual(calculateAtr([100], [99], [100], period), [undefined])
})

test('invalid ATR input restarts warmup without NaN or infinite indicator values', () => {
  assert.deepEqual(calculateAtr([110, NaN, 110, 112], [100, 100, 100, 102], [105, 105, 105, 107], 2), [undefined, undefined, undefined, 10])
  assert.deepEqual(calculateAtr([99, 110, 112], [100, 100, 102], [99, 105, 107], 2), [undefined, undefined, 10])
})

test('the shared technical series exposes ATR(14) without using future candle ranges', () => {
  const highs = Array.from({ length: 20 }, (_, i) => 102 + i), lows = highs.map(value => value - 3), closes = highs.map(value => value - 1)
  const full = calculateTechnicalIndicatorSeries(highs, lows, closes)
  const prefix = calculateTechnicalIndicatorSeries(highs.slice(0, 14), lows.slice(0, 14), closes.slice(0, 14))
  assert.deepEqual(full.slice(0, 14), prefix)
  assert.equal(full[13].atr14, 3)
})

test('session VWAP weights HLC3 by actual interval volume, not the count of candles', () => {
  const candles = [candle('2026-10-12T09:15:00+05:30', 12, 2), candle('2026-10-12T09:20:00+05:30', 20, 1), candle('2026-10-12T09:25:00+05:30', 100, 0)]
  const values = calculateSessionVwap(candles)
  assert.equal(values[0], 12)
  near(values[1], 44 / 3); near(values[2], 44 / 3)
  assert.notEqual(values[1], 16, 'Equal candle weighting would be a fabricated substitute for volume')
})

test('VWAP resets at each IST trading date, independently of timestamp offsets and browser timezone', () => {
  assert.equal(candleSession('2026-10-11T20:00:00Z'), '2026-10-12')
  assert.equal(candleSession('2026-10-12T01:30:00+05:30'), '2026-10-12')
  const candles = [candle('2026-10-09T15:25:00+05:30', 100, 200), candle('2026-10-12T09:15:00+05:30', 10, 1), candle('2026-10-12T09:20:00+05:30', 20, 3)]
  assert.deepEqual(calculateSessionVwap(candles), [100, 10, 17.5])
  assert.equal(candleSession('invalid'), '')
})

test('zero-volume spot candles never invent VWAP or carry a previous day into a volume-less session', () => {
  const empty = [candle('2026-10-12T09:15:00+05:30', 22520, 0), candle('2026-10-12T09:20:00+05:30', 22530, 0)]
  assert.deepEqual(calculateSessionVwap(empty), [undefined, undefined])
  assert.deepEqual(buildSessionVwapSeries(empty, calculateSessionVwap(empty)), [])
  assert.deepEqual(calculateSessionVwap([candle('2026-10-09T15:25:00+05:30', 100, 2), ...empty]), [100, undefined, undefined])
})

test('VWAP handles invalid quantities and malformed candles without corrupting valid session sums', () => {
  const good = candle('2026-10-12T09:15:00+05:30', 10, 2)
  const bad = [candle('2026-10-12T09:20:00+05:30', 99, -1), candle('2026-10-12T09:25:00+05:30', 99, NaN), candle('invalid', 99, 1), ['2026-10-12T09:30:00+05:30', 10, 5, 15, 10, 100]]
  assert.deepEqual(calculateSessionVwap([good, ...bad, candle('2026-10-12T09:35:00+05:30', 20, 2)]), [10, undefined, undefined, undefined, undefined, 15])
})

test('VWAP paths are separate for each session and large valid volumes remain finite', () => {
  const candles = [candle('2026-10-09T15:20:00+05:30', 100, 1e300), candle('2026-10-09T15:25:00+05:30', 200, 1e300), candle('2026-10-12T09:15:00+05:30', 10, 2), candle('2026-10-12T09:20:00+05:30', 20, 2)]
  const values = calculateSessionVwap(candles)
  assert.deepEqual(values, [100, 150, 10, 15])
  const series = buildSessionVwapSeries(candles, values)
  assert.equal(series.length, 2)
  assert.deepEqual(series.map(line => line.data.map(point => point.x)), [[0, 1], [2, 3]])
})
