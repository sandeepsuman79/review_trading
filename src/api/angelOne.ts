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

async function readLoginResponse(response: Response): Promise<AngelOneLoginResponse> {
  const responseText = await response.text()
  if (!responseText.trim()) {
    return { message: `Login service returned an empty response (HTTP ${response.status}).` }
  }

  try {
    return JSON.parse(responseText) as AngelOneLoginResponse
  } catch {
    return { message: responseText }
  }
}

export async function loginToAngelOne(input: AngelOneLoginInput): Promise<AngelOneLoginResponse> {
  const response = await fetch('/api/angelone/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const result = await readLoginResponse(response)
  if (!response.ok) {
    throw new Error(result.message || 'Angel One login failed.')
  }
  return result
}
