export type AngelOneLoginInput = {
  clientcode: string
  password: string
  totp: string
  state: string
}

export type AngelOneLoginResponse = {
  status?: boolean
  message?: string
  errorcode?: string
  data?: {
    jwtToken?: string
    refreshToken?: string
    feedToken?: string
  }
}

export type AngelOneProfile = {
  clientcode?: string
  name?: string
  email?: string
  mobileno?: string
  exchanges?: string[] | string
  products?: string[] | string
  lastlogintime?: string
  brokerid?: string
}

export type AngelOneProfileResponse = {
  status?: boolean
  message?: string
  errorcode?: string
  data?: AngelOneProfile
}

export type AngelOneRms = Record<string, string | number | undefined>

export type AngelOneRmsResponse = {
  status?: boolean
  message?: string
  errorcode?: string
  data?: AngelOneRms
}

export type AngelOneGttRule = {
  id?: string
  status?: string
  createddate?: string
  updateddate?: string
  expirydate?: string
  clientid?: string
  tradingsymbol?: string
  symboltoken?: string
  exchange?: string
  transactiontype?: string
  producttype?: string
  price?: string
  qty?: string
  triggerprice?: string
  disclosedqty?: string
  [key: string]: string | undefined
}

export type AngelOneGttResponse = {
  status?: boolean
  message?: string
  errorcode?: string
  data?: AngelOneGttRule | AngelOneGttRule[] | { id?: string } | string
}

export type AngelOneInstrument = {
  token: string
  symbol: string
  name?: string
  exch_seg?: string
  expiry?: string
  strike?: string
  lotsize?: string
  tick_size?: string
  instrumenttype?: string
}

export type AngelOneLtp = {
  exchange?: string
  tradingsymbol?: string
  symboltoken?: string | number
  open?: string
  high?: string
  low?: string
  close?: string
  ltp?: string
}

export type AngelOneDataResponse<T> = {
  status?: boolean
  message?: string
  errorcode?: string
  data?: T
}

export type AngelOneCandle = [string, number, number, number, number, number]
export type AngelOneOi = { time?: string; oi?: number }

export type AngelOneStreamTick = {
  mode: number
  exchangeType: number
  token: string
  timestamp: number
  ltp?: number
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
}

export type AngelOneOrderUpdate = {
  'user-id'?: string
  'status-code'?: string
  'order-status'?: string
  'error-message'?: string
  orderData?: Record<string, string | number>
}
async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text()
  let result: T = {} as T
  if (text.trim()) {
    try {
      result = JSON.parse(text) as T
    } catch {
      throw new Error(`${fallback} (${response.status}).`)
    }
  }
  if (!response.ok) {
    const message = (result as { message?: string }).message
    throw new Error(message || `${fallback} (${response.status}).`)
  }
  return result
}

export async function loginToAngelOne(input: AngelOneLoginInput): Promise<AngelOneLoginResponse> {
  const response = await fetch('/api/angelone/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  const responseText = await response.text()
  let result: AngelOneLoginResponse = {}

  if (responseText.trim()) {
    try {
      result = JSON.parse(responseText) as AngelOneLoginResponse
    } catch {
      const detail = responseText.replace(/\s+/g, ' ').trim().slice(0, 200)
      throw new Error(
        response.ok ? 'Angel One returned an invalid response.' : detail || (
          response.status === 503
            ? 'Angel One login service is not configured. Set ANGELONE_PRIVATE_KEY and restart the server.'
            : `Angel One login failed (${response.status}).`
        ),
      )
    }
  }

  if (!response.ok) {
    throw new Error(
      result.message
      || (response.status === 503
        ? 'Angel One login service is not configured. Set ANGELONE_PRIVATE_KEY and restart the server.'
        : `Angel One login failed (${response.status}).`),
    )
  }

  return result
}

export async function getAngelOneProfile(token: string): Promise<AngelOneProfileResponse> {
  const response = await fetch('/api/angelone/profile', {
    headers: { Authorization: `Bearer ${token}` },
  })
  return readResponse<AngelOneProfileResponse>(response, 'Angel One profile request failed')
}

export async function refreshAngelOneToken(
  token: string,
  refreshToken: string,
): Promise<AngelOneLoginResponse> {
  const response = await fetch('/api/angelone/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ refreshToken }),
  })
  return readResponse<AngelOneLoginResponse>(response, 'Angel One token refresh failed')
}

export async function getAngelOneRms(token: string): Promise<AngelOneRmsResponse> {
  const response = await fetch('/api/angelone/rms', {
    headers: { Authorization: `Bearer ${token}` },
  })
  return readResponse<AngelOneRmsResponse>(response, 'Angel One RMS request failed')
}

export async function logoutFromAngelOne(token: string, clientcode: string): Promise<void> {
  const response = await fetch('/api/angelone/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientcode }),
  })
  await readResponse(response, 'Angel One logout failed')
}

