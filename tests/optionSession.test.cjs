const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8').replace(/import\.meta\.env\.VITE_ANGELONE_API_KEY/g, '"fixture"'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename)
const { getOptionPremiums } = require('../src/api/optionPremiums.ts')
const { recoverAngelOneSession, AngelOneSessionExpiredError } = require('../src/api/angelOneSession.ts')
const { getAngelOneProfile } = require('../src/api/angelOne.ts')
const original = { fetch: global.fetch, localStorage: global.localStorage, window: global.window, CustomEvent: global.CustomEvent }
let events
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const snapshot = strikes => ({ index: 'Nifty 50', expiry: '2026-10-15', fetchedAt: '2026-10-14T05:00:00Z', timeBasis: 'RECEIVED', rows: strikes.map(strike => ({ strike, ce: { ltp: 111.25 }, pe: { ltp: 222.5 } })) })
const renewed = () => reply({ status: true, data: { jwtToken: 'new-jwt', refreshToken: 'new-refresh', feedToken: 'new-feed' } })
const quotes = (token = 'old-jwt', signal = new AbortController().signal, strikes = [22000]) => getOptionPremiums('Nifty 50', strikes, token, signal)
beforeEach(() => {
  const data = new Map([['angelone_jwt_token', 'old-jwt'], ['angelone_refresh_token', 'old-refresh'], ['saved_candles', 'keep']])
  global.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
  events = []; global.window = { dispatchEvent: event => events.push(event) }
  global.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail } }
})
afterEach(() => Object.assign(global, original))

test('HTTP 200 camel-case authentication error refreshes all session tokens and retries rupee quotes once', async () => {
  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/refresh')) { assert.deepEqual(JSON.parse(options.body), { refreshToken: 'old-refresh' }); return renewed() }
    return options.headers.Authorization === 'Bearer old-jwt' ? reply({ success: false, errorCode: 'AG8001', message: 'Invalid Token' }) : reply(snapshot([22000]))
  }
  assert.equal((await quotes()).rows[0].ce.ltp, 111.25)
  assert.equal(calls.length, 3); assert.equal(calls[2].options.headers.Authorization, 'Bearer new-jwt')
  assert.equal(localStorage.getItem('angelone_refresh_token'), 'new-refresh'); assert.equal(localStorage.getItem('angelone_feed_token'), 'new-feed')
  assert.equal(localStorage.getItem('saved_candles'), 'keep'); assert.equal(events.length, 1); assert.equal(events[0].detail.reason, 'token-refresh')
})

test('parallel quote requests and profile recovery share one token refresh', async () => {
  let refreshes = 0, release
  const wait = new Promise(resolve => { release = resolve })
  global.fetch = async (url, options) => {
    if (url.endsWith('/refresh')) { refreshes++; await wait; return renewed() }
    return options.headers.Authorization === 'Bearer old-jwt' ? reply({ errorcode: 'AG8002', message: 'Token Expired' }, 401) : reply(snapshot(JSON.parse(options.body).strikes))
  }
  const first = quotes(), second = quotes('old-jwt', undefined, [22050]), profile = recoverAngelOneSession('old-jwt')
  await new Promise(resolve => setImmediate(resolve)); release()
  const [a, b, token] = await Promise.all([first, second, profile])
  assert.equal(refreshes, 1); assert.equal(events.length, 1); assert.equal(token, 'new-jwt'); assert.equal(a.rows[0].strike, 22000); assert.equal(b.rows[0].strike, 22050)
})

test('a freshly rejected JWT stops after one retry without a refresh loop', async () => {
  let attempts = 0, refreshes = 0
  global.fetch = async url => { if (url.endsWith('/refresh')) { refreshes++; return renewed() } attempts++; return reply({ errorcode: 'AG8001', message: 'Invalid Token' }, 401) }
  await assert.rejects(quotes(), AngelOneSessionExpiredError)
  assert.equal(attempts, 2); assert.equal(refreshes, 1)
})

