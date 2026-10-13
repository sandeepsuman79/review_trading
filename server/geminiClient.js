import { createHash } from 'node:crypto'

export class AiUnavailable extends Error {
  constructor(code, message, retryAt = null) { super(message); this.code = code; this.retryAt = retryAt }
}

/** One provider queue/circuit for news and commentary; browser cancellations cannot multiply requests. */
export function createGeminiClient({ apiKey, model, fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random, savedState, saveState = () => {} }) {
  const scope = createHash('sha256').update(`${apiKey || ''}:${model}`).digest('hex')
  let state = savedState?.scope === scope ? savedState : { scope, retryAt: 0, code: 'AVAILABLE', message: '' }
  let queue = Promise.resolve(), queued = 0
  const pause = (code, message, delay) => { state = { scope, code, message, retryAt: now() + delay }; saveState(state); return new AiUnavailable(code, message, state.retryAt) }
  const status = () => !apiKey ? { state: 'UNAVAILABLE', code: 'NOT_CONFIGURED', message: 'Gemini is not configured. Technical evaluation continues.', retryAt: null }
    : state.retryAt > now() ? { state: 'COOLDOWN', code: state.code, message: state.message, retryAt: new Date(state.retryAt).toISOString() }
      : { state: 'AVAILABLE', code: 'AVAILABLE', message: '', retryAt: null }
  async function run(body) {
    const current = status()
    if (current.state !== 'AVAILABLE') throw new AiUnavailable(current.code, current.message, current.retryAt ? Date.parse(current.retryAt) : null)
    for (let attempt = 0; attempt < 2; attempt++) {
      let response, data
      try {
        response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(15_000), body: JSON.stringify(body),
        })
        data = await response.json().catch(() => ({}))
      } catch {
        if (!attempt) { await sleep(1000 + random() * 500); continue }
        throw pause('NETWORK', 'AI commentary is temporarily unavailable. Technical evaluation continues.', 2 * 60_000)
      }
      if (response.ok) {
        try {
          const result = JSON.parse(data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '')
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('format')
          state = { scope, retryAt: 0, code: 'AVAILABLE', message: '' }; saveState(state)
          return result
        } catch { throw pause('INVALID_RESPONSE', 'AI returned an unusable assessment. Technical evaluation continues.', 2 * 60_000) }
      }
      const retryHeader = response.headers?.get('retry-after')
      const retryInfo = data.error?.details?.find(item => String(item['@type']).endsWith('RetryInfo'))?.retryDelay
      const headerDelay = retryHeader && Number.isFinite(Number(retryHeader)) ? Number(retryHeader) * 1000 : Date.parse(retryHeader || '') - now()
      const retryDelay = Math.max(Number.isFinite(headerDelay) ? headerDelay : 0, /^\d+(?:\.\d+)?s$/.test(retryInfo || '') ? parseFloat(retryInfo) * 1000 : 0)
      if (response.status === 429) throw pause('QUOTA', 'Gemini quota reached. Cached news and local technical evaluation remain available.', Math.min(24 * 3600_000, Math.max(30 * 60_000, retryDelay)))
      if ([400, 401, 402, 403, 404].includes(response.status)) throw pause('CONFIGURATION', 'Gemini configuration or billing needs attention. Technical evaluation continues.', 15 * 60_000)
      if (!attempt && [408, 500, 502, 503, 504].includes(response.status)) { await sleep(1000 + random() * 500); continue }
      throw pause('BUSY', 'Gemini is temporarily busy. Cached news and local technical evaluation remain available.', Math.min(24 * 3600_000, Math.max(2 * 60_000, retryDelay)))
    }
  }
  function generate(body) {
    if (queued >= 12) return Promise.reject(new AiUnavailable('BUSY', 'AI requests are already queued. Technical evaluation continues.', now() + 60_000))
    queued++
    const result = queue.then(() => run(body)).finally(() => { queued-- })
    queue = result.catch(() => {})
    return result
  }
  return { generate, status, model }
}
