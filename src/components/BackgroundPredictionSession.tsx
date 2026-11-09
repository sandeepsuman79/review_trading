import { lazy, Suspense, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { monitoringStartedKey, monitoringTokenTimes, monitoringWindow, type MonitoringAccess } from '../analysis/monitoringSession'

const PredictionPage = lazy(() => import('../pages/PredictionPage'))
function readAccess(): MonitoringAccess | undefined {
  const token = localStorage.getItem('angelone_jwt_token')
  if (!token) return
  const saved = Number(localStorage.getItem(monitoringStartedKey))
  const startedAt = saved > 0 ? saved : monitoringTokenTimes(token).issuedAt ?? Date.now()
  if (!(saved > 0)) localStorage.setItem(monitoringStartedKey, String(startedAt))
  return { token, startedAt }
}
/** One page/engine instance survives route changes. Closing the browser ends it. */
export default function BackgroundPredictionSession() {
  const { pathname } = useLocation(), visible = pathname === '/prediction'
  const [access, setAccess] = useState(readAccess), [now, setNow] = useState(Date.now)
  const windowState = monitoringWindow(access, now)
  useEffect(() => {
    const refresh = () => { setAccess(previous => {
      const next = readAccess()
      return previous?.token === next?.token && previous?.startedAt === next?.startedAt ? previous : next
    }); setNow(Date.now()) }
    const rejected = () => setAccess(previous => previous ? { ...previous, blocked: true } : previous)
    window.addEventListener('angelone-auth-changed', refresh)
    window.addEventListener('angelone-session-expired', rejected)
    window.addEventListener('storage', refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('angelone-auth-changed', refresh); window.removeEventListener('angelone-session-expired', rejected); window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(30_000, (windowState.nextAt ?? now + 30_000) - now)))
    return () => window.clearTimeout(timer)
  }, [now, windowState.nextAt])
  const keepAlive = ['WAITING', 'RUNNING', 'SETTLING'].includes(windowState.phase)
  const time = (value: number) => new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
  const sessionLabel = windowState.sessionLabel ? `${windowState.sessionLabel} · ` : ''
  const status = windowState.phase === 'RUNNING' ? `${sessionLabel}Background monitoring active · 5-minute setups and SL/TSL · Indices until ${time(windowState.indexCloseAt)} IST; MCX until ${time(windowState.mcxCloseAt)} IST · Token/session deadline ${time(windowState.stopsAt)} IST`
    : windowState.phase === 'WAITING' ? `${sessionLabel}Background monitoring armed · Starts at ${time(windowState.openAt)} IST.`
      : windowState.phase === 'SETTLING' ? 'Market closed · Saving final observed trade updates; new entries are stopped.'
        : windowState.phase === 'CLOSED' ? `${sessionLabel}Background monitoring stopped · This market session has ended or is closed. Scheduled hours ${time(windowState.openAt)}–${time(windowState.closeAt)} IST; sign in for the current session if needed.`
          : 'Background monitoring stopped · Sign in again to renew the expired or unavailable session.'
  return <>
    {access && <div className="background-monitoring-status container" role="status">{status}<small>Continues on other pages or a hidden tab while this app stays open. Browser sleep/discard can interrupt updates; saved state is reconciled when the app resumes.</small></div>}
    {(visible || keepAlive) && <div hidden={!visible}><Suspense fallback={visible ? <p role="status" className="container">Loading trading dashboard…</p> : null}><PredictionPage dashboardVisible={visible} monitoringSession={access} /></Suspense></div>}
  </>
}
