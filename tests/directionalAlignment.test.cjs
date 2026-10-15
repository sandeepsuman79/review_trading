const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
const { analyzeDirectionalAlignment } = require('../src/analysis/directionalAlignment.ts')
const { findMomentumSetups } = require('../src/analysis/momentumSetups.ts')
const start = Date.parse('2026-10-14T09:15:00+05:30')
function fixture(kind, d) {
  let candles = Array.from({ length: 60 }, (_, i) => [new Date(start + i * 300000).toISOString(), 100, 101, 99, 100, 0])
  candles[58] = [candles[58][0], 100, 101.2, 99.5, 100.4, 0]
  candles[59] = [candles[59][0], 100.2, 102.2, 100, 102, 0]
  let averages = candles.map(() => ({ ema20: 100.5, ema50: 101 }))
  let indicators = candles.map(() => ({ atr14: 2, adx14: 10, plusDi14: 10, minusDi14: 30, rsi14: 45, supertrendDirection: 'DOWN', supertrend10: 103 }))
  const levels = {}
  if (kind === 'ema-slope') averages[59].ema20 = 100.8
  if (kind === 'ema-cross') averages[59].ema20 = 101.2
  if (kind === 'st-slope') {
    indicators = indicators.map(p => ({ ...p, supertrendDirection: 'UP', supertrend10: 98 }))
    indicators[59].supertrend10 = 98.3
  }
  if (kind === 'st-flip') indicators[59] = { ...indicators[59], supertrendDirection: 'UP', supertrend10: 98 }
  if (kind === 'level-break') levels.priorResistance = 101.2
  if (kind === 'level-reverse') levels.support = 100
  if (d === -1) {
    candles = candles.map(c => [c[0], 200-c[1], 200-c[3], 200-c[2], 200-c[4], 0])
    averages = averages.map(p => ({ ema20: 200-p.ema20, ema50: 200-p.ema50 }))
    indicators = indicators.map(p => ({ ...p, rsi14: 100-p.rsi14, plusDi14: p.minusDi14, minusDi14: p.plusDi14, supertrendDirection: p.supertrendDirection === 'UP' ? 'DOWN' : 'UP', supertrend10: 200-p.supertrend10 }))
    if (levels.support !== undefined) { levels.resistance = 200-levels.support; delete levels.support }
    if (levels.priorResistance !== undefined) { levels.priorSupport = 200-levels.priorResistance; delete levels.priorResistance }
  }
  return { candles, averages, indicators, levels }
}

for (const [kind, family, wording] of [['ema-slope','EMA','trajectory'],['ema-cross','EMA','crossed'],['st-slope','SUPERTREND','trajectory'],['st-flip','SUPERTREND','flipped'],['level-break','LEVEL','crossed'],['level-reverse','LEVEL','reversal']]) {
  test(`${kind} independently supports CALL and PUT with completed price confirmation`, () => {
    for (const d of [1, -1]) {
      const { candles, averages, indicators, levels } = fixture(kind, d), side = d === 1 ? 'CALL' : 'PUT'
      const alignment = analyzeDirectionalAlignment(candles, averages, indicators, 'FIVE_MINUTE', levels)
      assert(alignment.routes.length > 0)
      assert(alignment.routes.every(route => route.family === family && route.side === side), 'no second directional family is required')
      assert(alignment.routes.some(route => route.name.includes(wording)))
      const candidates = findMomentumSetups(candles, averages, indicators, 'FIVE_MINUTE', undefined, undefined, alignment)
      assert(candidates.some(candidate => candidate.side === side))
      assert(candidates.every(candidate => candidate.side === side && Math.abs(candidate.entry-candidate.stopLoss) >= 2))
      if (family === 'LEVEL') assert(candidates.some(candidate => candidate.pattern === 'LEVEL_BREAK_REVERSAL'))
      // A directional indicator by itself cannot promote an indecisive price candle.
      const indecisive = candles.map((c, i) => i === 59 ? [c[0], c[4]-.02*d, c[2], c[3], c[4], 0] : c)
      assert.equal(findMomentumSetups(indecisive, averages, indicators, 'FIVE_MINUTE', undefined, undefined, alignment).length, 0)
    }
  })
}

test('flat data, gaps and overnight comparisons cannot invent a directional route', () => {
  const { candles, averages, indicators } = fixture('none', 1)
  assert.equal(analyzeDirectionalAlignment(candles, averages, indicators, 'FIVE_MINUTE').routes.length, 0)
  const aligned = fixture('ema-cross', 1)
  for (const shift of [300000, 86400000]) {
    const broken = aligned.candles.map((c,i) => i === 59 ? [new Date(Date.parse(c[0])+shift).toISOString(), ...c.slice(1)] : c)
    assert.equal(analyzeDirectionalAlignment(broken, aligned.averages, aligned.indicators, 'FIVE_MINUTE').routes.length, 0)
  }
})

