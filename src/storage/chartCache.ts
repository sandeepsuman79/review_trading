import type { AngelOneCandle } from '../api/angelOne'
const ownedChartKey = /^angelone_chart_v\d+_/
const quotaError = (error: unknown) => error instanceof Error && (error.name === 'QuotaExceededError' || /quota/i.test(error.message))
/** Chart candles are refetchable caches; trade records and credentials are never evicted. */
export function writeChartCache(storage: Storage, key: string, candles: AngelOneCandle[], preferredToken?: string) {
  let recent = candles.slice(-1200), value = JSON.stringify(recent)
  while (value.length > 90000 && recent.length > 50) { recent = recent.slice(Math.ceil(recent.length / 10)); value = JSON.stringify(recent) }
  const candidates: Array<{ key: string; size: number; selected: boolean }> = []
  let total = value.length
  for (let i = 0; i < storage.length; i++) {
    const other = storage.key(i)
    if (!other || other === key || !ownedChartKey.test(other)) continue
    const size = storage.getItem(other)?.length ?? 0
    candidates.push({ key: other, size, selected: Boolean(preferredToken && other.includes(`_${preferredToken}_`)) }); total += size
  }
  candidates.sort((a,b) => Number(a.selected) - Number(b.selected))
  while (total > 700000 && candidates.length) { const oldest = candidates.shift()!; storage.removeItem(oldest.key); total -= oldest.size }
  const attempts = candidates.length + 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { storage.setItem(key, value); return true }
    catch (error) {
      if (!quotaError(error)) throw error
      const oldest = candidates.shift()
      if (!oldest) return false
      storage.removeItem(oldest.key)
    }
  }
  return false
}
