import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHistoricalProxy } from '../server/historicalProxy.js'

test('broker calls are serial, deduplicated, spaced and isolated by session and exact minute range', async () => {
  let clock = 0, calls = 0, inFlight = 0, maximum = 0
  const startTimes = []
  const request = createHistoricalProxy({ now: () => clock, wait: async ms => { clock += ms }, fetchImpl: async () => {
    calls++; maximum = Math.max(maximum, ++inFlight); startTimes.push(clock)
    await new Promise(resolve => setImmediate(resolve)); inFlight--
    return Response.json({ status: true, data: [[calls]] })
  } })
  const input = { fromdate: '2026-10-14 09:15', todate: '2026-10-14 10:00' }
  const first = request('url', 'Bearer a', {}, input)
  assert.equal(request('url', 'Bearer a', {}, input), first)
  await Promise.all([first, request('url', 'Bearer b', {}, input), request('url', 'Bearer a', {}, { ...input, todate: '2026-10-14 10:01' })])
  assert.equal(calls, 3); assert.equal(maximum, 1); assert.deepEqual(startTimes, [0, 1000, 2000])
  await request('url', 'Bearer a', {}, input); assert.equal(calls, 3)
  clock = 40000; await request('url', 'Bearer a', {}, input); assert.equal(calls, 4)
})

test('rate-limit HTTP 200 pauses the whole queue and failures/empty responses are never cached', async () => {
  let clock = 0, calls = 0
  const request = createHistoricalProxy({ now: () => clock, wait: async ms => { clock += ms }, fetchImpl: async () => {
    calls++
    return calls === 1 ? Response.json({ status: false, errorcode: 'AB1021', message: 'Too many requests' }, { headers: { 'Retry-After': '45' } }) : Response.json({ status: true, data: [] })
  } })
  const failure = await request('url', 'Bearer a', {}, {})
  assert.equal(failure.body.retryAfterMs, 45000)
  await request('url', 'Bearer a', {}, {}); assert.equal(clock, 45000)
  await request('url', 'Bearer a', {}, {}); assert.equal(calls, 3)
})

test('network failures do not break later queued requests', async () => {
  let calls = 0
  const request = createHistoricalProxy({ spacingMs: 0, fetchImpl: async () => {
    if (++calls === 1) throw new Error('network failure')
    return Response.json({ status: true, data: [[1]] })
  } })
  assert.equal((await request('url', 'Bearer a', {}, {})).status, 502)
  assert.equal((await request('url', 'Bearer a', {}, {})).body.status, true)
})


test('plain-text broker rate limits pause the queue and retry without losing the throttle message', async () => {
  let clock = 0, calls = 0
  const request = createHistoricalProxy({ now: () => clock, wait: async ms => { clock += ms }, fetchImpl: async () => {
    calls++
    return calls === 1 ? new Response('Access denied because of exceeding access rate', { status: 429 }) : Response.json({ status: true, data: [[1]] })
  } })
  const result = await request('url', 'Bearer a', {}, {})
  assert.equal(result.body.status, true)
  assert.equal(calls, 2)
  assert.equal(clock, 15000)
})

test('temporary HTML responses retry once and persistent invalid JSON returns a gateway error', async () => {
  for (const recover of [true, false]) {
    let clock = 0, calls = 0
    const request = createHistoricalProxy({ now: () => clock, wait: async ms => { clock += ms }, fetchImpl: async () => {
      calls++
      return recover && calls === 2 ? Response.json({ status: true, data: [[1]] }) : new Response('<html>Service unavailable</html>')
    } })
    const result = await request('url', 'Bearer a', {}, {})
    assert.equal(calls, 2)
    assert.equal(result.status, recover ? 200 : 502)
    assert.equal(result.body.status, recover)
  }
})

test('non-JSON authentication failures are not retried or relabelled as temporary failures', async () => {
  let calls = 0
  const request = createHistoricalProxy({ fetchImpl: async () => { calls++; return new Response('Unauthorized', { status: 401 }) } })
  const result = await request('url', 'Bearer a', {}, {})
  assert.equal(result.status, 401)
  assert.equal(calls, 1)
})
