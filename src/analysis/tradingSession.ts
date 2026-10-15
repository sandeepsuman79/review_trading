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

export function squareOffTime(time: number) {
  return tradingSession(time).start + squareOffMinute * 60_000
}

export function inTradingEntryWindow(time: number) {
  const session = tradingSession(time)
  return Number.isFinite(time) && session.weekday && session.minute >= tradingOpenMinute && session.minute < squareOffMinute
}
