const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, f)
const { exchangeSession } = require('../src/analysis/exchangeCalendar.ts')
const { instrumentSession, inTradingEntryWindow, squareOffTime, marketHours } = require('../src/analysis/tradingSession.ts')
const { monitoringWindow, canMonitorInstrument } = require('../src/analysis/monitoringSession.ts')
const { historyRefreshDue, historySyncRange } = require('../src/analysis/historySync.ts')
const { adjacentIndicatorBars } = require('../src/analysis/indicatorHistory.ts')
const { LiveCandleBook } = require('../src/analysis/liveCandleBook.ts')
const { candleBucketTime } = require('../src/analysis/candleData.ts')
const { completedChartHistory, observedSessionGap } = require('../src/analysis/chartStructure.ts')
const { analyzeCandleAgent, validCandleConfirmation } = require('../src/analysis/candleAgent.ts')
const { createPredictionRecord, observePredictionTick, writePredictionHistory, readPredictionHistory } = require('../src/analysis/predictionHistory.ts')
const { diagnoseTradeEntry } = require('../src/analysis/tradeEntry.ts')
const { mcxSession } = require('../src/analysis/commodities.ts')
const { openingRange } = require('../src/analysis/marketDashboard.ts')
const { sessionReviewDue } = require('../src/analysis/sessionReview.ts')
const { fixture, markets } = require('./helpers/confirmation.cjs')
const step = 300000, minute = 60000
const at = (clock, date = '2026-11-08') => Date.parse(`${date}T${clock}+05:30`)
const access = (expiry = at('23:59:59'), startedAt = at('09:00:00')) => ({ startedAt, token: `h.${Buffer.from(JSON.stringify({ exp: expiry / 1000 })).toString('base64url')}.s` })
const bar = (time, price = 100) => [new Date(time).toISOString(), price, price + 1, price - 1, price, 100]

function specialFixture(row, d) {
  const f = fixture(row, d, 'FIVE_MINUTE', at('14:35:00', '2026-11-06'))
  const previousClose = instrumentSession(at('12:00:00', '2026-11-06'), row[0]).close
  const slots = f.candles.map((_, i) => i < 49 ? previousClose - (49 - i) * step : at('14:20:00') + (i - 49) * step)
  return { ...f, slots, candles: f.candles.map((b, i) => [new Date(slots[i]).toISOString(), ...b.slice(1)]), now: at('14:35:00') }
}
const contract = row => row[3] ? { name: row[0], root: row[3], token: '12345', symbol: `${row[3]}20NOV26FUT`, expiry: '2026-11-20', expiresAt: mcxSession(at('12:00:00', '2026-11-20')).close, exchange: 'MCX', exchangeType: 5, tickSize: row[3] === 'NATURALGAS' ? .1 : 1 } : undefined

test('dated Muhurat hours override Sunday for every monitored underlying without changing weekday identity', () => {
  for (const row of markets) {
    const session = instrumentSession(at('14:30:00'), row[0])
    assert.equal(session.weekday, false); assert.equal(session.tradingDay, true); assert.equal(session.special, true)
    assert.equal(session.open, at('14:20:00')); assert.equal(session.close, at('15:30:00'))
    assert.equal(session.label, 'Diwali Muhurat trading'); assert(session.source.startsWith('https://'))
    assert.match(marketHours(row[0], at('14:30:00')), /Muhurat.*14:20/)
  }
  for (const segment of ['NFO', 'BFO']) assert.equal(exchangeSession(at('14:30:00'), segment).close, at('15:40:00'), 'derivatives timing is separate from spot-index agent timing')
})

test('login arms all seven agents until Muhurat open, runs in-session, then settles and stops', () => {
  const a = access()
  assert.equal(monitoringWindow(a, at('10:00:00')).phase, 'WAITING')
  assert.equal(monitoringWindow(a, at('10:00:00')).nextAt, at('14:20:00'))
  assert.equal(monitoringWindow(a, at('14:20:00')).phase, 'RUNNING')
  assert.equal(monitoringWindow(a, at('15:30:00')).phase, 'SETTLING')
  assert.equal(monitoringWindow(a, at('15:30:30')).phase, 'CLOSED')
  for (const row of markets) {
    for (const [clock, allowed] of [['14:05:00', false], ['14:19:59', false], ['14:20:00', true], ['15:29:59', true], ['15:30:29', true], ['15:30:30', false], ['18:00:00', false]]) assert.equal(canMonitorInstrument(a, at(clock), row[0]), allowed, `${row[0]} ${clock}`)
    assert.equal(canMonitorInstrument(a, at('15:30:00'), row[0], false), false)
  }
})

