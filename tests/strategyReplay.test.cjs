const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
const { replayStrategy, evaluateReplaySetup, replayLimits } = require('../src/analysis/strategyReplay.ts')
const { mcxSession } = require('../src/analysis/commodities.ts')
const duration = 300000, start = Date.parse('2026-10-16T09:15:00+05:30')
const row = (time, open = 1000, high = 1002, low = 998, close = 1000) => [new Date(time).toISOString(), open, high, low, close, 0]
const history = (at = start, count = 50) => Array.from({ length: count }, (_, i) => row(at + i * duration))
const contract = (name = 'Gold', root = 'GOLD') => ({ name, root, token: '123456', symbol: `${root}20NOV26FUT`, exchange: 'MCX', exchangeType: 5, expiry: '2026-11-20', expiresAt: mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close, tickSize: 1 })
function evaluator(side = 'CALL') {
  return ({ instrument, contract, candles, now }) => candles.length === 50 ? { id: `${instrument}:${side}:${now}`, instrument, contract, interval: 'FIVE_MINUTE', side, stage: 'CONFIRMED', strategyVersion: 'technical-v2', signalCandleTime: candles.at(-1)[0], generatedAt: now, expiresAt: now + duration, entry: 1000, stopLoss: side === 'CALL' ? 990 : 1010, target: side === 'CALL' ? 1020 : 980 } : undefined
}

test('chronological evaluation sees only completed prefixes; entry waits for next open and only one position is open', () => {
  const candles = [...history(), row(start + 50 * duration), row(start + 51 * duration, 1001, 1004, 999, 1002)]
  const seen = [], evaluate = evaluator()
  const result = replayStrategy({ instrument: 'Nifty 50', candles }, input => {
    assert(input.candles.every(c => Date.parse(c[0]) + duration <= input.now))
    seen.push(input.candles.at(-1)[0])
    return evaluate(input)
  })
  assert.deepEqual(seen, [candles[49][0]])
  assert.equal(result.trades.length, 1)
  assert.equal(result.trades[0].entryTime, candles[50][0])
  assert.equal(result.trades[0].entry, 1000)
  assert.equal(result.trades[0].outcome, 'END_OF_DATA')
  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.winRate, null)
  const changed = [...candles.slice(0, 51), row(start + 51 * duration, 1000, 5000, 500, 2000)]
  const other = replayStrategy({ instrument: 'Nifty 50', candles: changed }, evaluate)
  assert.equal(other.trades[0].entry, result.trades[0].entry)
  assert.equal(other.trades[0].signalId, result.trades[0].signalId)
  assert.equal(other.trades[0].outcome, 'AMBIGUOUS')
})

test('gap-to-target and shock-invalidated opens cannot enter an already consumed setup', () => {
  for (const side of ['CALL', 'PUT']) for (const open of [side === 'CALL' ? 1021 : 979, side === 'CALL' ? 989 : 1011]) {
    const result = replayStrategy({ instrument: 'Nifty 50', candles: [...history(), row(start + 50 * duration, open, open + 1, open - 1, open)] }, evaluator(side))
    assert.equal(result.summary.entered, 0)
    assert(Object.keys(result.rejected).some(key => /RR|TRIGGER/.test(key)))
  }
  const missed = replayStrategy({ instrument: 'Nifty 50', candles: [...history(), row(start + 50 * duration, 999, 1025, 998, 1020)] }, evaluator())
  assert.equal(missed.summary.entered, 0, 'intrabar trigger fill must not be inferred from high/low')
})

test('dual-touch OHLC is excluded, while stop gaps use the observed worse open symmetrically', () => {
  for (const side of ['CALL', 'PUT']) {
    const both = replayStrategy({ instrument: 'Sensex', candles: [...history(), row(start + 50 * duration, 1000, 1021, 979, 1000)] }, evaluator(side))
    assert.equal(both.trades[0].outcome, 'AMBIGUOUS'); assert.equal(both.summary.resolved, 0); assert.equal(both.summary.netR, 0)
    const gap = side === 'CALL' ? 980 : 1020
    const result = replayStrategy({ instrument: 'Sensex', candles: [...history(), row(start + 50 * duration), row(start + 51 * duration, gap, gap + 1, gap - 1, gap)] }, evaluator(side))
    assert.equal(result.trades[0].outcome, 'STOP'); assert.equal(result.trades[0].exit, gap); assert.equal(result.summary.netR, -2)
  }
})

