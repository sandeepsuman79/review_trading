import { recordTradeTransitions } from '../analysis/agentMonitoring'
import type { ProtectionAssessment } from '../analysis/tradeProtection'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PredictionPlan } from '../analysis/earlyPrediction'
import { isOpenPrediction, reconcilePredictionRecords, registerConfirmedPrediction, syncPredictionRecord, predictionHistoryKey, readPredictionHistory, writePredictionHistory, type PredictionRecord } from '../analysis/predictionHistory'
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

  const mutate = useCallback((update: (current: PredictionRecord[]) => PredictionRecord[]) => {
    try {
      // Read the latest persisted value before every write, including changes from another tab.
      const current = readPredictionHistory(localStorage)
      const next = update(current)
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        writePredictionHistory(localStorage, next)
        recordTradeTransitions(current, next, Date.now())
        const events = predictionEvents(current, next, Date.now())
        if (events.length) eventHandler.current(events)
      }
      setRecords(existing => JSON.stringify(existing) === JSON.stringify(next) ? existing : next)
      setStorageError('')
      lastError.current = ''
    } catch (error) { report(error) }
  }, [report])

  useEffect(() => {
    const load = () => {
      try { setRecords(reconcilePredictionRecords(readPredictionHistory(localStorage))); setStorageError(''); lastError.current = '' } catch (error) { report(error) }
    }
    load()
    const receive = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === predictionHistoryKey || event.key === null)) load() }
    window.addEventListener('storage', receive)
    return () => window.removeEventListener('storage', receive)
  }, [report])

  const recordPrediction = useCallback((plan: PredictionPlan) => {
    mutate(current => registerConfirmedPrediction(current, plan, Date.now()))
  }, [mutate])

  const sync = useCallback((observe: (record: PredictionRecord) => Observation, now: number, confirmEntry?: (record: PredictionRecord) => PredictionPlan | undefined, confirmReversal?: (record: PredictionRecord) => PredictionPlan | undefined, reviewProtection?: (record: PredictionRecord) => ProtectionAssessment | undefined) => {
    mutate(current => reconcilePredictionRecords(current).map(record => {
      if (!isOpenPrediction(record)) return record
      const { candles, tick } = observe(record)
      const plan = confirmEntry?.(record)
      return syncPredictionRecord(record, candles, tick, now, confirmEntry ? Boolean(plan) : true, plan, confirmReversal ? confirmReversal(record) ?? null : undefined, reviewProtection?.(record))
    }))
  }, [mutate])

  const syncTick = useCallback((instrument: string, tick: AngelOneStreamTick, candlesFor: (record: PredictionRecord) => AngelOneCandle[], now: number, confirmEntry?: (record: PredictionRecord) => PredictionPlan | undefined, confirmReversal?: (record: PredictionRecord) => PredictionPlan | undefined, reviewProtection?: (record: PredictionRecord) => ProtectionAssessment | undefined) => {
    mutate(current => reconcilePredictionRecords(current).map(record => {
      if (record.instrument !== instrument || !isOpenPrediction(record)) return record
      if (record.contract && (record.contract.token !== tick.token || tick.exchangeType !== 5)) return record
      const plan = confirmEntry?.(record)
      return syncPredictionRecord(record, candlesFor(record), tick, now, confirmEntry ? Boolean(plan) : true, plan, confirmReversal ? confirmReversal(record) ?? null : undefined, reviewProtection?.(record))
    }))
  }, [mutate])
  return { records, storageError, recordPrediction, sync, syncTick }
}