async function postGtt(path: string, token: string, body: object): Promise<AngelOneGttResponse> {
  const response = await fetch(`/api/angelone/gtt/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return readResponse<AngelOneGttResponse>(response, `Angel One GTT ${path} failed`)
}

export const createGttRule = (token: string, rule: Omit<AngelOneGttRule, 'id' | 'status'>) =>
  postGtt('create', token, rule)
export const modifyGttRule = (token: string, rule: AngelOneGttRule) =>
  postGtt('modify', token, rule)
export const cancelGttRule = (token: string, rule: Pick<AngelOneGttRule, 'id' | 'symboltoken' | 'exchange'>) =>
  postGtt('cancel', token, rule)
export const getGttRuleDetails = (token: string, id: string) =>
  postGtt('details', token, { id })
export const listGttRules = (token: string, status: string[], page = 1, count = 10) =>
  postGtt('list', token, { status, page, count })

export async function getInstrumentMaster(): Promise<AngelOneInstrument[]> {
  const response = await fetch('/api/instruments')
  const result = await readResponse<AngelOneInstrument[] | AngelOneDataResponse<AngelOneInstrument[]>>(response, 'Instrument master request failed')
  return Array.isArray(result) ? result : result.data || []
}

export async function getAngelOneLtp(token: string, instrument: Pick<AngelOneInstrument, 'exch_seg' | 'symbol' | 'token'>): Promise<AngelOneDataResponse<AngelOneLtp[]>> {
  const response = await fetch('/api/angelone/ltp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exchange: instrument.exch_seg === 'bse_cm' ? 'BSE' : 'NSE', tradingsymbol: instrument.symbol, symboltoken: instrument.token }),
  })
  return readResponse<AngelOneDataResponse<AngelOneLtp[]>>(response, 'Angel One LTP request failed')
}

async function postHistorical<T extends AngelOneCandle[] | AngelOneOi[]>(path: 'candles' | 'oi', token: string, body: object) {
  const response = await fetch(`/api/angelone/historical/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return readResponse<AngelOneDataResponse<T>>(response, `Angel One historical ${path} request failed`)
}

export const getHistoricalCandles = (token: string, body: object) => postHistorical<AngelOneCandle[]>('candles', token, body)
export const getHistoricalOi = (token: string, body: object) => postHistorical<AngelOneOi[]>('oi', token, body)

export function connectAngelOneStream(
  onTick: (tick: AngelOneStreamTick) => void,
  onStatus: (status: string) => void,
) {
  const jwt = localStorage.getItem('angelone_jwt_token')
  const feedToken = localStorage.getItem('angelone_feed_token')
  const clientCode = localStorage.getItem('angelone_clientcode')
  const apiKey = import.meta.env.VITE_ANGELONE_API_KEY
  if (!jwt || !feedToken || !clientCode || !apiKey) {
    onStatus('Login and VITE_ANGELONE_API_KEY are required for streaming.')
    return null
  }

  const url = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${encodeURIComponent(clientCode)}&feedToken=${encodeURIComponent(feedToken)}&apiKey=${encodeURIComponent(apiKey)}`
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  let heartbeat: number | undefined
  socket.onopen = () => {
    onStatus('Connected')
    socket.send(JSON.stringify({
      correlationID: 'indices01',
      action: 1,
      params: {
        mode: 1,
        tokenList: [
          { exchangeType: 1, tokens: ['99926000', '99926009'] },
          { exchangeType: 3, tokens: ['99919000'] },
        ],
      },
    }))
    heartbeat = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('ping')
    }, 30000)
  }
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      if (event.data !== 'pong') {
        try {
          const error = JSON.parse(event.data) as { errorCode?: string; errorMessage?: string }
          onStatus(error.errorMessage ? `${error.errorCode || 'Stream error'}: ${error.errorMessage}` : event.data)
        } catch {
          onStatus(event.data)
        }
      }
      return
    }
    const buffer = event.data as ArrayBuffer
    const bytes = new DataView(buffer)
    if (bytes.byteLength < 47) {
      onStatus('Received an invalid Smart Stream packet.')
      return
    }
    const tokenBytes = new Uint8Array(buffer, 2, 25)
    const token = new TextDecoder().decode(tokenBytes).replace(/\0.*$/, '')
    const scale = 100
    const tick: AngelOneStreamTick = {
      mode: bytes.getUint8(0),
      exchangeType: bytes.getUint8(1),
      token,
      timestamp: Number(bytes.getBigInt64(35, true)),
      ltp: bytes.getInt32(43, true) / scale,
      volume: bytes.byteLength >= 71 ? Number(bytes.getBigInt64(63, true)) : undefined,
      open: bytes.byteLength >= 95 ? Number(bytes.getBigInt64(87, true)) / scale : undefined,
      high: bytes.byteLength >= 103 ? Number(bytes.getBigInt64(95, true)) / scale : undefined,
      low: bytes.byteLength >= 111 ? Number(bytes.getBigInt64(103, true)) / scale : undefined,
      close: bytes.byteLength >= 119 ? Number(bytes.getBigInt64(111, true)) / scale : undefined,
    }
    onTick(tick)
  }
  socket.onerror = () => onStatus('Streaming connection error.')
  socket.onclose = () => {
    if (heartbeat) window.clearInterval(heartbeat)
    onStatus('Disconnected')
  }
  return socket
}

export function connectAngelOneOrderStream(
  onUpdate: (update: AngelOneOrderUpdate) => void,
  onStatus: (status: string) => void,
) {
  const jwt = localStorage.getItem('angelone_jwt_token')
  if (!jwt) {
    onStatus('Login is required for order updates.')
    return null
  }

  const socket = new WebSocket('wss://tns.angelone.in/smart-order-update', [`bearer.${jwt}`])
  let heartbeat: number | undefined
  socket.onopen = () => {
    onStatus('Connected')
    heartbeat = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('ping')
    }, 10000)
  }
  socket.onmessage = (event) => {
    if (event.data === 'pong') return
    try {
      onUpdate(JSON.parse(String(event.data)) as AngelOneOrderUpdate)
    } catch {
      onStatus('Received an invalid order update.')
    }
  }
  socket.onerror = () => onStatus('Order update connection error.')
  socket.onclose = () => {
    if (heartbeat) window.clearInterval(heartbeat)
    onStatus('Disconnected')
  }
  return socket
}