test('costs and slippage are explicit, adverse and reflected in R and realised drawdown', () => {
  const candles = [...history(), row(start + 50 * duration, 1000, 1021, 999, 1020)]
  const result = replayStrategy({ instrument: 'Bank Nifty', candles, costs: { slippagePointsPerSide: 1, roundTripCostPoints: 2 } }, evaluator())
  assert.equal(result.trades[0].entry, 1001); assert.equal(result.trades[0].exit, 1019)
  assert.equal(result.summary.grossPoints, 18); assert.equal(result.summary.netPoints, 16)
  assert.equal(result.summary.netR, Math.round(16 / 11 * 1e8) / 1e8)
  const loss = replayStrategy({ instrument: 'Nifty 50', candles: [...history(), row(start + 50 * duration, 1000, 1001, 989, 990)] }, evaluator())
  assert.equal(loss.summary.maximumRealisedDrawdownPoints, 10)
  assert.equal(loss.summary.maximumRealisedDrawdownR, 1)
  assert.equal(result.assumptions.defaultCostsAreZero, false)
})

test('missing next bar cancels entry, missing active observations remain unknown, and short history cannot run a model', () => {
  const noNext = replayStrategy({ instrument: 'Nifty 50', candles: [...history(), row(start + 51 * duration)] }, evaluator())
  assert.equal(noNext.summary.entered, 0); assert.equal(noNext.rejected.MISSING_NEXT_OPEN, 1)
  const evaluate = evaluator()
  let calledAfterGap = false
  const gap = replayStrategy({ instrument: 'Nifty 50', candles: [...history(), row(start + 50 * duration), row(start + 52 * duration, 1000, 1050, 900, 1030), row(start + 53 * duration)] }, input => {
    if (input.candles.length > 50) calledAfterGap = true
    return evaluate(input)
  })
  assert.equal(gap.trades[0].outcome, 'DATA_GAP'); assert.equal(gap.summary.resolved, 0)
  assert.equal(calledAfterGap, false, 'unknown old exit blocks replacement until next IST session')
  const short = replayStrategy({ instrument: 'Nifty 50', candles: history(start, 49) }, () => { throw new Error('must not evaluate before warmup') })
  assert.equal(short.data.evaluations, 0); assert.match(short.warnings[0], /Insufficient/)
})

test('index cutoff is 15:15; MCX retains its own later session and squares off at the observed close', () => {
  const indexStart = Date.parse('2026-10-16T11:00:00+05:30')
  const index = replayStrategy({ instrument: 'Nifty 50', candles: [...history(indexStart), row(indexStart + 50 * duration, 1000, 1002, 999, 1001)] }, evaluator())
  assert.equal(index.trades[0].outcome, 'SQUARE_OFF')
  assert.equal(index.trades[0].exitTime, '2026-10-16T09:45:00.000Z')
  assert.equal(index.trades[0].exit, 1001)
  for (const date of ['2026-10-16', '2026-11-20']) {
    const gold = contract(), end = mcxSession(Date.parse(`${date}T12:00:00+05:30`)).close
    const late = end - 51 * duration
    const mcx = replayStrategy({ instrument: 'Gold', contract: gold, candles: [...history(late), row(late + 50 * duration, 1000, 1002, 999, 1001)] }, evaluator())
    assert.equal(mcx.trades[0].outcome, 'SQUARE_OFF'); assert.equal(mcx.trades[0].exitTime, new Date(end).toISOString())
    const closedIndex = replayStrategy({ instrument: 'Nifty 50', candles: history(late, 52) }, () => { throw new Error('index must not analyse for entry during MCX evening') })
    assert.equal(closedIndex.data.evaluations, 0)
  }
})

