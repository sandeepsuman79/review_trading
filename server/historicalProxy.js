import { createHash } from 'node:crypto'

/** One broker request at a time across tabs/users on this server instance. */
export function createHistoricalProxy({ fetchImpl = fetch, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), spacingMs = 1000 } = {}) {
  const cache = new Map(), pending = new Map()
  let tail = Promise.resolve(), nextAt = 0
  return function historicalRequest(url, authorization, headers, input) {
    const session = createHash('sha256').update(authorization).digest('hex')
    const key = JSON.stringify([session, url, input])
    for (const [key, value] of cache) if (value.expiresAt <= now()) cache.delete(key)
    const cached = cache.get(key)
    if (cached) return Promise.resolve(cached.result)
    if (pending.has(key)) return pending.get(key)
    const task = tail.then(async () => {
      if (nextAt > now()) await wait(nextAt - now())
      nextAt = now() + spacingMs
      let result
      try {
        const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(20_000) })
        const text = await response.text()
        let body
        try { body = JSON.parse(text) } catch { body = { status: false, message: 'Angel One returned an invalid historical response.' } }
        const retryHeader = response.headers.get('retry-after')
        const retryAfterMs = retryHeader ? Math.max(0, /^\d+(\.\d+)?$/.test(retryHeader) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - now()) : 0
        const rateLimited = response.status === 429 || /rate|too many|exceeding access|AB1021/i.test(`${body?.message} ${body?.errorcode}`)
        if (rateLimited) {
          nextAt = Math.max(nextAt, now() + Math.max(retryAfterMs || 0, 15_000))
          body = { ...body, retryAfterMs: nextAt - now() }
        }
        result = { status: response.status, body }
        if (response.ok && body?.status === true && Array.isArray(body.data) && body.data.length) {
          if (cache.size >= 200) cache.delete(cache.keys().next().value)
          cache.set(key, { result, expiresAt: now() + 30_000 })
        }
      } catch (error) {
        result = { status: 502, body: { status: false, message: error.name === 'TimeoutError' ? 'Angel One historical request timed out.' : 'Unable to connect to Angel One.' } }
      }
      return result
    })
    pending.set(key, task)
    tail = task.catch(() => {})
    void task.finally(() => pending.delete(key)).catch(() => {})
    return task
  }
}
