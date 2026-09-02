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
