import { FormEvent, useState } from 'react'
import { loginToAngelOne } from '../api/angelOne'

export default function AngelOneLoginPage() {
  const [clientcode, setClientcode] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [state, setState] = useState('live')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setLoading(true)
    try {
      const result = await loginToAngelOne({ clientcode, password, totp, state })
      localStorage.setItem('angelone_clientcode', clientcode.trim())
      if (result.data?.jwtToken) {
        localStorage.setItem('angelone_jwt_token', result.data.jwtToken)
      }
      if (result.data?.refreshToken) {
        localStorage.setItem('angelone_refresh_token', result.data.refreshToken)
      }
      window.dispatchEvent(new Event('angelone-auth-changed'))
      setMessage(result.status ? 'Angel One login successful.' : result.message || 'Angel One login failed.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Angel One login failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="container" style={{ padding: '48px 0' }}>
      <div className="card" style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <h1 style={{ marginTop: 0 }}>Angel One Login</h1>
        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
          <label>Client code<input required value={clientcode} onChange={(event) => setClientcode(event.target.value)} /></label>
          <label>Password<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <label>TOTP<input required value={totp} onChange={(event) => setTotp(event.target.value)} /></label>
          <label>State<input value={state} onChange={(event) => setState(event.target.value)} /></label>
          <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
        </form>
        {message && <p role="status">{message}</p>}
      </div>
    </main>
  )
}
