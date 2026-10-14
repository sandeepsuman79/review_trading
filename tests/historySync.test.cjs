const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8').replace(/import\.meta\.env\.VITE_ANGELONE_API_KEY/g, '"fixture"'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename)
const { prioritizeHistoryJobs, historySyncRange, formatHistoricalDate, historyRetryDelay, abortableWait } = require('../src/analysis/historySync.ts')
const { getHistoricalCandles, HistoricalRequestError } = require('../src/api/angelOne.ts')
const { LiveCandleBook } = require('../src/analysis/liveCandleBook.ts')
const { cachedCandleIndicators } = require('../src/analysis/candleIndicatorCache.ts')
const now = Date.parse('2026-10-14T11:00:00Z')

test('active index/timeframe has priority and changing selection reorders only pending jobs', () => {
  const jobs = ['FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR'].flatMap(interval => ['nifty', 'sensex', 'bank'].map(token => ({ token, interval, cursor: 123 })))
  const ordered = prioritizeHistoryJobs(jobs, 'bank', 'ONE_HOUR')
  assert.equal(ordered[0].token, 'bank'); assert.equal(ordered[0].interval, 'ONE_HOUR'); assert.equal(ordered[0].cursor, 123)
  assert.deepEqual(ordered.slice(0, 3).map(job => job.token), ['bank', 'bank', 'bank'])
  assert.equal(prioritizeHistoryJobs(ordered.slice(1), 'sensex', 'FIVE_MINUTE')[0].token, 'sensex')
  assert.equal(jobs[0].token, 'nifty')
})

test('cold starts are bounded, warm sync overlaps last bar, stale gaps respect all maximum windows', () => {
  for (const [interval, days, limit, duration] of [['FIVE_MINUTE', 14, 100, 300000], ['FIFTEEN_MINUTE', 45, 200, 900000], ['ONE_HOUR', 120, 400, 3600000]]) {
    const cold = historySyncRange([], interval, now)
    assert.equal(cold.to, now); assert.equal(cold.from, now - days * 86400000 - duration)
    const candles = Array.from({ length: 60 }, (_, i) => [new Date(now - (60 - i) * duration).toISOString(), 100, 101, 99, 100, 0])
    const warm = historySyncRange(candles, interval, now)
    assert.equal(warm.from, now - 2 * duration)
    const old = candles.map(candle => [new Date(Date.parse(candle[0]) - 500 * 86400000).toISOString(), ...candle.slice(1)])
    const chunk = historySyncRange(old, interval, now)
    assert(chunk.to < now); assert(chunk.to - chunk.from < limit * 86400000)
  }
  assert.equal(formatHistoricalDate(Date.parse('2023-09-06T05:45:00Z')), '2023-09-06 11:15')
})

test('bounded retry classes respect broker cooldown and never retry expired authorization', () => {
  assert.equal(historyRetryDelay({ status: 429, retryAfterMs: 60000 }, 0), 60000)
  assert.equal(historyRetryDelay(new Error('AB1021 exceeding access rate'), 1), 30000)
  assert.equal(historyRetryDelay({ status: 502 }, 1), 4000)
  assert.equal(historyRetryDelay(new Error('Failed to fetch'), 0), 2000)
  for (const failure of [{ status: 401 }, { status: 403 }, new Error('AG8001 Invalid Token'), new Error('Invalid interval')]) assert.equal(historyRetryDelay(failure, 0), undefined)
})

test('cancellation interrupts background waits', async () => {
  const controller = new AbortController(), promise = abortableWait(60000, controller.signal)
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
})

test('HTTP 200 broker failures are errors; valid empty results remain successful', async () => {
  const original = global.fetch
  try {
    global.fetch = async () => Response.json({ status: false, message: 'Too many requests', errorcode: 'AB1021', retryAfterMs: 15000 })
    await assert.rejects(getHistoricalCandles('fixture', {}), error => error instanceof HistoricalRequestError && /AB1021/.test(error.message) && error.retryAfterMs === 15000)
    global.fetch = async () => Response.json({ status: true, data: [] })
    assert.deepEqual((await getHistoricalCandles('fixture', {})).data, [])
  } finally { global.fetch = original }
})

test('idle persistence saves one dirty timeframe without dropping unsaved data', () => {
  const book = new LiveCandleBook(() => [])
  book.accept({ token: 'nifty', timestamp: now, ltp: 100, mode: 1, exchangeType: 1 }, now)
  let saved = 0
  assert.equal(book.flush(() => { saved++ }, 1), 2)
  assert.equal(saved, 1)
  assert.equal(book.flush(() => { saved++ }), 0)
  assert.equal(saved, 3)
})

test('memory indicator cache reuses immutable snapshots and invalidates on corrections or candle completion', () => {
  const boundary = Date.parse('2026-10-14T10:45:00Z')
  const candles = Array.from({ length: 70 }, (_, i) => [new Date(boundary - (69 - i) * 300000).toISOString(), 100 + i, 102 + i, 99 + i, 101 + i, 100])
  const first = cachedCandleIndicators(candles, 'FIVE_MINUTE', boundary + 1000)
  assert.equal(first.closed.length, 69)
  assert.equal(cachedCandleIndicators(candles, 'FIVE_MINUTE', boundary + 5000), first)
  const next = cachedCandleIndicators(candles, 'FIVE_MINUTE', boundary + 300000)
  assert.notEqual(next, first); assert.equal(next.closed.length, 70)
  const corrected = candles.map((bar, i) => i === 69 ? [bar[0], bar[1], bar[2] + 1, bar[3], bar[4] + 1, bar[5]] : bar)
  assert.notEqual(cachedCandleIndicators(corrected, 'FIVE_MINUTE', boundary + 300000), next)
  assert.notEqual(cachedCandleIndicators(candles, 'ONE_HOUR', boundary + 300000), next)
})
