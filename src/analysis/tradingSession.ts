import { isCommodity, mcxSession } from './commodities'
const istOffset = 330 * 60_000
export const tradingOpenMinute = 9 * 60 + 15
export const squareOffMinute = 15 * 60 + 15
export const gapOutlookMinute = 15 * 60

/** Strategy schedule in IST, independent of the device timezone and exchange closing auctions. */
export function tradingSession(time: number) {
  const local = new Date(time + istOffset)
  const day = local.getUTCDay()
  return {
    date: Number.isFinite(time) ? local.toISOString().slice(0, 10) : '',
    weekday: day >= 1 && day <= 5,
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
    start: Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - istOffset,
  }
}

export function squareOffTime(time: number, instrument?: string) {
  if (isCommodity(instrument)) return mcxSession(time).close
  return tradingSession(time).start + squareOffMinute * 60_000
}

export function inTradingEntryWindow(time: number, instrument?: string) {
  if (!Number.isFinite(time)) return false
  if (isCommodity(instrument)) return mcxSession(time).regularSession
  const session = tradingSession(time)
  return Number.isFinite(time) && session.weekday && session.minute >= tradingOpenMinute && session.minute < squareOffMinute
}

export function marketHours(instrument: string | undefined, time: number) {
  return isCommodity(instrument) ? `Mon–Fri 09:00–${mcxSession(time).closeLabel} IST` : 'Mon–Fri 09:15–15:15 IST'
}

export function squareOffLabel(instrument: string | undefined, time: number) {
  return isCommodity(instrument) ? mcxSession(time).closeLabel : '15:15'
}