test('conflicting directional routes remain visible rather than becoming one unanimous vote', () => {
  const data = fixture('ema-cross', 1)
  data.indicators[59] = { ...data.indicators[59], supertrendDirection: 'DOWN', supertrend10: 102.1 }
  data.indicators[58].supertrendDirection = 'UP'
  const result = analyzeDirectionalAlignment(data.candles, data.averages, data.indicators, 'FIVE_MINUTE')
  assert(result.bullish.some(name => name.includes('EMA')))
  assert(result.bearish.some(name => name.includes('Supertrend')))
})

test('fast EMA20 turns can precede EMA50 alignment, but require a completed price break and improving RSI', () => {
  for (const d of [1, -1]) {
    const data = fixture('none', d), side = d === 1 ? 'CALL' : 'PUT'
    data.averages[53].ema20 = 100 + d * .9
    data.averages[56].ema20 = 100 + d * .2
    data.averages[59].ema20 = 100 + d * .6
    data.indicators[59].rsi14 = data.indicators[58].rsi14 + d * 2
    const getTurns = () => analyzeDirectionalAlignment(data.candles, data.averages, data.indicators, 'FIVE_MINUTE').routes.filter(route => route.name.includes('turned'))
    assert.equal(getTurns().length, 1); assert.equal(getTurns()[0].side, side)
    assert(d * (data.averages[59].ema20 - data.averages[59].ema50) < 0, 'EMA50 has not crossed yet')
    const rsi = data.indicators[59].rsi14
    data.indicators[59].rsi14 = data.indicators[58].rsi14
    assert.equal(getTurns().length, 0)
    data.indicators[59].rsi14 = rsi
    const close = data.candles[59][4]
    data.candles[59][4] = d === 1 ? data.candles[58][2] : data.candles[58][3]
    assert.equal(getTurns().length, 0)
    data.candles[59][4] = close
    data.averages[53].ema20 = data.averages[56].ema20
    assert.equal(getTurns().length, 0, 'a one-way slope is not a turn')
    data.averages[53].ema20 = 100 + d * .9
    data.candles[54][0] = new Date(Date.parse(data.candles[54][0]) + 60000).toISOString()
    assert.equal(getTurns().length, 0, 'missing bars invalidate the six-bar comparison')
  }
})

test('three-candle reversals mirror CALL and PUT at observed levels, without manufacturing a missing setup', () => {
  for (const d of [1, -1]) {
    const data = fixture('none', 1)
    data.candles = data.candles.map((c, i) => [new Date(start + i * 60000).toISOString(), ...c.slice(1)])
    data.candles[57] = [data.candles[57][0], 102, 102.2, 99.8, 100, 0]
    data.candles[58] = [data.candles[58][0], 99.9, 100.4, 99.5, 100, 0]
    data.candles[59] = [data.candles[59][0], 100.1, 102.3, 100, 102, 0]
    if (d === -1) {
      data.candles = data.candles.map(c => [c[0], 200-c[1], 200-c[3], 200-c[2], 200-c[4], 0])
      data.averages = data.averages.map(p => ({ ema20: 200-p.ema20, ema50: 200-p.ema50 }))
    }
    const side = d === 1 ? 'CALL' : 'PUT', level = d === 1 ? 99.7 : 100.3
    const alignment = { at: data.candles[59][0], routes: [{ family: 'LEVEL', side, level, name: 'Observed level reaction' }] }
    const find = (support = d === 1 ? level : undefined, resistance = d === -1 ? level : undefined, routes = alignment) => findMomentumSetups(data.candles, data.averages, data.indicators, 'ONE_MINUTE', support, resistance, routes).filter(item => item.pattern === 'THREE_CANDLE_REVERSAL')
    const result = find()
    assert.equal(result.length, 1); assert.equal(result[0].side, side)
    const extreme = d === 1 ? Math.min(...data.candles.slice(-3).map(c => c[3])) : Math.max(...data.candles.slice(-3).map(c => c[2]))
    assert(d * (extreme - result[0].stopLoss) > 0, 'stop covers all three candles')
    assert(!findMomentumSetups(data.candles, data.averages, data.indicators, 'ONE_MINUTE', undefined, undefined, alignment).some(item => item.pattern === 'THREE_CANDLE_REVERSAL'), 'a missing observed level cannot be invented')
    assert.equal(find(undefined, undefined, { ...alignment, routes: [] }).length, 0)
    assert.equal(find(d === 1 ? level - 10 : undefined, d === -1 ? level + 10 : undefined).length, 0, 'a distant level does not qualify')
    const open = data.candles[58][1]
    data.candles[58][1] = data.candles[58][4] + d * .4
    assert.equal(find().length, 0, 'middle candle must lose momentum')
    data.candles[58][1] = open
    const timestamp = data.candles[57][0]
    data.candles[57][0] = new Date(Date.parse(timestamp) + 10000).toISOString()
    assert.equal(find().length, 0, 'missing bars interrupt the reversal pattern')
    data.candles[57][0] = timestamp
    data.candles[57][1] = data.candles[57][4] - d * .1
    assert.equal(find().length, 0, 'first candle must oppose the reversal')
  }
})