test('real production strategy confirms both directions for all seven instruments without invented contextual inputs', () => {
  const at = Date.parse('2026-10-16T14:00:00+05:30')
  for (const [instrument, base, scale, root] of [['Nifty 50', 22000, 1], ['Sensex', 74000, 3], ['Bank Nifty', 50000, 2], ['Natural Gas', 300, .2, 'NATURALGAS'], ['Crude Oil', 6000, 2, 'CRUDEOIL'], ['Gold', 110000, 10, 'GOLD'], ['Silver', 90000, 10, 'SILVER']]) for (const d of [1, -1]) {
    const candles = Array.from({ length: 52 }, (_, i) => { const o = base + d * (i * .3 + Math.sin(i / 4) * 6) * scale, c = o + d * 2 * scale; return [new Date(at - (52 - i) * duration).toISOString(), o, Math.max(o, c) + .7 * scale, Math.min(o, c) - .7 * scale, c, root ? 100 : 0] })
    const matched = root ? { ...contract(instrument, root), tickSize: root === 'NATURALGAS' ? .1 : 1 } : undefined
    const plan = evaluateReplaySetup({ instrument, contract: matched, candles, now: at })
    assert.equal(plan?.stage, 'CONFIRMED', instrument)
    assert.equal(plan.side, d === 1 ? 'CALL' : 'PUT')
    assert.equal(plan.evidenceSummary.indiaVix, undefined)
    assert(plan.coverage.includes('Public market context unavailable'))
    assert.equal(plan.evidenceSummary.layers.find(layer => layer.name === 'OI / PCR').coverage, 0)
  }
})

test('reject malformed/oversized history, wrong timeframe, duplicate timestamps and crossed MCX contract expiry', () => {
  for (const input of [
    { instrument: 'Bitcoin', candles: [] }, { instrument: 'Nifty 50', interval: 'ONE_MINUTE', candles: [] },
    { instrument: 'Gold', candles: history() }, { instrument: 'Gold', contract: contract('Silver', 'SILVER'), candles: history() },
    { instrument: 'Nifty 50', candles: [row(start), row(start)] }, { instrument: 'Nifty 50', candles: [row(start + 1000)] },
    { instrument: 'Nifty 50', candles: [row(start, 1000, 999, 998, 1000)] }, { instrument: 'Nifty 50', candles: [[...row(start).slice(0, 5), -1]] },
    { instrument: 'Nifty 50', candles: Array(replayLimits.candles + 1).fill(row(start)) },
    { instrument: 'Nifty 50', candles: [], costs: { roundTripCostPoints: -1 } },
    { instrument: 'Gold', contract: contract(), candles: [row(Date.parse('2026-11-23T10:00:00+05:30'))] },
  ]) assert.throws(() => replayStrategy(input), Error)
})

test('offline CLI emits honest JSON and only creates an explicitly chosen new report file', () => {
  const { spawnSync } = require('node:child_process'), path = require('node:path'), os = require('node:os')
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-replay-'))
  try {
    const source = path.join(folder, 'candles.json'), output = path.join(folder, 'report.json')
    fs.writeFileSync(source, JSON.stringify({ instrument: 'Nifty 50', candles: history(start, 49) }))
    const cli = path.resolve(__dirname, '../scripts/replay-agent.cjs')
    const run = spawnSync(process.execPath, [cli, source], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const report = JSON.parse(run.stdout)
    assert.equal(report.summary.resolved, 0); assert.equal(report.data.evaluations, 0)
    assert(report.assumptions.missingContext.includes('Historical India VIX'))
    const save = spawnSync(process.execPath, [cli, source, '--output', output], { encoding: 'utf8' })
    assert.equal(save.status, 0, save.stderr); assert.equal(save.stdout, '')
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).version, 'offline-candle-replay-v1')
    const duplicate = spawnSync(process.execPath, [cli, source, '--output', output], { encoding: 'utf8' })
    assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /exist/)
  } finally { fs.rmSync(folder, { recursive: true, force: true }) }
})
