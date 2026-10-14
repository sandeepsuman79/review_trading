import { AngelOneSessionExpiredError, isAngelOneAuthError, recoverAngelOneSession } from './angelOneSession'

export type OptionPremium = { ltp: number | null; symbol?: string; token?: string; exchange?: 'NFO' | 'BFO'; message?: string | null; receivedAt?: string | null }
export type OptionPremiumSnapshot = { index: string; expiry: string; fetchedAt: string; timeBasis: 'RECEIVED'; rows: Array<{ strike: number; ce: OptionPremium; pe: OptionPremium }> }
export async function getOptionPremiums(index: string, strikes: number[], token: string, signal: AbortSignal): Promise<OptionPremiumSnapshot> {
  let data
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted()
    const response = await fetch('/api/angelone/option-premiums', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ index, strikes }), signal })
    data = await response.json().catch(() => ({}))
    const authError = isAngelOneAuthError({ ...data, status: response.status })
    if (!response.ok || data.status === false || data.success === false || authError) {
      if (authError) {
        if (attempt === 1) throw new AngelOneSessionExpiredError()
        token = await recoverAngelOneSession(token)
        continue
      }
      throw new Error(data.message || 'Option premiums are unavailable. Please retry shortly.')
    }
    break
  }
  if (data.index !== index || !/^\d{4}-\d{2}-\d{2}$/.test(data.expiry) || !Number.isFinite(Date.parse(data.fetchedAt)) || data.timeBasis !== 'RECEIVED' || !Array.isArray(data.rows) || data.rows.length !== strikes.length || new Set(data.rows.map((row: { strike: number }) => row.strike)).size !== strikes.length || data.rows.some((row: OptionPremiumSnapshot['rows'][number]) => !strikes.includes(row.strike) || [row.ce, row.pe].some(leg => !leg || leg.ltp !== null && (typeof leg.ltp !== 'number' || !Number.isFinite(leg.ltp) || leg.ltp <= 0)))) throw new Error('Option premiums returned an invalid response.')
  return data
}
