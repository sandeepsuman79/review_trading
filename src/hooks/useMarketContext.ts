import { useCallback, useEffect, useRef, useState } from 'react'
import { getMarketContext, type MarketContext } from '../api/marketContext'

export function useMarketContext(instrument: string, enabled = true) {
  const [context, setContext] = useState<MarketContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    if (!enabled) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError('')
    const timeout = window.setTimeout(() => controller.abort(), 45_000)
    try {
      const result = await getMarketContext(instrument, controller.signal)
      if (!controller.signal.aborted) setContext(result)
    } catch (cause) {
      if (controllerRef.current === controller) {
        setContext(null)
        setError(controller.signal.aborted ? 'Public market feeds timed out. Chart analysis continues.' : cause instanceof Error ? cause.message : 'Public market feeds are unavailable.')
      }
    } finally {
      window.clearTimeout(timeout)
      if (controllerRef.current === controller) { setLoading(false); setLoaded(true) }
    }
  }, [instrument, enabled])
  useEffect(() => {
    setContext(null)
    setLoaded(false)
    setError('')
    if (!enabled) { setLoading(false); return }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => { window.clearInterval(timer); controllerRef.current?.abort(); controllerRef.current = null }
  }, [refresh, enabled])
  return { context, loading, loaded, error, refresh }
}
