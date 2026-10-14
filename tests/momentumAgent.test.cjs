const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
const { calculateDirectionalMovement } = require('../src/analysis/directionalMovement.ts')
const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
const { buildEarlyPrediction } = require('../src/analysis/earlyPrediction.ts')
const { findMomentumSetups } = require('../src/analysis/momentumSetups.ts')
const start = Date.parse('2026-10-13T09:15:00+05:30')
const fixture = (d = 1, count = 52) => Array.from({ length: count }, (_, i) => {
  const open = 22000 + d * (i * .3 + Math.sin(i / 4) * 6), close = open + d * 2
  return [new Date(start + i * 300000).toISOString(), open, Math.max(open, close) + .7, Math.min(open, close) - .7, close, 0]
})

test('Wilder DMI/ADX warms up correctly and distinguishes trend direction from strength', () => {
  for (const d of [1, -1]) {
    const highs = Array.from({ length: 40 }, (_, i) => 102 + d * i), lows = highs.map(h => h - 2), closes = highs.map(h => h - 1)
    const series = calculateDirectionalMovement(highs, lows, closes)
    assert(series.slice(0, 27).every(p => p.adx14 === undefined)); assert.equal(series[27].adx14, 100)
    assert.equal(series[27].plusDi14, d === 1 ? 50 : 0); assert.equal(series[27].minusDi14, d === -1 ? 50 : 0)
    assert.deepEqual(series.slice(0, 30), calculateDirectionalMovement(highs.slice(0, 30), lows.slice(0, 30), closes.slice(0, 30)))
  }
  assert.equal(calculateDirectionalMovement(Array(40).fill(100), Array(40).fill(100), Array(40).fill(100)).at(-1).adx14, 0)
})

test('invalid directional data restarts warmup without contaminating later values', () => {
  const highs = Array.from({ length: 70 }, (_, i) => 102 + i), lows = highs.map(h => h - 2), closes = highs.map(h => h - 1)
  highs[30] = NaN
  const series = calculateDirectionalMovement(highs, lows, closes)
  assert.equal(series[30].adx14, undefined); assert.equal(series[31].adx14, undefined)
  assert.equal(series.at(-1).adx14, 100)
})

test('real completed CALL and PUT momentum patterns confirm without unavailable OI/news or fabricated volume', () => {
  for (const d of [1, -1]) {
    const candles = fixture(d), now = start + candles.length * 300000
    const analysis = analyzePriceAction(candles, 'FIVE_MINUTE', now)
    assert.equal(analysis.pattern, 'TREND_MOMENTUM_BREAK'); assert.equal(analysis.side, d === 1 ? 'CALL' : 'PUT')
    const evidence = analyzeTradingEvidence({ analysis, candles, instrument: 'Nifty 50', interval: 'FIVE_MINUTE', now })
    assert.equal(evidence.canConfirm, true); assert(evidence.checks.every(check => check.passed))
    assert.equal(evidence.vwap, undefined)
    const result = buildEarlyPrediction(analysis, 'Nifty 50', 'FIVE_MINUTE', now, undefined, undefined, evidence)
    assert.equal(result.plan.stage, 'CONFIRMED'); assert(result.plan.riskReward >= 1.5)
    assert(Math.abs(result.plan.entry - result.plan.stopLoss) >= analysis.atr14 - .01)
    assert.match(result.plan.targetBasis, /projection.*not an observed level/)
    const forming = [new Date(now).toISOString(), 22000, 24000, 18000, 23000, 0]
    assert.deepEqual(analyzePriceAction([...candles, forming], 'FIVE_MINUTE', now), analysis)
  }
})

test('new setup families accept a directional route and reject gaps, overextension and nearby targets with insufficient room', () => {
  const candles = Array.from({ length: 60 }, (_, i) => [new Date(start + i * 300000).toISOString(), 100, 101, 99, 100, 0])
  candles[58] = [candles[58][0], 100, 101.2, 99, 100.5, 0]
  candles[59] = [candles[59][0], 100.7, 102.2, 100.5, 102, 0]
  const averages = candles.map(() => ({ ema20: 100, ema50: 98 })); averages[59].ema20 = 100.2
  const indicators = candles.map(() => ({ atr14: 2, adx14: 30, plusDi14: 30, minusDi14: 10, rsi14: 60, supertrendDirection: 'UP' }))
  const candidates = findMomentumSetups(candles, averages, indicators, 'FIVE_MINUTE')
  assert(candidates.some(c => c.pattern === 'EMA_PULLBACK_RECLAIM')); assert(candidates.some(c => c.pattern === 'TREND_MOMENTUM_BREAK'))
  assert(findMomentumSetups(candles, averages, indicators, 'FIVE_MINUTE', undefined, 102.5).every(c => c.target === 102.5), 'nearby resistance stays a cap, never stretched')
  assert(findMomentumSetups(candles, averages, indicators.map(p => ({ ...p, adx14: 10, supertrendDirection: 'DOWN' })), 'FIVE_MINUTE').length > 0, 'EMA route does not require ADX strength or Supertrend agreement')
  assert.equal(findMomentumSetups(candles, averages.map(() => ({ ema20: 100, ema50: 98 })), indicators, 'FIVE_MINUTE').length, 0, 'flat EMA and no Supertrend trajectory cannot create a route')
  const gap = candles.map((c, i) => i === 58 ? [new Date(Date.parse(c[0]) - 600000).toISOString(), ...c.slice(1)] : c)
  assert.equal(findMomentumSetups(gap, averages, indicators, 'FIVE_MINUTE').length, 0)
  const stretched = candles.map((c, i) => i === 59 ? [c[0], 106, 108, 105, 107.5, 0] : c)
  assert.equal(findMomentumSetups(stretched, averages, indicators, 'FIVE_MINUTE').length, 0)
})

test('opening-range setup uses the actual 09:15–09:30 bars and requires a first completed break', () => {
  const previous = Array.from({length:50}, (_,i)=>[new Date(start - 86400000 + i*300000).toISOString(),100,101,99,100,0])
  const today = Array.from({length:8}, (_,i)=>[new Date(start+i*300000).toISOString(),100,103,99,101,0])
  today[7]=[today[7][0],101.5,104,101,103.8,0]
  const candles=[...previous,...today], averages=candles.map(()=>({ema20:101,ema50:99})), indicators=candles.map(()=>({atr14:2,adx14:30,plusDi14:30,minusDi14:10,rsi14:60,supertrendDirection:'UP'}))
  averages.at(-1).ema20=101.2
  assert(findMomentumSetups(candles,averages,indicators,'FIVE_MINUTE').some(c=>c.pattern==='OPENING_RANGE_BREAKOUT'))
  const missingOpening=candles.filter(c=>c[0]!==today[0][0])
  assert(!findMomentumSetups(missingOpening,averages.slice(1),indicators.slice(1),'FIVE_MINUTE').some(c=>c.pattern==='OPENING_RANGE_BREAKOUT'))
})
