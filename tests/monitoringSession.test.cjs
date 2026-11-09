const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename)
const { monitoringTokenTimes, monitoringWindow, canMonitorInstrument, validMonitoringAuth, monitoringReconnectDelay } = require('../src/analysis/monitoringSession.ts')
const { inTradingEntryWindow } = require('../src/analysis/tradingSession.ts')
const time = (clock, day = '2026-11-05') => Date.parse(`${day}T${clock}+05:30`)
const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
const access = (expiry = time('23:59:59'), startedAt = time('08:30:00')) => ({ token: jwt({ exp: expiry / 1000, iat: startedAt / 1000 }), startedAt })
const markets = ['Nifty 50', 'Sensex', 'Bank Nifty', 'Natural Gas', 'Crude Oil', 'Silver', 'Gold']

test('transient disconnect recovery backs off and remains bounded after repeated failures', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 99, 10000].map(monitoringReconnectDelay), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
})

test('JWT schedule tolerates base64url padding and rejects unknown or malformed expiry', () => {
  const a = access()
  assert.equal(monitoringTokenTimes(a.token).expiresAt, time('23:59:59'))
  for (const token of ['opaque', 'h.invalid.s', jwt({ exp: 'tomorrow' }), jwt({ exp: null }), jwt({})]) {
    assert.equal(validMonitoringAuth({ ...a, token }, time('10:00:00')), false)
    assert.equal(monitoringWindow({ ...a, token }, time('10:00:00')).phase, 'INVALID')
  }
})
test('early login arms monitoring; MCX starts at nine and all indices at 09:15', () => {
  const a = access()
  assert.equal(monitoringWindow(a, time('08:45:00')).phase, 'WAITING')
  assert.equal(monitoringWindow(a, time('08:45:00')).nextAt, time('09:00:00'))
  for (const market of markets) {
    assert.equal(canMonitorInstrument(a, time('08:59:59'), market), false)
    assert.equal(canMonitorInstrument(a, time('09:00:00'), market), markets.indexOf(market) >= 3)
    assert.equal(canMonitorInstrument(a, time('09:15:00'), market), true)
  }
})
test('existing 15:15 index entry cutoff is preserved while protection observes closing quotes', () => {
  const a = access()
  for (const market of markets.slice(0, 3)) {
    assert.equal(inTradingEntryWindow(time('15:15:00'), market), false)
    assert.equal(canMonitorInstrument(a, time('15:29:59'), market), true)
    assert.equal(canMonitorInstrument(a, time('15:30:00'), market, false), false)
    assert.equal(canMonitorInstrument(a, time('15:30:29'), market), true)
    assert.equal(canMonitorInstrument(a, time('15:30:30'), market), false)
  }
  assert.equal(canMonitorInstrument(a, time('15:30:30'), 'Crude Oil'), true)
})
test('MCX close follows existing winter/summer schedule with bounded final quote settlement', () => {
  for (const [day, close] of [['2026-11-05', '23:55:00'], ['2026-06-15', '23:30:00']]) {
    const end = time(close, day), a = access(time('23:59:59', day), time('09:00:00', day))
    assert.equal(monitoringWindow(a, end - 1).phase, 'RUNNING')
    assert.equal(monitoringWindow(a, end).phase, 'SETTLING')
    for (const market of markets.slice(3)) {
      assert.equal(canMonitorInstrument(a, end, market, false), false)
      assert.equal(canMonitorInstrument(a, end + 29999, market), true)
      assert.equal(canMonitorInstrument(a, end + 30000, market), false)
    }
    assert.equal(monitoringWindow(a, end + 30000).phase, 'CLOSED')
  }
})
test('expiry is a hard deadline even during settlement or before market opening', () => {
  for (const expiry of [time('08:50:00'), time('10:00:00'), time('23:55:10')]) {
    const a = access(expiry)
    assert.equal(monitoringWindow(a, expiry).phase, 'EXPIRED')
    assert.equal(monitoringWindow(a, expiry).stopsAt, Math.min(expiry, time('23:55:00')))
    assert.equal(validMonitoringAuth(a, expiry), false)
    for (const market of markets) assert.equal(canMonitorInstrument(a, expiry, market), false)
  }
  const a = access(time('08:50:00'))
  assert.equal(monitoringWindow(a, time('08:45:00')).nextAt, time('08:50:00'))
})
test('logout and broker rejection immediately disable every instrument', () => {
  const a = { ...access(), blocked: true }
  assert.equal(monitoringWindow(undefined, time('10:00:00')).phase, 'SIGNED_OUT')
  assert.equal(monitoringWindow(a, time('10:00:00')).phase, 'INVALID')
  for (const market of markets) {
    assert.equal(canMonitorInstrument(undefined, time('10:00:00'), market), false)
    assert.equal(canMonitorInstrument(a, time('10:00:00'), market), false)
  }
})
test('a saved session cannot restart the next day or monitor on weekends', () => {
  for (const day of ['2026-11-06', '2026-11-07']) {
    const a = access(time('23:59:59', day))
    assert.equal(monitoringWindow(a, time('10:00:00', day)).phase, 'CLOSED')
    for (const market of markets) assert.equal(canMonitorInstrument(a, time('10:00:00', day), market), false)
  }
  const saturday = access(time('23:59:59', '2026-11-07'), time('09:00:00', '2026-11-07'))
  assert.equal(monitoringWindow(saturday, time('10:00:00', '2026-11-07')).phase, 'CLOSED')
})
