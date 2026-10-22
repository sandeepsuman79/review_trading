import { useEffect, useRef, useState } from 'react'
import { getSharedAtmVwap, type AtmVwapSnapshot } from '../api/atmVwap'
export function useAtmVwap(instrument: string, price: number | undefined, now: number, enabled: boolean) {
  const latestPrice = useRef(price); latestPrice.current = price
  const boundary = Math.floor(now / 60_000), hasPrice = price !== undefined && Number.isFinite(price) && price > 0
  const step = instrument === 'Nifty 50' ? 50 : 100
  const atmStrike = hasPrice ? Math.round(price! / step) * step : undefined
  const [state, setState] = useState<{ instrument: string; data?: AtmVwapSnapshot; error?: string }>({ instrument })
  useEffect(() => {
    if (!enabled || !hasPrice) return
    let active = true
    void getSharedAtmVwap(instrument, latestPrice.current!, boundary * 60_000)
      .then(data => { if (active) setState({ instrument, data }) })
      .catch(error => {
        if (active) setState(previous => ({ instrument, data: previous.instrument === instrument ? previous.data : undefined,
          error: error instanceof Error ? error.message : 'ATM option VWAP unavailable.' }))
      })
    return () => { active = false }
  }, [instrument, boundary, hasPrice, enabled, atmStrike])
  // Never show a prior index or a distant ATM strike while its replacement loads.
  if (state.instrument !== instrument) return { instrument }
  if (state.data && (atmStrike === undefined || Math.abs(state.data.strike - atmStrike) > step)) return { ...state, data: undefined }
  return state
}
