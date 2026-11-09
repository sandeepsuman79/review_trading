import { isCommodity } from './commodities'
import { exchangeDay, exchangeSession, sessionTimeLabel } from './exchangeCalendar'
export const tradingOpenMinute = 9 * 60 + 15
export const squareOffMinute = 15 * 60 + 15
export const gapOutlookMinute = 15 * 60

/** Strategy schedule in IST, independent of the device timezone and exchange closing auctions. */
export function tradingSession(time: number) {
  return exchangeDay(time)
}

/** Agent decisions follow the underlying index or exact MCX futures session. */
export function instrumentSession(time: number, instrument?: string) {
  return exchangeSession(time, isCommodity(instrument) ? 'MCX' : instrument === 'Sensex' ? 'BSE' : 'NSE')
}

export function squareOffTime(time: number, instrument?: string) {
  return instrumentSession(time, instrument).entryClose
}

export function inTradingEntryWindow(time: number, instrument?: string) {
  if (!Number.isFinite(time)) return false
  const session = instrumentSession(time, instrument)
  return session.tradingDay && time >= session.open && time < session.entryClose
}

export function marketHours(instrument: string | undefined, time: number) {
  const session = instrumentSession(time, instrument)
  return `${session.special ? session.label : 'Mon–Fri'} ${session.openLabel}–${sessionTimeLabel(session.entryCloseMinute)} IST`
}

export function squareOffLabel(instrument: string | undefined, time: number) {
  return sessionTimeLabel(instrumentSession(time, instrument).entryCloseMinute)
}
