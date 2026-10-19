const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename)
const { decodeStreamPacket } = require('../src/api/streamPacket.ts')
const { LiveCandleBook } = require('../src/analysis/liveCandleBook.ts')
const { applyLiveTick, candleBucketTime, historicalCandleRequestStart, isFreshTick, normalizeCandles } = require('../src/analysis/candleData.ts')
const start = Date.parse('2026-10-09T09:15:00+05:30')
const intervals = ['FIFTEEN_MINUTE', 'FIVE_MINUTE', 'ONE_HOUR']
const bar = (time, open, high, low, close, volume = 0) => [new Date(time).toISOString(), open, high, low, close, volume]
const tick = (ltp, offset = 0, extra = {}) => ({ token: '99926000', mode: 1, exchangeType: 1, timestamp: start + offset, ltp, ...extra })
const packet = (mode = 1, cents = 2252045n) => {
  const buffer = new ArrayBuffer(mode === 1 ? 51 : mode === 2 ? 123 : 379), view = new DataView(buffer)
  view.setUint8(0, mode); view.setUint8(1, 1)
  new Uint8Array(buffer, 2, 25).set(new TextEncoder().encode('99926000'))
  view.setBigInt64(27, 123n, true); view.setBigInt64(35, BigInt(start), true); view.setBigInt64(43, cents, true)
  if (mode !== 1) {
    view.setBigInt64(51, 10n, true); view.setBigInt64(59, 2201234n, true); view.setBigInt64(67, 987654n, true)
    view.setFloat64(75, 123.5, true); view.setFloat64(83, 456.5, true)
    for (const [offset, price] of [[91, 2210020n], [99, 2260030n], [107, 2190040n], [115, 2200050n]]) view.setBigInt64(offset, price, true)
  }
  return buffer
}

test('LTP packet decodes full 64-bit price, timestamp and sequence without inventing volume', () => {
  const parsed = decodeStreamPacket(packet(1, 4000000000n))
  assert.equal(parsed.ltp, 40000000); assert.equal(parsed.timestamp, start); assert.equal(parsed.sequence, 123)
  assert.equal(parsed.volume, undefined); assert.equal(parsed.open, undefined)
})

test('quote and snapshot packets decode day OHLC and cumulative volume at official offsets', () => {
  for (const mode of [2, 3]) {
    const parsed = decodeStreamPacket(packet(mode))
    assert.equal(parsed.ltp, 22520.45); assert.equal(parsed.volume, 987654)
    assert.deepEqual([parsed.open, parsed.high, parsed.low, parsed.close], [22100.2, 22600.3, 21900.4, 22000.5])
  }
})

test('truncated packets, invalid prices and unsafe integers are rejected', () => {
  for (const buffer of [packet().slice(0, 47), packet().slice(0, 50), packet(2).slice(0, 122), packet(1, 0n), packet(1, -1n), packet(1, 9007199254740993n)]) {
    assert.throws(() => decodeStreamPacket(buffer))
  }
})

test('a burst preserves every high and low for all timeframes before one cache flush', () => {
  const book = new LiveCandleBook(() => [])
  for (const [value, offset] of [[100, 1], [120, 2], [90, 3], [105, 4]]) assert(book.accept(tick(value, offset), start + 4))
  for (const interval of intervals) assert.deepEqual(book.get('99926000', interval), [bar(start, 100, 120, 90, 105)])
  const writes = []
  book.flush((token, interval, candles) => writes.push({ token, interval, candles }))
  assert.equal(writes.length, 3)
  book.flush(() => assert.fail('Already-saved snapshots must not be written again'))
})

test('stale ticks and same-timestamp sequence replays cannot rewind the close or change wicks', () => {
  const book = new LiveCandleBook(() => [])
  assert(book.accept(tick(100, 20, { sequence: 3 }), start + 20))
  for (const incoming of [tick(999, 19), tick(999, 20, { sequence: 2 }), tick(999, 20, { sequence: 3 })]) assert.equal(book.accept(incoming, start + 20), false)
  assert.deepEqual(book.get('99926000', 'FIVE_MINUTE'), [bar(start, 100, 100, 100, 100)])
  assert(book.accept(tick(110, 20, { sequence: 4 }), start + 20))
  assert.equal(book.get('99926000', 'FIVE_MINUTE')[0][4], 110)
})

test('index packets with sequence zero can update multiple prices in the same millisecond', () => {
  const book = new LiveCandleBook(() => [])
  for (const value of [100, 110, 90, 101]) assert(book.accept(tick(value, 1, { sequence: 0 }), start + 1))
  assert.deepEqual(book.get('99926000', 'FIVE_MINUTE'), [bar(start, 100, 110, 90, 101)])
})

test('new candles open at their first received price on 5-minute, 15-minute and hourly boundaries', () => {
  for (const [interval, duration] of [['FIVE_MINUTE', 300000], ['FIFTEEN_MINUTE', 900000], ['ONE_HOUR', 3600000]]) {
    const book = new LiveCandleBook(() => [])
    book.accept(tick(100, duration - 1), start + duration)
    book.accept(tick(120, duration), start + duration)
    const candles = book.get('99926000', interval)
    assert.deepEqual(candles, [bar(start, 100, 100, 100, 100), bar(start + duration, 120, 120, 120, 120)])
    assert.equal(candleBucketTime(start + duration - 1, interval), start)
    assert.equal(candleBucketTime(start + duration, interval), start + duration)
  }
})

