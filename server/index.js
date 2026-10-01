import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}

const port = Number(process.env.PORT || 3001)
const angelOneUrl = 'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword'
const angelOneRefreshUrl = 'https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens'
const angelOneProfileUrl = 'https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getProfile'
const angelOneRmsUrl = 'https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getRMS'
const angelOneLogoutUrl = 'https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/logout'
const angelOneGttUrls = {
  create: 'https://apiconnect.angelone.in/rest/secure/angelbroking/gtt/v1/createRule',
  modify: 'https://apiconnect.angelone.in/rest/secure/angelbroking/gtt/v1/modifyRule',
  cancel: 'https://apiconnect.angelone.in/rest/secure/angelbroking/gtt/v1/cancelRule',
  details: 'https://apiconnect.angelone.in/rest/secure/angelbroking/gtt/v1/ruleDetails',
  list: 'https://apiconnect.angelone.in/rest/secure/angelbroking/gtt/v1/ruleList',
}
const instrumentMasterUrl = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json'
const angelOneLtpUrl = 'https://apiconnect.angelone.in/order-service/rest/secure/angelbroking/order/v1/getLtpData'
const angelOneHistoricalUrls = {
  candles: 'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
  oi: 'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getOIData',
}
const historicalResponseCache = new Map()
const historicalCacheTtlMs = 30_000
const geminiApiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/models'
const ohlcIntervals = {
  FIVE_MINUTE: 5 * 60_000,
  FIFTEEN_MINUTE: 15 * 60_000,
  ONE_HOUR: 60 * 60_000,
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  })
  response.end(JSON.stringify(body))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 10_000) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    })
    response.end()
    return
  }

  if (request.method === 'GET' && request.url === '/api/instruments') {
    try {
      const instrumentResponse = await fetch(instrumentMasterUrl)
      const text = await instrumentResponse.text()
      let body
      try { body = JSON.parse(text) } catch { body = { message: 'Instrument master returned invalid JSON.' } }
      sendJson(response, instrumentResponse.status, body)
    } catch {
      sendJson(response, 502, { message: 'Unable to fetch instrument master.' })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/ai/price-action') {
    try {
      const input = JSON.parse(await readBody(request))
      const apiKey = process.env.GEMINI_API_KEY
      if (!apiKey) {
        return sendJson(response, 503, { message: 'Gemini AI is not configured. Add GEMINI_API_KEY to the backend .env file and restart the server.' })
      }
      const intervalMs = ohlcIntervals[input?.interval]
      if (!intervalMs || !Array.isArray(input?.candles)) {
        return sendJson(response, 400, { message: 'A supported interval and candle array are required.' })
      }

      const completedCandles = input.candles
        .filter((candle) => Array.isArray(candle) && candle.length >= 5)
        .map((candle) => ({
          time: new Date(candle[0]).getTime(),
          open: Number(candle[1]),
          high: Number(candle[2]),
          low: Number(candle[3]),
          close: Number(candle[4]),
        }))
        .filter((candle) =>
          Number.isFinite(candle.time)
          && Number.isFinite(candle.open)
          && Number.isFinite(candle.high)
          && Number.isFinite(candle.low)
          && Number.isFinite(candle.close)
          && candle.high >= Math.max(candle.open, candle.close)
          && candle.low <= Math.min(candle.open, candle.close)
          && candle.high >= candle.low
          && candle.time + intervalMs <= Date.now(),
        )
        .sort((a, b) => a.time - b.time)
        .slice(-40)

      if (completedCandles.length < 15) {
        return sendJson(response, 400, { message: 'At least 15 valid completed candles are needed for AI analysis.' })
      }

      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'
      const rules = input.rules && typeof input.rules === 'object' ? input.rules : {}
      const promptData = {
        instrument: typeof input.instrument === 'string' ? input.instrument.slice(0, 40) : 'Unknown instrument',
        interval: input.interval,
        candles: completedCandles.map((candle) => ({
          time: new Date(candle.time).toISOString(),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
        ruleBasedContext: {
          decision: ['CALL', 'PUT', 'WAIT'].includes(rules.decision) ? rules.decision : 'WAIT',
          phase: typeof rules.phase === 'string' ? rules.phase.slice(0, 40) : 'UNKNOWN',
          structure: typeof rules.structure === 'string' ? rules.structure.slice(0, 100) : '',
          support: Number.isFinite(rules.support) ? rules.support : null,
          resistance: Number.isFinite(rules.resistance) ? rules.resistance : null,
          bullishScore: Number.isFinite(rules.bullishScore) ? rules.bullishScore : null,
          bearishScore: Number.isFinite(rules.bearishScore) ? rules.bearishScore : null,
        },
      }

      const geminiResponse = await fetch(`${geminiApiBaseUrl}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: 'You are a cautious OHLC-only price-action analyst. Analyze only the supplied completed candles and rule-based context. Do not invent levels or prices. Do not claim calibrated probabilities or provide entry, target, stop-loss, or options advice. If evidence conflicts or is weak, use WAIT. Treat rule-based context as evidence, not certainty. This is an experimental second opinion and never overrides deterministic trade filters.' }],
          },
          contents: [{ parts: [{ text: JSON.stringify(promptData) }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                bias: { type: 'STRING', enum: ['CALL', 'PUT', 'WAIT'] },
                stage: { type: 'STRING', enum: ['EARLY', 'TRIGGER', 'CONFIRMED', 'NEUTRAL'] },
                summary: { type: 'STRING' },
                bullishEvidence: { type: 'ARRAY', items: { type: 'STRING' } },
                bearishEvidence: { type: 'ARRAY', items: { type: 'STRING' } },
                confirmation: { type: 'STRING' },
                invalidation: { type: 'STRING' },
                caveat: { type: 'STRING' },
              },
              required: ['bias', 'stage', 'summary', 'bullishEvidence', 'bearishEvidence', 'confirmation', 'invalidation', 'caveat'],
            },
          },
        }),
      })

      const responseBody = await geminiResponse.json().catch(() => ({}))
      if (!geminiResponse.ok) {
        const detail = typeof responseBody.error?.message === 'string'
          ? responseBody.error.message.slice(0, 180)
          : `HTTP ${geminiResponse.status}`
        const status = geminiResponse.status === 429 ? 429 : geminiResponse.status === 400 ? 400 : 502
        return sendJson(response, status, { message: `Gemini API request failed: ${detail}` })
      }

      let result
      try {
        const text = responseBody.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || ''
        result = JSON.parse(text)
      } catch {
        return sendJson(response, 502, { message: 'Gemini returned an invalid structured response. Try again.' })
      }
      if (!['CALL', 'PUT', 'WAIT'].includes(result.bias) || !['EARLY', 'TRIGGER', 'CONFIRMED', 'NEUTRAL'].includes(result.stage)) {
        return sendJson(response, 502, { message: 'The Gemini response did not match the expected analysis format.' })
      }

      const safeText = (value, maxLength = 240) => typeof value === 'string' ? value.slice(0, maxLength) : ''
      const safeList = (value) => Array.isArray(value) ? value.slice(0, 3).map((item) => safeText(item, 120)).filter(Boolean) : []
      return sendJson(response, 200, {
        model,
        bias: result.bias,
        stage: result.stage,
        summary: safeText(result.summary),
        bullishEvidence: safeList(result.bullishEvidence),
        bearishEvidence: safeList(result.bearishEvidence),
        confirmation: safeText(result.confirmation),
        invalidation: safeText(result.invalidation),
        caveat: safeText(result.caveat),
        analyzedCandles: completedCandles.length,
        asOf: new Date(completedCandles[completedCandles.length - 1].time).toISOString(),
      })
    } catch (error) {
      const message = error instanceof SyntaxError
        ? 'Request body must be valid JSON.'
        : error.name === 'TimeoutError' || error.name === 'AbortError'
          ? 'Gemini AI analysis timed out. Try again.'
          : 'Unable to connect to the Gemini API. Check the network and backend configuration.'
      return sendJson(response, error instanceof SyntaxError ? 400 : 502, { message })
    }
  }

  if (request.method === 'POST' && request.url === '/api/angelone/ltp') {
    const authorization = request.headers.authorization
    const privateKey = process.env.ANGELONE_PRIVATE_KEY
    if (!authorization?.startsWith('Bearer ')) return sendJson(response, 401, { message: 'Angel One authorization token is required.' })
    if (!privateKey) return sendJson(response, 503, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
    try {
      const input = JSON.parse(await readBody(request))
      if (!input?.exchange || !input?.tradingsymbol || !input?.symboltoken) return sendJson(response, 400, { message: 'exchange, tradingsymbol, and symboltoken are required.' })
      const angelResponse = await fetch(angelOneLtpUrl, {
        method: 'POST',
        headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', 'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '', 'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '', 'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '', 'X-PrivateKey': privateKey, 'X-SourceID': 'WEB', 'X-UserType': 'USER' },
        body: JSON.stringify(input),
      })
      const text = await angelResponse.text()
      let body
      try { body = JSON.parse(text) } catch { body = { message: text || 'Angel One returned an invalid response.' } }
      sendJson(response, angelResponse.status, body)
    } catch (error) {
      sendJson(response, error instanceof SyntaxError ? 400 : 502, { message: error instanceof SyntaxError ? 'Request body must be valid JSON.' : 'Unable to connect to Angel One.' })
    }

    return
  }

  if (request.method === 'POST' && request.url?.startsWith('/api/angelone/historical/')) {
    const action = request.url.split('/').pop()
    const authorization = request.headers.authorization
    const privateKey = process.env.ANGELONE_PRIVATE_KEY
    if (!angelOneHistoricalUrls[action]) return sendJson(response, 404, { message: 'Unknown historical operation.' })
    if (!authorization?.startsWith('Bearer ')) return sendJson(response, 401, { message: 'Angel One authorization token is required.' })
    if (!privateKey) return sendJson(response, 503, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
    try {
      const input = JSON.parse(await readBody(request))
      const required = ['exchange', 'symboltoken', 'interval', 'fromdate', 'todate']
      if (!input || required.some((key) => typeof input[key] !== 'string' || !input[key].trim())) {
        return sendJson(response, 400, { message: 'exchange, symboltoken, interval, fromdate, and todate are required.' })
      }
      const cacheKey = JSON.stringify([
        action,
        input.exchange,
        input.symboltoken,
        input.interval,
        input.fromdate.slice(0, 10),
        input.todate.slice(0, 10),
      ])
      const cached = historicalResponseCache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        return sendJson(response, 200, cached.body)
      }
      if (cached) historicalResponseCache.delete(cacheKey)

      const angelResponse = await fetch(angelOneHistoricalUrls[action], {
        method: 'POST',
        headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', 'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '', 'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '', 'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '', 'X-PrivateKey': privateKey, 'X-SourceID': 'WEB', 'X-UserType': 'USER' },
        body: JSON.stringify(input),
      })
      const text = await angelResponse.text()
      let body
      try { body = JSON.parse(text) } catch { body = { message: text || 'Angel One returned an invalid response.' } }
      if (angelResponse.ok && body?.status === true && Array.isArray(body.data)) {
        historicalResponseCache.set(cacheKey, { body, expiresAt: Date.now() + historicalCacheTtlMs })
      }
      sendJson(response, angelResponse.status, body)
    } catch (error) {
      sendJson(response, error instanceof SyntaxError ? 400 : 502, { message: error instanceof SyntaxError ? 'Request body must be valid JSON.' : 'Unable to connect to Angel One.' })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/angelone/refresh') {
    const authorization = request.headers.authorization
    const privateKey = process.env.ANGELONE_PRIVATE_KEY
    if (!authorization?.startsWith('Bearer ')) {
      sendJson(response, 401, { message: 'Angel One authorization token is required.' })
      return
    }
    if (!privateKey) {
      sendJson(response, 503, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
      return
    }

    if (request.method === 'POST' && request.url === '/api/angelone/logout') {
      const authorization = request.headers.authorization
      const privateKey = process.env.ANGELONE_PRIVATE_KEY
      if (!authorization?.startsWith('Bearer ')) return sendJson(response, 401, { message: 'Angel One authorization token is required.' })
      if (!privateKey) return sendJson(response, 503, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
      try {
        const input = JSON.parse(await readBody(request))
        if (typeof input?.clientcode !== 'string' || !input.clientcode.trim()) return sendJson(response, 400, { message: 'clientcode is required.' })
        const angelResponse = await fetch(angelOneLogoutUrl, { method: 'POST', headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', 'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '', 'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '', 'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '', 'X-PrivateKey': privateKey, 'X-SourceID': 'WEB', 'X-UserType': 'USER' }, body: JSON.stringify({ clientcode: input.clientcode.trim() }) })
        const text = await angelResponse.text()
        let body
        try { body = JSON.parse(text) } catch { body = { message: text || 'Angel One returned an invalid response.' } }
        sendJson(response, angelResponse.status, body)
      } catch (error) {
        sendJson(response, error instanceof SyntaxError ? 400 : 502, { message: error instanceof SyntaxError ? 'Request body must be valid JSON.' : 'Unable to connect to Angel One.' })
      }
      return
    }

    if (request.method === 'POST' && request.url?.startsWith('/api/angelone/gtt/')) {
      const action = request.url.split('/').pop()
      const authorization = request.headers.authorization
      const privateKey = process.env.ANGELONE_PRIVATE_KEY
      if (!angelOneGttUrls[action]) return sendJson(response, 404, { message: 'Unknown GTT operation.' })
      if (!authorization?.startsWith('Bearer ')) return sendJson(response, 401, { message: 'Angel One authorization token is required.' })
      if (!privateKey) return sendJson(response, 503, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
      try {
        const input = JSON.parse(await readBody(request))
        if (!input || typeof input !== 'object' || Array.isArray(input)) return sendJson(response, 400, { message: 'GTT request must be a JSON object.' })
        if (action === 'create' && (!['NSE', 'BSE'].includes(input.exchange) || !['DELIVERY', 'MARGIN'].includes(input.producttype))) return sendJson(response, 400, { message: 'GTT supports only NSE/BSE and DELIVERY/MARGIN.' })
        const angelResponse = await fetch(angelOneGttUrls[action], { method: 'POST', headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', 'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '', 'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '', 'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '', 'X-PrivateKey': privateKey, 'X-SourceID': 'WEB', 'X-UserType': 'USER' }, body: JSON.stringify(input) })
        const text = await angelResponse.text()
        let body
        try { body = JSON.parse(text) } catch { body = { message: text || 'Angel One returned an invalid response.' } }
        sendJson(response, angelResponse.status, body)
      } catch (error) {
        sendJson(response, error instanceof SyntaxError ? 400 : 502, { message: error instanceof SyntaxError ? 'Request body must be valid JSON.' : 'Unable to connect to Angel One.' })
      }
      return
    }

    if (request.method === 'POST' && request.url === '/api/angelone/logout') {
      const authorization = request.headers.authorization
      const privateKey = process.env.ANGELONE_PRIVATE_KEY
      if (!authorization?.startsWith('Bearer ')) {
        sendJson(response, 401, { message: 'Angel One authorization token is required.' })
        return
      }
      if (!privateKey) {
        sendJson(response, 503, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
        return
      }
      try {
        const input = JSON.parse(await readBody(request))
        if (typeof input?.clientcode !== 'string' || !input.clientcode.trim()) {
          sendJson(response, 400, { message: 'clientcode is required.' })
          return
        }
        const angelResponse = await fetch(angelOneLogoutUrl, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '',
            'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '',
            'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '',
            'X-PrivateKey': privateKey,
            'X-SourceID': 'WEB',
            'X-UserType': 'USER',
          },
          body: JSON.stringify({ clientcode: input.clientcode.trim() }),
        })
        const responseText = await angelResponse.text()
        let responseBody
        try {
          responseBody = JSON.parse(responseText)
        } catch {
          responseBody = { message: responseText || 'Angel One returned an invalid response.' }
        }
        sendJson(response, angelResponse.status, responseBody)
      } catch (error) {
        sendJson(response, error instanceof SyntaxError ? 400 : 502, {
          message: error instanceof SyntaxError ? 'Request body must be valid JSON.' : 'Unable to connect to Angel One.',
        })
      }
      return
    }

    try {
      const input = JSON.parse(await readBody(request))
      if (typeof input?.refreshToken !== 'string' || !input.refreshToken.trim()) {
        sendJson(response, 400, { message: 'refreshToken is required.' })
        return
      }
      const angelResponse = await fetch(angelOneRefreshUrl, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '',
          'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '',
          'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '',
          'X-PrivateKey': privateKey,
          'X-SourceID': 'WEB',
          'X-UserType': 'USER',
        },
        body: JSON.stringify({ refreshToken: input.refreshToken.trim() }),
      })
      const responseText = await angelResponse.text()
      let responseBody
      try {
        responseBody = JSON.parse(responseText)
      } catch {
        responseBody = { message: responseText || 'Angel One returned an invalid response.' }
      }
      sendJson(response, angelResponse.status, responseBody)
    } catch (error) {
      sendJson(response, error instanceof SyntaxError ? 400 : 502, {
        message: error instanceof SyntaxError ? 'Request body must be valid JSON.' : 'Unable to connect to Angel One.',
      })
    }
    return
  }

  if (request.method === 'GET' && (request.url === '/api/angelone/profile' || request.url === '/api/angelone/rms')) {
    const authorization = request.headers.authorization
    const privateKey = process.env.ANGELONE_PRIVATE_KEY
    if (!authorization?.startsWith('Bearer ')) {
      sendJson(response, 401, { message: 'Angel One authorization token is required.' })
      return
    }
    if (!privateKey) {
      sendJson(response, 503, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
      return
    }

    try {
      const angelResponse = await fetch(request.url === '/api/angelone/rms' ? angelOneRmsUrl : angelOneProfileUrl, {
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '',
          'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '',
          'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '',
          'X-PrivateKey': privateKey,
          'X-SourceID': 'WEB',
          'X-UserType': 'USER',
        },
      })
      const responseText = await angelResponse.text()
      let responseBody
      try {
        responseBody = JSON.parse(responseText)
      } catch {
        responseBody = { message: responseText || 'Angel One returned an invalid response.' }
      }
      sendJson(response, angelResponse.status, responseBody)
    } catch {
      sendJson(response, 502, { message: 'Unable to connect to Angel One.' })
    }
    return
  }

  if (request.method !== 'POST' || request.url !== '/api/angelone/login') {
    sendJson(response, 404, { message: 'Not found.' })
    return
  }

  try {
    const input = JSON.parse(await readBody(request))
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      sendJson(response, 400, { message: 'Request body must be a JSON object.' })
      return
    }
    const clientcode = typeof input.clientcode === 'string' ? input.clientcode.trim() : ''
    const password = typeof input.password === 'string' ? input.password : ''
    const totp = typeof input.totp === 'string' ? input.totp.trim() : ''
    const state = typeof input.state === 'string' && input.state.trim() ? input.state.trim() : 'live'

    if (!clientcode || !password || !totp) {
      sendJson(response, 400, { message: 'clientcode, password, and totp are required.' })
      return
    }

    const privateKey = process.env.ANGELONE_PRIVATE_KEY
    if (!privateKey) {
      sendJson(response, 503, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
      return
    }

    const angelResponse = await fetch(angelOneUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '',
        'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '',
        'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '',
        'X-PrivateKey': privateKey,
        'X-SourceID': 'WEB',
        'X-UserType': 'USER',
      },
      body: JSON.stringify({ clientcode, password, totp, state }),
    })

    const responseText = await angelResponse.text()
    let responseBody
    try {
      responseBody = JSON.parse(responseText)
    } catch {
      responseBody = { message: responseText || 'Angel One returned an invalid response.' }
    }
    sendJson(response, angelResponse.status, responseBody)
  } catch (error) {
    const message = error instanceof SyntaxError ? 'Request body must be valid JSON.' : 'Unable to connect to Angel One.'
    sendJson(response, 502, { message })
  }
})

server.listen(port, () => {
  console.log(`Angel One API server listening on http://localhost:${port}`)
})