test('special session retains exact token expiry, rejected-login and same-login-date limits', () => {
  const a = access(at('14:40:00'))
  assert.equal(monitoringWindow(a, at('14:39:59')).phase, 'RUNNING')
  assert.equal(monitoringWindow(a, at('14:40:00')).phase, 'EXPIRED')
  for (const row of markets) {
    assert.equal(canMonitorInstrument(a, at('14:40:00'), row[0]), false)
    assert.equal(canMonitorInstrument({ ...a, blocked: true }, at('14:30:00'), row[0]), false)
    assert.equal(canMonitorInstrument(access(at('23:59:59'), at('10:00:00', '2026-11-06')), at('14:30:00'), row[0]), false)
    assert.equal(canMonitorInstrument(undefined, at('14:30:00'), row[0]), false)
  }
})

test('special-session entries start at actual open and respect separate index/MCX square-off', () => {
  for (const row of markets) {
    assert.equal(inTradingEntryWindow(at('14:19:59'), row[0]), false)
    assert.equal(inTradingEntryWindow(at('14:20:00'), row[0]), true)
    assert.equal(inTradingEntryWindow(at('15:14:59'), row[0]), true)
    assert.equal(inTradingEntryWindow(at('15:15:00'), row[0]), Boolean(row[3]))
    assert.equal(inTradingEntryWindow(at('15:30:00'), row[0]), false)
    assert.equal(squareOffTime(at('14:35:00'), row[0]), at(row[3] ? '15:30:00' : '15:15:00'))
  }
})

test('normal weekdays, DST closes and other weekends retain their schedules; overrides are not annual recurrences', () => {
  for (const date of ['2026-11-07', '2026-11-15', '2027-11-07']) for (const row of markets) {
    assert.equal(instrumentSession(at('14:30:00', date), row[0]).tradingDay, false)
    assert.equal(inTradingEntryWindow(at('14:30:00', date), row[0]), false)
  }
  assert.equal(instrumentSession(at('10:00:00', '2027-11-08'), 'Nifty 50').special, false)
  assert.equal(instrumentSession(at('10:00:00', '2027-11-08'), 'Nifty 50').openLabel, '09:15')
  for (const [date, close] of [['2026-11-06', '23:55'], ['2026-06-15', '23:30']]) assert.equal(mcxSession(at('10:00:00', date)).closeLabel, close)
  assert.equal(exchangeSession(NaN).tradingDay, false)
})

test('scheduled history refresh waits for real completed Muhurat bars, then refreshes through closing publication', () => {
  for (const row of markets) {
    for (const [clock, due] of [['09:30:00', false], ['14:20:00', false], ['14:25:04', false], ['14:25:05', true], ['15:30:05', true], ['15:32:01', false]]) assert.equal(historyRefreshDue('FIVE_MINUTE', row[0], at(clock)), due, `${row[0]} ${clock}`)
    assert.equal(historyRefreshDue('FIVE_MINUTE', row[0], at('14:25:05'), at('14:25:00')), false)
    assert.equal(historyRefreshDue('FIVE_MINUTE', row[0], at('14:25:05'), undefined, at('14:25:00')), false)
    const f = specialFixture(row, 1), range = historySyncRange(f.candles, 'FIVE_MINUTE', at('14:35:00'), instrumentSession(at('14:35:00'), row[0]).openMinute)
    // Fewer than 60 cached bars request older history rather than trusting a few live bars.
    assert(range.from < at('14:20:00'))
    const warm = [...f.candles.slice(0, 10).map(b => [new Date(Date.parse(b[0]) - 86400000).toISOString(), ...b.slice(1)]), ...f.candles]
    assert.equal(historySyncRange(warm, 'FIVE_MINUTE', at('14:35:00'), 860).from, at('14:20:00'))
  }
})

test('Friday history joins Sunday open and Sunday close joins Monday; missing Muhurat data cannot be skipped', () => {
  for (const row of markets) {
    const friday = instrumentSession(at('12:00:00', '2026-11-06'), row[0]), monday = instrumentSession(at('12:00:00', '2026-11-09'), row[0])
    assert(adjacentIndicatorBars(friday.close - step, at('14:20:00'), step, row[0]))
    assert(adjacentIndicatorBars(at('15:25:00'), monday.open, step, row[0]))
    assert.equal(adjacentIndicatorBars(friday.close - step, monday.open, step, row[0]), false)
    assert.equal(adjacentIndicatorBars(friday.close - 2 * step, at('14:20:00'), step, row[0]), false)
    assert.equal(adjacentIndicatorBars(friday.close - step, at('14:25:00'), step, row[0]), false)
    const f = specialFixture(row, 1)
    assert.equal(completedChartHistory(f.candles, row[0], f.now).tail.length, 52)
  }
})