test('missing intervals are not fabricated and cumulative volume does not replace interval volume', () => {
  const book = new LiveCandleBook(() => [bar(start, 100, 110, 90, 100, 200)])
  book.accept(tick(105, 1000, { volume: 1000000 }), start + 1000)
  book.accept(tick(120, 1200000, { volume: 2000000 }), start + 1200000)
  const candles = book.get('99926000', 'FIVE_MINUTE')
  assert.equal(candles.length, 2); assert.equal(candles[0][5], 200); assert.equal(candles[1][5], 0)
  assert.equal(Date.parse(candles[1][0]), start + 1200000)
})

test('delayed history preserves ticks received during the request, including a candle that closed meanwhile', () => {
  const book = new LiveCandleBook(() => [])
  const requestedAt = start + 290000
  for (const [value, offset] of [[100, 291000], [120, 292000], [90, 293000], [110, 294000], [105, 300001]]) book.accept(tick(value, offset), start + offset)
  const history = [bar(start, 98, 108, 94, 100, 600), bar(start + 300000, 104, 104, 104, 104, 10)]
  assert.deepEqual(book.mergeHistory('99926000', 'FIVE_MINUTE', history, requestedAt), [bar(start, 98, 120, 90, 110, 600), bar(start + 300000, 104, 105, 104, 105, 10)])
})

test('a later authoritative history request corrects old cached candles and invalid records are ignored', () => {
  const book = new LiveCandleBook(() => [bar(start, 100, 110, 90, 100)])
  book.accept(tick(105, 1000), start + 1000)
  const corrected = bar(start, 99, 115, 89, 108, 500)
  assert.deepEqual(book.mergeHistory('99926000', 'FIVE_MINUTE', [corrected, bar(start, 99, 1, 200, 100)], start + 600000), [corrected])
})

test('an unchanged price still records its new exchange timestamp for history reconciliation', () => {
  const book = new LiveCandleBook(() => [])
  book.accept(tick(100, 1000), start + 1000)
  book.accept(tick(100, 3000), start + 3000)
  assert.equal(book.mergeHistory('99926000', 'FIVE_MINUTE', [bar(start, 99, 110, 90, 99, 400)], start + 2000)[0][4], 100)
})

test('all indices persist independently across refresh and failed saves can retry', () => {
  const saved = new Map(), load = (token, interval) => saved.get(`${token}:${interval}`) || []
  const book = new LiveCandleBook(load)
  for (const [token, value] of [['99926000', 22000], ['99919000', 80000], ['99926009', 50000]]) book.accept(tick(value, 0, { token }), start)
  assert.throws(() => book.flush(() => { throw new Error('Storage unavailable') }))
  book.flush((token, interval, candles) => saved.set(`${token}:${interval}`, candles))
  assert.equal(saved.size, 9)
  const refreshed = new LiveCandleBook(load)
  refreshed.accept(tick(22020, 1000), start + 1000)
  for (const interval of intervals) {
    assert.deepEqual(refreshed.get('99926000', interval), [bar(start, 22000, 22020, 22000, 22020)])
    assert.equal(refreshed.get('99919000', interval)[0][4], 80000)
  }
})

test('invalid and future quotes cannot form a candle; freshness expires without advancing candles', () => {
  const book = new LiveCandleBook(() => [])
  for (const incoming of [tick(0), tick(-1), tick(NaN), tick(100, 5001), tick(100, 0, { timestamp: NaN }), tick(100, 0, { timestamp: -1 })]) assert.equal(book.accept(incoming, start), false)
  assert.deepEqual(book.get('99926000', 'FIVE_MINUTE'), [])
  const quote = tick(100)
  assert(isFreshTick(quote, start + 60000)); assert.equal(isFreshTick(quote, start + 60001), false)
  assert.equal(isFreshTick(tick(100, 5001), start), false)
  const candles = [bar(start, 100, 110, 90, 100)]
  assert.equal(applyLiveTick(candles, tick(101, 0, { timestamp: 9e15 }), 'FIVE_MINUTE'), candles)
})

test('initial and live-only history requests respect broker limits and still warm up indicators', () => {
  for (const [interval, days] of [['FIVE_MINUTE', 100], ['FIFTEEN_MINUTE', 200], ['ONE_HOUR', 400]]) {
    for (const candles of [[], [bar(start, 100, 100, 100, 100)]]) assert.equal(historicalCandleRequestStart(candles, interval, start), start - days * 86400000)
    const old = Array.from({length: 60}, (_, i) => bar(start - (1000 - i) * 86400000, 100, 110, 90, 100))
    assert.equal(historicalCandleRequestStart(old, interval, start), start - days * 86400000)
  }
})

test('cached-history synchronization uses the IST session date and ignores malformed records', () => {
  const now = Date.parse('2026-10-09T14:11:00+05:30')
  const candles = Array.from({length:60},(_,i)=>bar(now - i * 300000, 100, 110, 90, 100))
  assert.equal(historicalCandleRequestStart(candles,'FIVE_MINUTE',now),Date.parse('2026-10-09T09:00:00+05:30'))
  assert.deepEqual(normalizeCandles([null, [], {}, candles[0]]), [candles[0]])
})
