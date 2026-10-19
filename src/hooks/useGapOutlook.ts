import { useEffect, useState } from 'react'
import type { TradingEvidence } from '../analysis/tradingEvidence'
import { buildGapOutlook, gapOutlookKey, readGapOutlook, type GapOutlook } from '../analysis/gapOutlook'

export function useGapOutlook(instrument: string, evidence: TradingEvidence, now: number) {
  const [state, setState] = useState<{ instrument: string; outlook?: GapOutlook; error: string }>({ instrument, error: '' })
  const minute = Math.floor(now / 60000)
  useEffect(() => {
    const load = () => {
      try { setState({ instrument, outlook: readGapOutlook(localStorage, instrument), error: '' }) }
      catch { setState({ instrument, error: 'Saved outlook could not be read. Existing data was preserved.' }) }
    }
    load()
    const receive = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === gapOutlookKey(instrument) || event.key === null)) load() }
    window.addEventListener('storage', receive)
    return () => window.removeEventListener('storage', receive)
  }, [instrument])
  useEffect(() => {
    const next = buildGapOutlook(instrument, evidence, minute * 60000)
    if (!next) return
    try {
      const saved = readGapOutlook(localStorage, instrument)
      if (saved && saved.generatedAt > next.generatedAt) return
      localStorage.setItem(gapOutlookKey(instrument), JSON.stringify(next))
      setState({ instrument, outlook: next, error: '' })
    } catch { setState(previous => ({ ...previous, error: 'The updated gap outlook could not be saved. Existing data was preserved.' })) }
  }, [instrument, evidence, minute])
  return state.instrument === instrument ? state : { outlook: undefined, error: '' }
}