test('five-minute OHLC agent confirms and enters CALL/PUT across all seven markets using prior history plus three Sunday bars', () => {
  for (const row of markets) for (const d of [1, -1]) {
    const f = specialFixture(row, d), c = contract(row), a = analyzeCandleAgent({ candles: f.candles, instrument: row[0], now: f.now, contract: c })
    assert(a.plan, `${row[0]} ${d}: ${a.reason}`)
    assert.equal(a.plan.side, d === 1 ? 'CALL' : 'PUT'); assert(validCandleConfirmation(a.plan.candleConfirmation, a.plan))
    const quote = { token: c?.token ?? (row[0] === 'Sensex' ? '99919000' : row[0] === 'Bank Nifty' ? '99926009' : '99926000'), exchangeType: c ? 5 : row[0] === 'Sensex' ? 3 : 1, ltp: a.plan.entry, timestamp: f.now + 1 }
    assert.equal(diagnoseTradeEntry(a.plan, quote, true, f.now + 1, false).state, 'ELIGIBLE QUOTE')
    const active = observePredictionTick(createPredictionRecord(a.plan), a.plan.entry, f.now + 1)
    assert.equal(active.status, 'ACTIVE')
    let raw; writePredictionHistory({ setItem: (_, value) => { raw = value } }, [active])
    assert.equal(readPredictionHistory({ getItem: () => raw })[0].status, 'ACTIVE')
    const stopped = observePredictionTick(active, a.plan.stopLoss, f.now + 2)
    assert.equal(stopped.status, 'STOP_LOSS_HIT')
  }
})

test('no forming, stale, incomplete or pre-session candle history can authorize a new Muhurat entry', () => {
  const f = specialFixture(markets[0], 1), assess = (candles, now = f.now) => analyzeCandleAgent({ candles, instrument: f.instrument, now })
  assert.equal(assess(f.candles.slice(0, -1), f.now - step).plan, undefined, 'only two current-session bars')
  assert.equal(assess(f.candles.filter((_, i) => i !== 50)).plan, undefined, 'missing second pattern bar')
  assert.equal(assess(f.candles, f.now + step).plan, undefined, 'stale close')
  assert.equal(assess(f.candles, at('14:19:59')).plan, undefined)
  const preopen = f.candles.map((b, i) => i < 49 ? b : [new Date(Date.parse(b[0]) - 15 * minute).toISOString(), ...b.slice(1)])
  assert.equal(assess(preopen, at('14:20:00')).plan, undefined, 'three pre-open bars cannot stand in for three continuous-session bars')
  assert.equal(completedChartHistory(preopen, f.instrument, at('14:20:00')).closed.length, 49)
  const forming = bar(f.now, 999999)
  assert.deepEqual(assess([...f.candles, forming]), assess(f.candles))
})

test('active Muhurat trades square off at the instrument cutoff using an observed quote on both sides', () => {
  for (const row of markets) for (const d of [1, -1]) {
    const f = specialFixture(row, d), a = analyzeCandleAgent({ candles: f.candles, instrument: row[0], now: f.now, contract: contract(row) })
    const entered = observePredictionTick(createPredictionRecord(a.plan), a.plan.entry, f.now + 1)
    const cutoff = squareOffTime(f.now, row[0]), observed = { ...entered, observedThrough: cutoff - 1000, latestPriceAt: cutoff - 1000 }
    const quote = a.plan.entry + d * 2 * (a.plan.contract?.tickSize ?? .01)
    const closed = observePredictionTick(observed, quote, cutoff + 1000)
    assert.equal(closed.status, 'EARLY_EXIT'); assert.equal(closed.earlyExitSource, 'SESSION_SQUARE_OFF')
    assert.equal(closed.exitPrice, quote); assert.equal(closed.exitAt, cutoff + 1000)
  }
})

