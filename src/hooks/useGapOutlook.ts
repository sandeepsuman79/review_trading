import { useEffect, useState } from 'react'
import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionAnalysis } from '../analysis/priceAction'
import type { TradingEvidence } from '../analysis/tradingEvidence'
import { buildGapOutlook, gapOutlookKey, readGapOutlook, type GapOutlook } from '../analysis/gapOutlook'
import { gapOutlookMinute, tradingSession } from '../analysis/tradingSession'

export function useGapOutlook(instrument: string, candles: AngelOneCandle[], analysis: PriceActionAnalysis, evidence: TradingEvidence, now: number) {
  const [outlook, setOutlook] = useState<GapOutlook>()
  const [error, setError] = useState('')
  useEffect(() => {
    const load = () => {
      try { setOutlook(readGapOutlook(localStorage, instrument)); setError('') }
      catch { setError('Saved outlook could not be read. Existing data was preserved.') }
    }
    load()
    const receive = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === gapOutlookKey(instrument) || event.key === null)) load() }
    window.addEventListener('storage', receive)
    return () => window.removeEventListener('storage', receive)
  }, [instrument])
  useEffect(() => {
    const session = tradingSession(now)
    if (!session.weekday || session.minute !== gapOutlookMinute || outlook?.session === session.date) return
    const next = buildGapOutlook(instrument, candles, analysis, evidence, now)
    if (!next) return
    try {
      const saved = readGapOutlook(localStorage, instrument)
      if (saved?.session === next.session) { setOutlook(saved); return }
      localStorage.setItem(gapOutlookKey(instrument), JSON.stringify(next))
      setOutlook(next); setError('')
    } catch { setError('The 15:00 outlook could not be saved. Existing data was preserved.') }
  }, [instrument, candles, analysis, evidence, now, outlook?.session])
  return { outlook, error }
}
