import { useCallback, useEffect, useRef, useState } from 'react'
import type { PredictionPlan } from '../analysis/earlyPrediction'
import { acknowledgePredictionEarlyExit, createPredictionRecord, exitPredictionEarly, isOpenPrediction, syncPredictionRecord, predictionHistoryKey, readPredictionHistory, writePredictionHistory, type PredictionRecord } from '../analysis/predictionHistory'
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
        const events = predictionEvents(current, next)
        if (events.length) eventHandler.current(events)
      }
      setRecords(existing => JSON.stringify(existing) === JSON.stringify(next) ? existing : next)
      setStorageError('')
      lastError.current = ''
    } catch (error) { report(error) }
  }, [report])

  useEffect(() => {
    const load = () => {
      try { setRecords(readPredictionHistory(localStorage)); setStorageError(''); lastError.current = '' } catch (error) { report(error) }
    }
    load()
    const receive = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === predictionHistoryKey || event.key === null)) load() }
    window.addEventListener('storage', receive)
    return () => window.removeEventListener('storage', receive)
  }, [report])

  const recordPrediction = useCallback((plan: PredictionPlan) => {
    mutate(current => current.some(record => record.id === plan.id) ? current : [...current, createPredictionRecord(plan)])
  }, [mutate])

  const sync = useCallback((observe: (record: PredictionRecord) => Observation, now: number) => {
    mutate(current => current.map(record => {
      if (!isOpenPrediction(record)) return record
      const { candles, tick } = observe(record)
      return syncPredictionRecord(record, candles, tick, now)
    }))
  }, [mutate])

  const syncTick = useCallback((instrument: string, tick: AngelOneStreamTick, candlesFor: (record: PredictionRecord) => AngelOneCandle[], now: number) => {
    mutate(current => current.map(record => record.instrument === instrument && isOpenPrediction(record)
      ? syncPredictionRecord(record, candlesFor(record), tick, now) : record))
  }, [mutate])

  const exitEarly = useCallback((id: string) => {
    let rejection = ''
    mutate(current => current.map(record => {
      if (record.id !== id) return record
      const next = exitPredictionEarly(record, Date.now(), 'MANUAL', 'Exited early by user at the last observed live index quote.')
      if (next === record) rejection = 'Early exit needs an active call and a live quote from the last 30 seconds.'
      return next
    }))
    if (rejection) onError(rejection)
  }, [mutate, onError])

  const acknowledgeEarlyExit = useCallback((id: string) => {
    mutate(current => current.map(record => record.id === id ? acknowledgePredictionEarlyExit(record, Date.now()) : record))
  }, [mutate])

  return { records, storageError, recordPrediction, sync, syncTick, exitEarly, acknowledgeEarlyExit }
}
