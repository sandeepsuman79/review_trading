import { useEffect, useRef, useState } from 'react'
import { atmOptionChartKey, getAtmOptionCandles, type AtmOptionCandles } from '../api/atmOptionCandles'
import type { AtmVwapSnapshot } from '../api/atmVwap'
import type { AgentTimeframe } from '../analysis/multiTimeframe'

export function useAtmOptionCandles(snapshot: AtmVwapSnapshot | undefined, interval: AgentTimeframe, now: number) {
  const latest = useRef(snapshot); latest.current = snapshot
  const key = snapshot ? atmOptionChartKey(snapshot, interval) : '', minute = Math.floor((now - 5000) / 60_000)
  const [state, setState] = useState<{ key: string; data?: AtmOptionCandles; error?: string }>({ key: '' })
  useEffect(() => {
    if (!key || !latest.current) return
    let active = true
    void getAtmOptionCandles(latest.current, interval, minute * 60_000 + 5000)
      .then(data => { if (active) setState({ key, data }) })
      .catch(error => { if (active) setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, error: error instanceof Error ? error.message : 'ATM chart history unavailable.' })) })
    return () => { active = false }
  }, [key, interval, minute])
  return state.key === key ? state : { key }
}
