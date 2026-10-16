import { useCallback, useEffect, useRef, useState } from 'react'
import { getIndiaVix, type IndiaVixSnapshot } from '../api/marketContext'
import { getAngelOneLtp } from '../api/angelOne'
import { angelIndiaVixSnapshot, type IndiaVixInstrument } from '../analysis/indiaVix'

export function useIndiaVix(instrument?: IndiaVixInstrument) {
  const [snapshot, setSnapshot] = useState<IndiaVixSnapshot>()
  const [loading, setLoading] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    const timeout = window.setTimeout(() => controller.abort(), 30_000)
    try {
      let quote: IndiaVixSnapshot | undefined
      const token = localStorage.getItem('angelone_jwt_token')
      if (instrument && token) {
        const brokerController = new AbortController()
        const cancelBroker = () => brokerController.abort()
        controller.signal.addEventListener('abort', cancelBroker, { once: true })
        const brokerTimeout = window.setTimeout(cancelBroker, 7_000)
        try { quote = angelIndiaVixSnapshot(await getAngelOneLtp(token, instrument, brokerController.signal), instrument, Date.now()) }
        catch { if (controller.signal.aborted) return }
        finally { window.clearTimeout(brokerTimeout); controller.signal.removeEventListener('abort', cancelBroker) }
      }
      quote ??= await getIndiaVix(controller.signal)
      if (!controller.signal.aborted) setSnapshot(quote)
    } catch (cause) {
      if (controllerRef.current === controller) setSnapshot(previous => ({
        status: previous?.data ? 'STALE' : 'UNAVAILABLE',
        data: previous?.data || null,
        fetchedAt: previous?.fetchedAt || null,
        sourceUrl: previous?.sourceUrl || 'https://www.nseindia.com/static/products-services/indices-indiavix-index',
        message: cause instanceof Error ? cause.message : 'India VIX source unavailable.',
      }))
    } finally {
      window.clearTimeout(timeout)
      if (controllerRef.current === controller) setLoading(false)
    }
  }, [instrument])
  useEffect(() => {
    void refresh()
    const onAuth = () => { void refresh() }
    window.addEventListener('angelone-auth-changed', onAuth)
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => { window.clearInterval(timer); window.removeEventListener('angelone-auth-changed', onAuth); controllerRef.current?.abort(); controllerRef.current = null }
  }, [refresh])
  return { snapshot, loading, refresh }
}