test('live candle book aligns 5/15/60-minute Sunday candles to 14:20 and restores normal alignment Monday', () => {
  const book = new LiveCandleBook(() => [], (_token, time) => instrumentSession(time, 'Sensex').openMinute)
  const tick = (time, ltp) => ({ token: '99919000', exchangeType: 3, mode: 1, timestamp: time, ltp })
  for (const [time, ltp] of [[at('14:20:01'), 100], [at('14:25:01'), 105], [at('14:35:01'), 110]]) book.accept(tick(time, ltp), time)
  assert.deepEqual(book.get('99919000', 'FIVE_MINUTE').map(b => Date.parse(b[0])), [at('14:20:00'), at('14:25:00'), at('14:35:00')])
  assert.deepEqual(book.get('99919000', 'FIFTEEN_MINUTE').map(b => Date.parse(b[0])), [at('14:20:00'), at('14:35:00')])
  assert.equal(Date.parse(book.get('99919000', 'ONE_HOUR')[0][0]), at('14:20:00'))
  assert.equal(candleBucketTime(at('14:34:59'), 'FIFTEEN_MINUTE', 860), at('14:20:00'))
  // A delayed response cannot overwrite ticks using the wrong day's alignment.
  const merged = book.mergeHistory('99919000', 'FIFTEEN_MINUTE', [bar(at('14:20:00'), 99)], at('14:21:00'))
  assert.equal(merged[0][4], 105)
  const monday = at('09:15:01', '2026-11-09'); book.accept(tick(monday, 111), monday)
  assert.equal(Date.parse(book.get('99919000', 'ONE_HOUR').at(-1)[0]), at('09:15:00', '2026-11-09'))
})

test('opening range and complete previous-session gaps use special open/close rather than 09:15', () => {
  const sunday = Array.from({ length: 14 }, (_, i) => bar(at('14:20:00') + i * step))
  for (const row of markets) {
    assert.deepEqual(openingRange(sunday, '2026-11-08', at('14:35:00'), row[0]), { low: 99, high: 101 })
    assert.equal(openingRange(sunday, '2026-11-08', at('14:34:59'), row[0]), undefined)
    const monday = instrumentSession(at('09:30:00', '2026-11-09'), row[0])
    const gap = observedSessionGap([...sunday, bar(monday.open, 110)], row[0])
    assert.equal(gap.direction, 'UP'); assert.equal(gap.low, 101)
    assert.equal(observedSessionGap([...sunday.slice(1), bar(monday.open, 110)], row[0]), undefined)
    assert.equal(sessionReviewDue(row[0], at(row[3] ? '15:30:00' : '15:15:00')), true)
  }
})

test('server and browser calendars share spot/option special hours, and the latest session no longer skips Muhurat', async () => {
  const { indexSession, latestIndexSession } = await import('../server/indexSession.js')
  for (const segment of ['NSE', 'BSE', 'NFO', 'BFO']) {
    const client = exchangeSession(at('14:30:00'), segment), server = indexSession(at('14:30:00'), segment)
    assert.equal(client.open, server.open); assert.equal(client.close, server.close); assert.equal(server.tradingDay, true)
    assert.equal(latestIndexSession(at('14:20:59'), segment).date, '2026-11-06')
    assert.equal(latestIndexSession(at('14:21:00'), segment).date, '2026-11-08')
    assert.equal(latestIndexSession(at('09:15:00', '2026-11-09'), segment).date, '2026-11-08')
  }
})

test('ATM VWAP requests Sunday CE/PE history at 14:20, caps at derivative close, and retains it after close', async () => {
  const { createAtmVwapService } = await import('../server/atmVwap.js')
  for (const [index, strike, exchange] of [['Nifty 50', 22000, 'NFO'], ['Sensex', 74000, 'BFO'], ['Bank Nifty', 48000, 'NFO']]) {
    for (const clock of ['14:23:00', '15:45:00']) {
      const calls = [], time = at(clock), end = Math.min(time, at('15:40:00'))
      const service = createAtmVwapService({ now: () => time,
        loadOptions: async () => ({ [index]: { expiryAt: at('15:30:00', '2026-11-12'), contracts: ['ce', 'pe'].map((side, i) => ({ side, strike, exchange, token: String(i + 1), symbol: side })) } }),
        history: async (_headers, input) => { calls.push(input); return { status: 200, body: { status: true, data: Array.from({ length: (end - at('14:20:00')) / minute }, (_, i) => bar(at('14:20:00') + i * minute)) } } } })
      const result = await service.get({ index, price: strike }, { Authorization: 'Bearer fixture' })
      assert.equal(result.ce.coverage, 'FULL_SESSION'); assert(result.ce.vwap > 0); assert(result.pe.volume > 0)
      assert(calls.every(input => input.fromdate === '2026-11-08 14:20' && input.todate === `2026-11-08 ${clock === '14:23:00' ? '14:23' : '15:40'}`))
    }
  }
})
