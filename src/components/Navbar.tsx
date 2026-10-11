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
      localStorage.removeItem('angelone_feed_token')
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
    <nav aria-label="Main navigation" style={{
      background: '#fff',
      borderBottom: '1px solid #E5E7EB',
      position: location.pathname === '/prediction' ? 'relative' : 'sticky',
      top: 0,
      zIndex: 100,
      boxShadow: '0 1px 8px rgba(108,99,255,0.07)'
    }}>
      <div className={`container navbar-inner${location.pathname === '/prediction' ? ' prediction-page-container' : ''}`}>
        <Link to="/" className="navbar-brand" aria-label="My Profile Portal" title="My Profile Portal">
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'linear-gradient(135deg, #6C63FF, #FF6584)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 16
          }}>P</div>
        </Link>

        <div className="navbar-links">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className="navbar-link"
              aria-current={location.pathname === l.to ? 'page' : undefined}
              style={{
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
            <button type="button" className="navbar-logout" aria-label={loggingOut ? 'Logging out…' : 'Logout'} title={loggingOut ? 'Logging out…' : 'Logout'} aria-busy={loggingOut} onClick={handleLogout} disabled={loggingOut} style={{
              borderRadius: 999, fontWeight: 500, fontSize: 14,
              background: 'transparent', color: '#DC2626', border: '1px solid #FECACA',
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
                <path d="M14 8l4 4-4 4M9 12h12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {logoutError && <div role="alert" style={{ color: '#991B1B', textAlign: 'center', paddingBottom: 8 }}>{logoutError}</div>}
    </nav>
  )
}
