import { sessions as specialSessions } from '../data/specialTradingSessions.json'

export type ExchangeSegment = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX'
const minute = 60_000, offset = 330 * minute
const newYorkHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })
export const sessionTimeLabel = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`

/** IST dates, independent of browser timezone. Weekday describes the date only;
 * callers must use exchangeSession().tradingDay to allow dated weekend sessions. */
export function exchangeDay(time: number) {
  const local = new Date(time + offset), day = local.getUTCDay()
  return {
    date: Number.isFinite(local.getTime()) ? local.toISOString().slice(0, 10) : '',
    weekday: day >= 1 && day <= 5,
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
    start: Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset,
  }
}

/** Dated exchange circulars take precedence over regular weekday hours. Never
 * infer next year's Diwali date/hours or open every Sunday. This is a special-
 * session override list, not a complete exchange holiday calendar. */
export function exchangeSession(time: number, segment: ExchangeSegment = 'NSE') {
  const day = exchangeDay(time), special = specialSessions.find(row => row.date === day.date)
  const override = special?.segments[segment]
  const dst = segment === 'MCX' && day.date ? Number(newYorkHour.format(day.start + offset + 12 * 60 * minute)) === 8 : false
  const openMinute = override?.openMinute ?? (segment === 'MCX' ? 540 : 555)
  const closeMinute = override?.closeMinute ?? (segment === 'MCX' ? dst ? 1410 : 1435 : 930)
  const tradingDay = Boolean(day.date && (override || day.weekday))
  // Existing strategy policy: index entries/square-off 15 minutes before spot
  // close; MCX entries until its actual close. These are not exchange mandates.
  const entryCloseMinute = segment === 'MCX' ? closeMinute : closeMinute - 15
  return { ...day, segment, tradingDay, special: Boolean(override), label: override ? special!.label : 'Regular session',
    source: override?.source, openMinute, closeMinute, entryCloseMinute,
    open: day.start + openMinute * minute, close: day.start + closeMinute * minute,
    entryClose: day.start + entryCloseMinute * minute,
    openLabel: sessionTimeLabel(openMinute), closeLabel: sessionTimeLabel(closeMinute),
    regularSession: tradingDay && time >= day.start + openMinute * minute && time < day.start + closeMinute * minute }
}
