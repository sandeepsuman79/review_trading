import { useEffect, useRef, useState } from 'react'
import { getNewsAssessment, newsAssessmentKey, type AiProviderStatus, type NewsAssessment } from '../api/ai'
import type { MarketContext, MarketOutlook } from '../api/marketContext'

export function useNewsAssessment(context: MarketContext | null, now: number) {
  const key = newsAssessmentKey(context, now)
  const latest = useRef(context); latest.current = context
  const [saved, setSaved] = useState<{ key: string; value: NewsAssessment }>()
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!key || !latest.current) return
    const controller = new AbortController()
    const instrument = latest.current.instrument
    const timer = window.setTimeout(() => controller.abort(), 45_000)
    let mounted = true
    setLoading(true); setFailure('')
    void getNewsAssessment(instrument, controller.signal).then(value => {
      if (mounted) setSaved({ key: newsAssessmentKey(value.marketContext, Date.now()), value })
    }).catch(() => { if (mounted) setFailure('News assessment is unavailable. Technical evaluation continues.') })
      .finally(() => { window.clearTimeout(timer); if (mounted) setLoading(false) })
    return () => { mounted = false; window.clearTimeout(timer); controller.abort() }
  }, [key, attempt])
  const current = saved?.key === key ? saved.value : undefined
  useEffect(() => {
    const retryAt = Date.parse(current?.providerStatus.retryAt || current?.marketOutlook.assessmentStatus?.retryAt || '')
    if (!latest.current) return
    const delay = failure || Number.isFinite(retryAt) && retryAt <= Date.now() ? 2 * 60_000
      : Number.isFinite(retryAt) ? retryAt - Date.now() + 1000 : 30 * 60_000
    const timer = window.setTimeout(() => setAttempt(value => value + 1), delay)
    return () => window.clearTimeout(timer)
  }, [current?.providerStatus.retryAt, current?.marketOutlook.assessmentStatus?.retryAt, key, context?.instrument, failure, attempt])
  // Rebind unchanged headline ratings after an OI/global revision without another model call.
  const outlook: MarketOutlook | undefined = current && context ? { ...current.marketOutlook, contextRevision: context.revision, contextRetrievedAt: context.retrievedAt } : undefined
  const providerStatus: AiProviderStatus | undefined = failure ? undefined : current?.providerStatus
  return { outlook, providerStatus, loading, message: failure || outlook?.assessmentStatus?.message || '', refresh: () => setAttempt(value => value + 1) }
}
