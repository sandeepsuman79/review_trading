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
