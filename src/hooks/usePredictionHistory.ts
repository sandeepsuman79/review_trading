import { createPredictionHistoryStore, indexedHistoryBackend, predictionCheckpointKey } from '../storage/predictionHistoryStore'
import { recordTradeTransitions } from '../analysis/agentMonitoring'
import type { ProtectionAssessment } from '../analysis/tradeProtection'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PredictionPlan } from '../analysis/earlyPrediction'
import { isOpenPrediction, reconcilePredictionRecords, registerConfirmedPrediction, syncPredictionRecord, predictionHistoryKey, type PredictionRecord } from '../analysis/predictionHistory'
import { predictionEvents, type PredictionEvent } from '../analysis/predictionEvents'
import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'

type Observation = { candles: AngelOneCandle[]; tick?: AngelOneStreamTick }

export function usePredictionHistory(onError: (message: string) => void, onEvents: (events: PredictionEvent[]) => void) {
  const [records, setRecords] = useState<PredictionRecord[]>([])
  const [storageError, setStorageError] = useState('')
  const lastError = useRef('')
  const eventHandler = useRef(onEvents)
  eventHandler.current = onEvents
  const report = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unable to save prediction history in this browser.'
    setStorageError(message)
    if (message !== lastError.current) onError(message)
    lastError.current = message
  }, [onError])

  const store = useRef<ReturnType<typeof createPredictionHistoryStore>>()
  const channel = useRef<BroadcastChannel>()
  const mounted = useRef(true)
  const getStore = useCallback(() => {
    return store.current ||= createPredictionHistoryStore({ storage: localStorage, ...(typeof indexedDB === 'undefined' ? {} : { backend: indexedHistoryBackend(indexedDB) }) })
  }, [])
  const mutate = useCallback((update: (current: PredictionRecord[]) => PredictionRecord[]) => {
    try {
      void getStore().update(update).then(result => {
        if (!mounted.current) return
        if (result.changed) {
          recordTradeTransitions(result.previous, result.records, Date.now())
          const events = predictionEvents(result.previous, result.records, Date.now())
          if (events.length) eventHandler.current(events)
          if (result.durable) channel.current?.postMessage('updated')
        }
        setRecords(existing => JSON.stringify(existing) === JSON.stringify(result.records) ? existing : result.records)
        if (result.error) report(new Error(result.error))
        else { setStorageError(''); lastError.current = '' }
      }).catch(report)
    } catch (error) { report(error) }
  }, [getStore, report])

  useEffect(() => {
    mounted.current = true
    const load = () => {
      try {
        void getStore().load().then(saved => { if (mounted.current) setRecords(reconcilePredictionRecords(saved)) }).catch(report)
      } catch (error) { report(error) }
    }
    load()
    if (typeof BroadcastChannel !== 'undefined') {
      try { channel.current = new BroadcastChannel('traders_prediction_history'); channel.current.onmessage = load } catch { /* Atomic database writes still prevent overlapping ledger updates. */ }
    }
    const receive = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === predictionHistoryKey || event.key === predictionCheckpointKey || event.key === null)) load() }
    const checkpoint = () => { try { store.current?.checkpoint() } catch (error) { report(error) } }
    const onVisibility = () => { if (document.visibilityState === 'hidden') checkpoint() }
    window.addEventListener('storage', receive)
    window.addEventListener('focus', load)
    window.addEventListener('pagehide', checkpoint)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { checkpoint(); mounted.current = false; channel.current?.close(); channel.current = undefined; window.removeEventListener('storage', receive); window.removeEventListener('focus', load); window.removeEventListener('pagehide', checkpoint); document.removeEventListener('visibilitychange', onVisibility) }
  }, [getStore, report])

  const recordPrediction = useCallback((plan: PredictionPlan) => {
    mutate(current => registerConfirmedPrediction(current, plan, Date.now()))
  }, [mutate])

  const sync = useCallback((observe: (record: PredictionRecord) => Observation, now: number, confirmEntry?: (record: PredictionRecord) => PredictionPlan | undefined, confirmReversal?: (record: PredictionRecord) => PredictionPlan | undefined, reviewProtection?: (record: PredictionRecord) => ProtectionAssessment | undefined) => {
    mutate(current => { const observedNow = Math.max(now, Date.now()); return reconcilePredictionRecords(current).map(record => {
      if (!isOpenPrediction(record)) return record
      const { candles, tick } = observe(record)
      const plan = confirmEntry?.(record)
      return syncPredictionRecord(record, candles, tick, observedNow, confirmEntry ? Boolean(plan) : true, plan, confirmReversal ? confirmReversal(record) ?? null : undefined, reviewProtection?.(record))
    }) })
  }, [mutate])

  const syncTick = useCallback((instrument: string, tick: AngelOneStreamTick, candlesFor: (record: PredictionRecord) => AngelOneCandle[], now: number, confirmEntry?: (record: PredictionRecord) => PredictionPlan | undefined, confirmReversal?: (record: PredictionRecord) => PredictionPlan | undefined, reviewProtection?: (record: PredictionRecord) => ProtectionAssessment | undefined) => {
    mutate(current => { const observedNow = Math.max(now, Date.now()); return reconcilePredictionRecords(current).map(record => {
      if (record.instrument !== instrument || !isOpenPrediction(record)) return record
      if (record.contract && (record.contract.token !== tick.token || tick.exchangeType !== 5)) return record
      const plan = confirmEntry?.(record)
      return syncPredictionRecord(record, candlesFor(record), tick, observedNow, confirmEntry ? Boolean(plan) : true, plan, confirmReversal ? confirmReversal(record) ?? null : undefined, reviewProtection?.(record))
    }) })
  }, [mutate])
  return { records, storageError, recordPrediction, sync, syncTick }
}
