import { useCallback, useEffect, useRef, useState } from 'react'
import { getMarketContext, type MarketContext } from '../api/marketContext'

export function useMarketContext(instrument: string) {
  const [context, setContext] = useState<MarketContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
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
  }, [instrument])
  useEffect(() => {
    setContext(null)
    setLoaded(false)
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5 * 60_000)
    return () => { window.clearInterval(timer); controllerRef.current?.abort(); controllerRef.current = null }
  }, [refresh])
  return { context, loading, loaded, error, refresh }
}
