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
