import type { AngelOneInstrument } from '../api/angelOne'

export const commoditySpecs = [
  { name: 'Natural Gas', root: 'NATURALGAS' }, { name: 'Crude Oil', root: 'CRUDEOIL' },
  { name: 'Silver', root: 'SILVER' }, { name: 'Gold', root: 'GOLD' },
] as const
export type CommodityContract = { name: string; root: string; exchange: 'MCX'; exchangeType: 5; token: string; symbol: string; expiry: string; expiresAt: number; lotSize?: number; tickSize?: number }
export const isCommodity = (instrument?: string) => commoditySpecs.some(spec => spec.name === instrument)
export const tradeDirection = (instrument: string, side: string) => isCommodity(instrument) ? side === 'CALL' ? 'LONG' : side === 'PUT' ? 'SHORT' : side : side
const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
const newYorkHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })

/** Regular bullion/energy MCX hours follow US daylight saving, not index square-off hours. */
export function mcxSession(now: number) {
  const date = new Date(now + 330 * 60_000), day = date.getUTCDay()
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - 330 * 60_000
  const dst = Number(newYorkHour.format(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12))) === 8
  const closeMinute = dst ? 23 * 60 + 30 : 23 * 60 + 55
  return { start, date: date.toISOString().slice(0, 10), open: start + 540 * 60_000, close: start + closeMinute * 60_000,
    closeLabel: dst ? '23:30' : '23:55', regularSession: day >= 1 && day <= 5 && now >= start + 540 * 60_000 && now < start + closeMinute * 60_000 }
}

function expiryTime(value?: string) {
  const match = /^(\d{1,2})[- ]?([A-Z]{3})[- ]?(\d{4})$/i.exec(value || '')
  if (!match) return NaN
  const day = Number(match[1]), month = months.indexOf(match[2].toUpperCase()), year = Number(match[3])
  const noon = Date.UTC(year, month, day, 6, 30), parsed = new Date(noon)
  if (month < 0 || parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day) return NaN
  return mcxSession(noon).close
}

export function resolveCommodityContracts(master: AngelOneInstrument[], now: number): CommodityContract[] {
  return commoditySpecs.flatMap(spec => {
    const candidates = master.filter(item => item.exch_seg === 'MCX' && item.instrumenttype === 'FUTCOM' && item.name === spec.root && /^\d+$/.test(String(item.token)) && item.symbol?.endsWith('FUT'))
      .map(item => ({ item, expiresAt: expiryTime(item.expiry) })).filter(item => Number.isFinite(item.expiresAt) && item.expiresAt > now)
      .sort((a, b) => a.expiresAt - b.expiresAt || a.item.symbol.localeCompare(b.item.symbol))
    const selected = candidates[0]
    if (!selected) return []
    const lotSize = Number(selected.item.lotsize), tickSize = Number(selected.item.tick_size) / 100
    return [{ ...spec, token: String(selected.item.token), symbol: selected.item.symbol, exchange: 'MCX' as const, exchangeType: 5 as const,
      expiry: mcxSession(selected.expiresAt).date, expiresAt: selected.expiresAt, ...(Number.isFinite(lotSize) && lotSize > 0 ? { lotSize } : {}), ...(Number.isFinite(tickSize) && tickSize > 0 ? { tickSize } : {}) }]
  })
}

export function validCommodityContract(value: unknown, instrument: string): value is CommodityContract {
  if (!value || typeof value !== 'object') return false
  const contract = value as CommodityContract, spec = commoditySpecs.find(item => item.name === instrument)
  if (!spec || contract.name !== instrument || contract.root !== spec.root || contract.exchange !== 'MCX' || contract.exchangeType !== 5 || !/^\d+$/.test(contract.token) || typeof contract.symbol !== 'string' || !contract.symbol.startsWith(spec.root) || !contract.symbol.endsWith('FUT') || !/^\d{4}-\d{2}-\d{2}$/.test(contract.expiry) || !Number.isFinite(contract.expiresAt)) return false
  const noon = Date.parse(`${contract.expiry}T12:00:00+05:30`)
  return Number.isFinite(noon) && mcxSession(noon).date === contract.expiry && contract.expiresAt === mcxSession(noon).close
    && [contract.lotSize, contract.tickSize].every(item => item === undefined || Number.isFinite(item) && item > 0)
}
