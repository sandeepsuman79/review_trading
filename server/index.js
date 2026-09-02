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
      sendJson(response, 500, { message: 'ANGELONE_PRIVATE_KEY is not configured on the server.' })
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
    let responseBody = { message: 'Angel One returned an empty response.' }
    if (responseText.trim()) {
      try {
        responseBody = JSON.parse(responseText)
      } catch {
        responseBody = { message: responseText }
      }
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