test('expired refresh token or absent refresh token gives a sign-in message', async () => {
  let refreshes = 0
  global.fetch = async url => { if (url.endsWith('/refresh')) { refreshes++; return reply({ status: false, errorCode: 'AB8051', message: 'Refresh Token Expired' }) } return reply({ message: 'Invalid Token' }, 401) }
  await assert.rejects(quotes(), AngelOneSessionExpiredError)
  localStorage.removeItem('angelone_refresh_token')
  await assert.rejects(quotes(), /Please sign in again/)
  assert.equal(refreshes, 1)
})

test('rate limits, permission failures and broker outages never rotate authentication', async () => {
  for (const status of [429, 403, 502]) {
    let calls = 0
    global.fetch = async url => { calls++; assert(!url.endsWith('/refresh')); return reply({ message: 'Provider unavailable' }, status) }
    await assert.rejects(quotes(), /Provider unavailable/); assert.equal(calls, 1)
  }
})

test('an already rotated JWT is reused instead of refreshing again', async () => {
  localStorage.setItem('angelone_jwt_token', 'other-jwt')
  let calls = 0
  global.fetch = async (url, options) => { calls++; assert(!url.endsWith('/refresh')); return options.headers.Authorization === 'Bearer old-jwt' ? reply({ message: 'Invalid Token' }, 401) : reply(snapshot([22000])) }
  assert.equal((await quotes()).rows[0].pe.ltp, 222.5); assert.equal(calls, 2)
})

test('logout or a new login during refresh cannot be overwritten by the old response', async () => {
  global.fetch = async () => { localStorage.removeItem('angelone_jwt_token'); localStorage.removeItem('angelone_refresh_token'); return renewed() }
  await assert.rejects(recoverAngelOneSession('old-jwt'), AngelOneSessionExpiredError)
  assert.equal(localStorage.getItem('angelone_jwt_token'), null); assert.equal(events.length, 0)
  localStorage.setItem('angelone_jwt_token', 'old-jwt'); localStorage.setItem('angelone_refresh_token', 'old-refresh')
  global.fetch = async () => { localStorage.setItem('angelone_jwt_token', 'other-account'); localStorage.setItem('angelone_refresh_token', 'other-refresh'); return renewed() }
  assert.equal(await recoverAngelOneSession('old-jwt'), 'other-account'); assert.equal(localStorage.getItem('angelone_refresh_token'), 'other-refresh'); assert.equal(events.length, 0)
})

test('aborting a quote during shared refresh prevents its quote retry', async () => {
  const controller = new AbortController(); let quotesSent = 0
  global.fetch = async url => { if (url.endsWith('/refresh')) { controller.abort(); return renewed() } quotesSent++; return reply({ message: 'Invalid Token' }, 401) }
  await assert.rejects(quotes('old-jwt', controller.signal), { name: 'AbortError' }); assert.equal(quotesSent, 1)
})

test('temporary refresh failure preserves tokens and can recover on a later request', async () => {
  global.fetch = async url => url.endsWith('/refresh') ? reply({ message: 'High demand' }, 503) : reply({ errorcode: 'AG8002' }, 401)
  await assert.rejects(quotes(), /temporarily unavailable/); assert.equal(localStorage.getItem('angelone_jwt_token'), 'old-jwt')
  global.fetch = async (url, options) => url.endsWith('/refresh') ? renewed() : options.headers.Authorization === 'Bearer old-jwt' ? reply({ errorcode: 'AG8002' }, 401) : reply(snapshot([22000]))
  assert.equal((await quotes()).rows[0].ce.ltp, 111.25)
})


test('profile also recognises HTTP-200 expired sessions and retains HTTP failure metadata', async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: false, errorCode: 'AG8002', message: 'Authentication rejected' }) })
  await assert.rejects(getAngelOneProfile('old-jwt'), error => error.status === 401)
  global.fetch = async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ message: 'Provider down' }) })
  await assert.rejects(getAngelOneProfile('old-jwt'), error => error.status === 503 && error.message === 'Provider down')
})
