import { useEffect, useState } from 'react'
import { getOptionPremiums, type OptionPremiumSnapshot } from '../api/optionPremiums'
import { AngelOneSessionExpiredError } from '../api/angelOneSession'

/** Fetch only the revealed scale for the mounted index; pan requests are debounced. */
export function useOptionPremiums(index: string, strikes: number[], enabled: boolean) {
  const key = `${index}:${strikes.join(',')}`
  const [state, setState] = useState<{ key: string; data?: OptionPremiumSnapshot; loading: boolean; error: string }>({ key: '', loading: false, error: '' })
  useEffect(() => {
    if (!enabled) return
    let stopped = false, timer: number | undefined, controller: AbortController | undefined
    const values = key.slice(key.indexOf(':') + 1).split(',').filter(Boolean).map(Number)
    const update = async () => {
      if (stopped || document.hidden) return
      if (!values.length || values.length > 25) { setState({ key, loading: false, error: 'Zoom in to load premiums for up to 25 visible strikes.' }); return }
      const token = localStorage.getItem('angelone_jwt_token') || ''
      if (!token && !localStorage.getItem('angelone_refresh_token')) { setState({ key, loading: false, error: 'Log in to Angel One to load option premiums.' }); return }
      controller = new AbortController()
      const current = controller, timeout = window.setTimeout(() => current.abort(), 55_000)
      setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, loading: true, error: '' }))
      let next: number | undefined = 15_000
      try {
        const data = await getOptionPremiums(index, values, token, current.signal)
        if (!stopped && controller === current && !current.signal.aborted) setState({ key, data, loading: false, error: '' })
      } catch (error) {
        next = error instanceof AngelOneSessionExpiredError ? undefined : 30_000
        if (!stopped && controller === current && !document.hidden) setState({ key, loading: false, error: current.signal.aborted ? 'Option quote request timed out.' : error instanceof Error ? error.message : 'Option premiums are unavailable.' })
      } finally {
        window.clearTimeout(timeout)
        if (!stopped && controller === current) {
          controller = undefined
          if (!document.hidden && next !== undefined) timer = window.setTimeout(update, next)
        }
      }
    }
    const visibility = () => {
      window.clearTimeout(timer)
      if (document.hidden) { controller?.abort(); controller = undefined }
      else timer = window.setTimeout(update, 350)
    }
    const authChanged = (event: Event) => {
      if (!(event instanceof CustomEvent && event.detail?.reason === 'token-refresh')) { controller?.abort(); controller = undefined }
      if (!controller && !document.hidden) { window.clearTimeout(timer); timer = window.setTimeout(update, 350) }
    }
    timer = window.setTimeout(update, 350)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('angelone-auth-changed', authChanged)
    return () => { stopped = true; window.clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('angelone-auth-changed', authChanged) }
  }, [enabled, index, key])
  const current = state.key === key ? state : { loading: enabled, error: '', data: undefined }
  const fresh = current.data && Date.now() - Date.parse(current.data.fetchedAt) <= 30_000 && Date.parse(`${current.data.expiry}T15:30:00+05:30`) > Date.now()
  return { ...current, data: fresh ? current.data : undefined }
}
