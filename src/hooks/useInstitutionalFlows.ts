import { useEffect, useState } from 'react'
import type { InstitutionalFlow, PublicSnapshot } from '../api/marketContext'
import { flowHistoryKey, observedFlows } from '../analysis/marketDashboard'

export function useInstitutionalFlows(snapshot?: PublicSnapshot<InstitutionalFlow>) {
  const [history, setHistory] = useState<InstitutionalFlow[]>(() => {
    try { return observedFlows(JSON.parse(localStorage.getItem(flowHistoryKey) || '[]')) } catch { return [] }
  })
  const [storageError, setStorageError] = useState(false)
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== flowHistoryKey) return
      try { setHistory(observedFlows(JSON.parse(event.newValue || '[]'))) } catch { setStorageError(true) }
    }
    window.addEventListener('storage', receive)
    return () => window.removeEventListener('storage', receive)
  }, [])
  useEffect(() => {
    if (snapshot?.status !== 'AVAILABLE' || !snapshot.data) return
    try {
      const saved = localStorage.getItem(flowHistoryKey) || '[]'
      const next = observedFlows(JSON.parse(saved), snapshot.data)
      if (JSON.stringify(next) !== saved) localStorage.setItem(flowHistoryKey, JSON.stringify(next))
      setHistory(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
      setStorageError(false)
    } catch { setStorageError(true) }
  }, [snapshot])
  return { history, storageError }
}
