import { readFileSync } from 'node:fs'

// The same reviewed date/segment overrides used by the browser agent. Keeping
// these in one file prevents a Sunday fix in the UI leaving ATM VWAP on Friday.
const { sessions: specialSessions } = JSON.parse(readFileSync(new URL('../src/data/specialTradingSessions.json', import.meta.url), 'utf8'))
const minute = 60_000, day = 86_400_000, offset = 330 * minute
export function indexSession(time, segment = 'NSE') {
  const start = Math.floor((time + offset) / day) * day - offset
  const local = new Date(start + offset), date = local.toISOString().slice(0, 10)
  const override = specialSessions.find(row => row.date === date)?.segments[segment]
  return { start, date, tradingDay: Boolean(override || ![0, 6].includes(local.getUTCDay())),
    open: start + (override?.openMinute ?? 555) * minute, close: start + (override?.closeMinute ?? 930) * minute }
}

/** Before the first completed minute, retain the last available session. */
export function latestIndexSession(time, segment = 'NSE') {
  let session = indexSession(time, segment)
  while (!session.tradingDay || time < session.open + minute) session = indexSession(session.start - 1, segment)
  return session
}
