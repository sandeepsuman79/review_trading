import { instrumentSession, tradingSession } from './tradingSession'

export const monitoringStartedKey = 'angelone_monitor_started_at'
export const monitoringCloseGrace = 30_000
/** Keep recovering transient disconnects without a busy reconnect loop. */
export const monitoringReconnectDelay = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(1, attempt)))
export type MonitoringAccess = { token: string; startedAt: number; blocked?: boolean }
export type MonitoringPhase = 'SIGNED_OUT' | 'EXPIRED' | 'INVALID' | 'WAITING' | 'RUNNING' | 'SETTLING' | 'CLOSED'

/** JWT expiry is a local scheduling hint, not signature/authentication validation.
 * Broker rejection independently blocks the session. Never log or export tokens. */
export function monitoringTokenTimes(token: string) {
  try {
    const raw = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')))
    return { expiresAt: typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined,
      issuedAt: typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat * 1000 : undefined }
  } catch { return {} }
}
export function validMonitoringAuth(access: MonitoringAccess | undefined, now: number) {
  const expiry = access ? monitoringTokenTimes(access.token).expiresAt : undefined
  return Boolean(access?.token && !access.blocked && Number.isFinite(now) && expiry !== undefined && expiry > now)
}
export function monitoringWindow(access: MonitoringAccess | undefined, now: number) {
  const token = access?.token, times = token ? monitoringTokenTimes(token) : {}, session = tradingSession(now)
  const index = instrumentSession(now, 'Nifty 50'), sensex = instrumentSession(now, 'Sensex'), mcx = instrumentSession(now, 'Crude Oil')
  const sessions = [index, sensex, mcx].filter(value => value.tradingDay)
  const openAt = Math.min(index.open, sensex.open, mcx.open), closeAt = Math.max(index.close, sensex.close, mcx.close)
  const stopsAt = Math.min(times.expiresAt ?? closeAt, closeAt)
  let phase: MonitoringPhase
  if (!token) phase = 'SIGNED_OUT'
  else if (access.blocked || times.expiresAt === undefined || !Number.isFinite(access.startedAt)) phase = 'INVALID'
  else if (now >= times.expiresAt) phase = 'EXPIRED'
  else if (!sessions.length || tradingSession(access.startedAt).date !== session.date || now >= closeAt + monitoringCloseGrace) phase = 'CLOSED'
  else if (now < openAt) phase = 'WAITING'
  else if (now < closeAt) phase = 'RUNNING'
  else phase = 'SETTLING'
  const nextAt = phase === 'WAITING' ? Math.min(openAt, times.expiresAt!) : phase === 'RUNNING' ? stopsAt : phase === 'SETTLING' ? Math.min(closeAt + monitoringCloseGrace, times.expiresAt!) : undefined
  return { phase, openAt, closeAt, stopsAt, nextAt, indexCloseAt: index.close, mcxCloseAt: mcx.close, sessionLabel: sessions.find(value => value.special)?.label }
}
export function canMonitorInstrument(access: MonitoringAccess | undefined, now: number, instrument?: string, closingQuotes = true) {
  const window = monitoringWindow(access, now)
  if (window.phase !== 'RUNNING' && (!closingQuotes || window.phase !== 'SETTLING')) return false
  if (!instrument) return true
  const session = instrumentSession(now, instrument)
  return session.tradingDay && now >= session.open && now < session.close + (closingQuotes ? monitoringCloseGrace : 0)
}
