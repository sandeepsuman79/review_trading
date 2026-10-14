type BrokerError = { status?: number | boolean; errorcode?: string; errorCode?: string; message?: string }

export function isAngelOneAuthError(error: BrokerError) {
  const code = String(error.errorcode || error.errorCode || '').toUpperCase()
  return error.status === 401 || ['AG8001', 'AG8002', 'AG8003', 'AB8050', 'AB8051'].includes(code) || /(?:invalid|expired|missing)\s+(?:access\s+|jwt\s+|refresh\s+)?token|token\s+(?:expired|missing)|session expired/i.test(error.message || '')
}

export class AngelOneSessionExpiredError extends Error {
  constructor() { super('Angel One session expired. Please sign in again.'); this.name = 'AngelOneSessionExpiredError' }
}

let pending: { key: string; promise: Promise<string> } | undefined

/** Share token rotation with profile/quote requests; never overwrite a newer login or logout. */
export async function recoverAngelOneSession(rejectedToken: string): Promise<string> {
  const token = localStorage.getItem('angelone_jwt_token') || ''
  if (token && token !== rejectedToken) return token
  const refreshToken = localStorage.getItem('angelone_refresh_token')
  if (!refreshToken) throw new AngelOneSessionExpiredError()
  const key = JSON.stringify([token, refreshToken])
  if (pending?.key === key) return pending.promise
  const promise = (async () => {
    const response = await fetch('/api/angelone/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ refreshToken }), signal: AbortSignal.timeout(20_000),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.status === false || result.success === false || typeof result.data?.jwtToken !== 'string' || !result.data.jwtToken.trim()) {
      if (isAngelOneAuthError({ ...result, status: response.status })) throw new AngelOneSessionExpiredError()
      throw new Error('Angel One session refresh is temporarily unavailable. Please retry shortly.')
    }
    if ((localStorage.getItem('angelone_jwt_token') || '') !== token || localStorage.getItem('angelone_refresh_token') !== refreshToken) {
      const current = localStorage.getItem('angelone_jwt_token')
      if (current && current !== token) return current
      throw new AngelOneSessionExpiredError()
    }
    localStorage.setItem('angelone_jwt_token', result.data.jwtToken)
    for (const [field, storage] of [['refreshToken', 'angelone_refresh_token'], ['feedToken', 'angelone_feed_token']]) {
      if (typeof result.data[field] === 'string' && result.data[field].trim()) localStorage.setItem(storage, result.data[field])
    }
    window.dispatchEvent(new CustomEvent('angelone-auth-changed', { detail: { reason: 'token-refresh' } }))
    return result.data.jwtToken as string
  })()
  pending = { key, promise }
  try { return await promise } finally { if (pending?.promise === promise) pending = undefined }
}
