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
