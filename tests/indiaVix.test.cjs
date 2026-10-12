const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename)
const { resolveIndiaVixInstrument, angelIndiaVixSnapshot } = require('../src/analysis/indiaVix.ts')
const index = { token: '99926017', symbol: 'India VIX', name: 'INDIA VIX', instrumenttype: 'AMXIDX', exch_seg: 'NSE', expiry: '' }

test('resolve India VIX from Angel One metadata, excluding derivatives, other exchanges and ambiguous tokens', () => {
  const master = [{ ...index, token: 'wrong', expiry: '27OCT2026', instrumenttype: 'FUTIDX' }, { ...index, exch_seg: 'NFO' }, index]
  assert.deepEqual(resolveIndiaVixInstrument(master), { token: '99926017', symbol: 'India VIX', exch_seg: 'NSE' })
  assert.equal(resolveIndiaVixInstrument([{ ...index, token: '99926018' }, index]), undefined)
  assert.equal(resolveIndiaVixInstrument([{ ...index, instrumenttype: '' }]), undefined)
  assert.equal(resolveIndiaVixInstrument([]), undefined)
})

test('broker LTP uses actual last price and previous close, accepting object and array responses', () => {
  const instrument = resolveIndiaVixInstrument([index]), now = Date.parse('2026-10-12T12:00:00Z')
  const row = { exchange: 'NSE', symboltoken: '99926017', ltp: '13.6', close: '14' }
  const snapshot = angelIndiaVixSnapshot({ status: true, data: row }, instrument, now)
  assert.equal(snapshot.data.price, 13.6)
  assert(Math.abs(snapshot.data.changePercent - (-.4 / 14 * 100)) < 1e-8)
  assert.equal(snapshot.data.timeBasis, 'RECEIVED', 'a broker response timestamp must not pretend to be the exchange tick time')
  assert.deepEqual(angelIndiaVixSnapshot({ status: true, data: [row] }, instrument, now), snapshot)
  assert.throws(() => angelIndiaVixSnapshot({ status: false, data: row }, instrument, now))
  assert.throws(() => angelIndiaVixSnapshot({ status: true, data: { ...row, symboltoken: '99926000' } }, instrument, now))
  assert.throws(() => angelIndiaVixSnapshot({ status: true, data: { ...row, close: '0' } }, instrument, now))
})
