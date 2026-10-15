import { decodeStreamPacket } from './streamPacket'
import { isAngelOneAuthError } from './angelOneSession'

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
  optionExpiry?: string
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
  sequence?: number
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
    const body = result as { message?: string; errorcode?: string; errorCode?: string }
    throw Object.assign(new Error(body.message || `${fallback} (${response.status}).`), { status: response.status, errorcode: body.errorcode || body.errorCode })
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
  const result = await readResponse<AngelOneProfileResponse>(response, 'Angel One profile request failed')
  if (isAngelOneAuthError(result)) throw Object.assign(new Error(result.message || 'Angel One session expired.'), { status: 401, errorcode: result.errorcode })
  return result
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

export async function getInstrumentMaster(scope?: 'indices'): Promise<AngelOneInstrument[]> {
  const response = await fetch(scope === 'indices' ? '/api/instruments?scope=indices' : '/api/instruments')
  const result = await readResponse<AngelOneInstrument[] | AngelOneDataResponse<AngelOneInstrument[]>>(response, 'Instrument master request failed')
  return Array.isArray(result) ? result : result.data || []
}

export async function getAngelOneLtp(token: string, instrument: Pick<AngelOneInstrument, 'exch_seg' | 'symbol' | 'token'>, signal?: AbortSignal): Promise<AngelOneDataResponse<AngelOneLtp | AngelOneLtp[]>> {
  const response = await fetch('/api/angelone/ltp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal,
    body: JSON.stringify({ exchange: instrument.exch_seg === 'bse_cm' ? 'BSE' : 'NSE', tradingsymbol: instrument.symbol, symboltoken: instrument.token }),
  })
  return readResponse<AngelOneDataResponse<AngelOneLtp | AngelOneLtp[]>>(response, 'Angel One LTP request failed')
}

export class HistoricalRequestError extends Error {
  constructor(message: string, public status: number, public retryAfterMs = 0, public errorcode?: string) { super(message) }
}

async function postHistorical<T extends AngelOneCandle[] | AngelOneOi[]>(path: 'candles' | 'oi', token: string, body: object, signal?: AbortSignal) {
  const response = await fetch(`/api/angelone/historical/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  })
  let result: AngelOneDataResponse<T> & { retryAfterMs?: number; errorCode?: string }
  try { result = await response.json() } catch { throw new HistoricalRequestError(`Angel One historical request failed (${response.status}).`, response.ok ? 502 : response.status) }
  const code = result.errorcode || result.errorCode
  if (!response.ok || result.status !== true) throw new HistoricalRequestError(`${result.message || 'Historical request rejected'}${code ? ` (${code})` : ''}`, isAngelOneAuthError({ ...result, status: response.status }) ? 401 : response.status, result.retryAfterMs, code)
  if (!Array.isArray(result.data)) throw new HistoricalRequestError('Angel One returned invalid historical data.', 502)
  return result
}

export const getHistoricalCandles = (token: string, body: object, signal?: AbortSignal) => postHistorical<AngelOneCandle[]>('candles', token, body, signal)
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
  let status = ''
  const reportStatus = (next: string) => {
    if (next === status) return
    status = next
    onStatus(next)
  }
  socket.onopen = () => {
    reportStatus('Connected')
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
          reportStatus(error.errorMessage ? `${error.errorCode || 'Stream error'}: ${error.errorMessage}` : event.data)
        } catch {
          reportStatus(event.data)
        }
      }
      return
    }
    let tick: AngelOneStreamTick
    try {
      tick = decodeStreamPacket(event.data as ArrayBuffer)
    } catch (error) {
      reportStatus(error instanceof Error ? error.message : 'Received an invalid Smart Stream packet.')
      return
    }
    reportStatus('Connected')
    onTick(tick)
  }
  socket.onerror = () => reportStatus('Streaming connection error.')
  socket.onclose = () => {
    if (heartbeat) window.clearInterval(heartbeat)
    reportStatus('Disconnected')
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
