import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { logoutFromAngelOne } from '../api/angelOne'

export default function Navbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const [logoutError, setLogoutError] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(() => Boolean(localStorage.getItem('angelone_jwt_token')))

  useEffect(() => {
    const updateAuthState = () => setIsLoggedIn(Boolean(localStorage.getItem('angelone_jwt_token')))
    window.addEventListener('storage', updateAuthState)
    window.addEventListener('angelone-auth-changed', updateAuthState)
    return () => {
      window.removeEventListener('storage', updateAuthState)
      window.removeEventListener('angelone-auth-changed', updateAuthState)
    }
  }, [])

  async function handleLogout() {
    const token = localStorage.getItem('angelone_jwt_token')
    const clientcode = localStorage.getItem('angelone_clientcode')
    setLogoutError('')
    setLoggingOut(true)
    try {
      if (token && clientcode) {
        await logoutFromAngelOne(token, clientcode)
      }
      localStorage.removeItem('angelone_jwt_token')
      localStorage.removeItem('angelone_refresh_token')
      localStorage.removeItem('angelone_clientcode')
      window.dispatchEvent(new Event('angelone-auth-changed'))
      navigate('/angelone/login')
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Angel One logout failed.')
    } finally {
      setLoggingOut(false)
    }
  }

  const links = [
    { to: '/', label: 'Profile' },
    { to: '/feed', label: 'Feed' },
    { to: '/prediction', label: 'Traders Prediction' },
    { to: '/angelone/login', label: 'Angel One Login' },
  ]

  return (
    <nav style={{
      background: '#fff',
      borderBottom: '1px solid #E5E7EB',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      boxShadow: '0 1px 8px rgba(108,99,255,0.07)'
    }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60 }}>
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'linear-gradient(135deg, #6C63FF, #FF6584)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 16
          }}>P</div>
          <span style={{ fontWeight: 700, fontSize: 17, color: '#1A1A2E' }}>My Profile Portal</span>
        </Link>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              style={{
                padding: '7px 18px',
                borderRadius: 999,
                fontWeight: 500,
                fontSize: 14,
                background: location.pathname === l.to ? '#EEF0FF' : 'transparent',
                color: location.pathname === l.to ? '#6C63FF' : '#6B7280',
                border: location.pathname === l.to ? '1px solid #C7C3FF' : '1px solid transparent',
                transition: 'all 0.15s'
              }}
            >
              {l.label}
            </Link>
          ))}
          {isLoggedIn && (
            <button type="button" onClick={handleLogout} disabled={loggingOut} style={{
              padding: '7px 18px', borderRadius: 999, fontWeight: 500, fontSize: 14,
              background: 'transparent', color: '#DC2626', border: '1px solid #FECACA',
            }}>
              {loggingOut ? 'Logging out…' : 'Logout'}
            </button>
          )}
        </div>
      </div>
      {logoutError && <div style={{ color: '#991B1B', textAlign: 'center', paddingBottom: 8 }}>{logoutError}</div>}
    </nav>
  )
}
