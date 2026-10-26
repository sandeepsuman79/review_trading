import { predictionHistoryKey, readPredictionHistory, writePredictionHistory, type PredictionRecord } from '../analysis/predictionHistory'

export type HistoryUpdate = { previous: PredictionRecord[]; records: PredictionRecord[]; changed: boolean; durable: boolean; error?: string }
export type HistoryBackend = {
  transact: (update: (saved: string | undefined) => string) => Promise<string>
  read: () => Promise<string | undefined>
}
const encode = (records: PredictionRecord[]) => JSON.stringify({ version: 1, records })
export const predictionCheckpointKey = 'traders_prediction_checkpoint_v1'
class HistoryDataError extends Error {}
const decode = (raw?: string | null) => {
  try { return readPredictionHistory({ getItem: () => raw ?? null }) }
  catch (error) { throw new HistoryDataError(error instanceof Error ? error.message : 'Saved trade history is invalid and was preserved.') }
}

/** Native read/write transactions serialize ledger mutations across browser tabs. */
export function indexedHistoryBackend(factory: IDBFactory = indexedDB): HistoryBackend {
  let opening: Promise<IDBDatabase> | undefined
  function open() {
    return opening ||= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('traders_trade_history_v1', 1)
      let abandoned = false
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('history')) request.result.createObjectStore('history') }
      request.onsuccess = () => {
        const db = request.result
        if (abandoned) { db.close(); return }
        db.onversionchange = () => { db.close(); opening = undefined }
        resolve(db)
      }
      request.onerror = () => { opening = undefined; reject(request.error || new Error('Trade database could not be opened.')) }
      request.onblocked = () => { abandoned = true; opening = undefined; reject(new Error('Close older app tabs to finish opening the trade database.')) }
    })
  }
  return {
    async read() {
      const db = await open()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('history', 'readonly'), request = transaction.objectStore('history').get(predictionHistoryKey)
        request.onsuccess = () => resolve(request.result as string | undefined)
        request.onerror = () => reject(request.error)
        transaction.onabort = () => reject(transaction.error)
      })
    },
    async transact(update) {
      const db = await open()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('history', 'readwrite'), store = transaction.objectStore('history'), request = store.get(predictionHistoryKey)
        let result: string, failure: unknown
        request.onsuccess = () => {
          try { result = update(request.result as string | undefined); if (result !== request.result) store.put(result, predictionHistoryKey) }
          catch (error) { failure = error; transaction.abort() }
        }
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () => reject(failure || transaction.error || new Error('Trade database write failed.'))
        transaction.onabort = () => reject(failure || transaction.error || new Error('Trade database write was interrupted.'))
      })
    },
  }
}

function mergeSnapshots(existing: PredictionRecord[], incoming: PredictionRecord[]) {
  const combined = new Map(existing.map(record => [record.id, record]))
  const settled = (record: PredictionRecord) => ['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(record.status)
    && [record.entryAt, record.entryPrice, record.exitAt, record.exitPrice, record.points].every(Number.isFinite)
  const stamp = (r: PredictionRecord) => Math.max(r.observedThrough, r.latestPriceAt ?? 0, r.exitAt ?? 0, r.earlyExitAcknowledgedAt ?? 0, r.generatedAt)
  for (const record of incoming) {
    const other = combined.get(record.id)
    // A recorded exit is stronger evidence than a newer recovery/uncertainty
    // snapshot, in either storage direction. Keep its price, time, P/L and TSL.
    if (other && settled(other) !== settled(record)) {
      if (settled(record)) combined.set(record.id, record)
      continue
    }
    if (other?.exitAt !== undefined && record.exitAt !== undefined) {
      // A later rebound cannot replace an already observed earlier exit from another tab.
      if (record.exitAt > other.exitAt) continue
      if (record.exitAt < other.exitAt) { combined.set(record.id, record); continue }
      if (other.status === 'STOP_LOSS_HIT' && record.status === 'TARGET_HIT') continue
      if (record.status === 'STOP_LOSS_HIT' && other.status === 'TARGET_HIT') { combined.set(record.id, record); continue }
    }
    const terminal = other && !['PENDING', 'ACTIVE'].includes(other.status) && ['PENDING', 'ACTIVE'].includes(record.status)
    if (!other || !terminal && stamp(record) > stamp(other)) combined.set(record.id, record)
  }
  return [...combined.values()]
}

const storageMessage = 'Trade history could not be saved. Live tracking continues in this tab; download a backup before closing it.'
/** Migration commits to IndexedDB before touching the legacy localStorage value. */
export function createPredictionHistoryStore({ backend, storage, now = Date.now }: {
  backend?: HistoryBackend; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; now?: () => number
}) {
  let memory: PredictionRecord[] | undefined, volatile = false, dirty = false, lastFallback: string | undefined, retryAt = 0, initialization: Promise<void> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let loaded = false
  const readFallback = () => mergeSnapshots(decode(storage.getItem(predictionHistoryKey)), decode(storage.getItem(predictionCheckpointKey)))
  // Small write-ahead checkpoints protect entries, trailing levels and exits if
  // the tab closes after a transaction callback but before IndexedDB commits.
  function checkpoint(records = (memory ?? []).filter(record => record.status === 'ACTIVE')) {
    if (!records.length) return true
    try {
      const raw = storage.getItem(predictionCheckpointKey)
      const saved = encode(mergeSnapshots(decode(raw), records))
      if (saved !== raw) storage.setItem(predictionCheckpointKey, saved)
      return true
    } catch (error) { if (error instanceof HistoryDataError) throw error; return false }
  }
  function checkpointChanges(previous: PredictionRecord[], next: PredictionRecord[]) {
    const before = new Map(previous.map(record => [record.id, record]))
    checkpoint(next.filter(record => {
      if (record.entryAt === undefined) return false
      const old = before.get(record.id)
      return !old || old.status !== record.status || old.entryPrice !== record.entryPrice || old.entryAt !== record.entryAt
        || old.exitAt !== record.exitAt || old.exitPrice !== record.exitPrice || old.points !== record.points
        || JSON.stringify(old.protection) !== JSON.stringify(record.protection)
    }))
  }
  function clearCommittedCheckpoints(records: PredictionRecord[]) {
    try {
      const raw = storage.getItem(predictionCheckpointKey)
      if (!raw) return
      const committed = new Map(records.map(record => [record.id, record]))
      const pending = decode(raw).filter(record => {
        const saved = committed.get(record.id)
        return !saved || encode(mergeSnapshots([saved], [record])) !== encode([saved])
      })
      if (storage.getItem(predictionCheckpointKey) !== raw) return
      if (pending.length) storage.setItem(predictionCheckpointKey, encode(pending))
      else storage.removeItem(predictionCheckpointKey)
    } catch { /* Already committed; retain the checkpoint if cleanup is unavailable. */ }
  }
  async function initialize() {
    if (loaded) return
    if (!initialization) initialization = (async () => {
      const legacyRaw = storage.getItem(predictionHistoryKey), legacy = readFallback()
      if (backend) {
        try {
          const raw = await backend.transact(saved => {
            const existing = decode(saved)
            return encode(mergeSnapshots(existing, legacy))
          })
          memory = decode(raw)
          clearCommittedCheckpoints(memory)
          if (legacyRaw !== null && storage.getItem(predictionHistoryKey) === legacyRaw) { try { storage.removeItem(predictionHistoryKey) } catch { /* The committed database is already authoritative. */ } }
          loaded = true; return
        } catch (error) {
          // Never silently replace an unreadable database with an empty legacy ledger.
          if (error instanceof HistoryDataError || !legacyRaw && !legacy.length) throw error
          dirty = true; retryAt = now() + 15000
        }
      }
      memory = legacy; lastFallback = legacyRaw ?? undefined; loaded = true
    })().catch(error => { initialization = undefined; throw error })
    return initialization
  }
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task)
    queue = next.catch(() => {})
    return next
  }
  return {
    checkpoint: () => checkpoint(),
    load: () => serial(async () => { await initialize(); if (!dirty && !volatile && backend) { try { memory = mergeSnapshots(decode(await backend.read()), readFallback()) } catch { /* Preserve already loaded records during temporary read failures. */ } } else if (!backend && !volatile) memory = readFallback(); return memory! }),
    update: (update: (records: PredictionRecord[]) => PredictionRecord[]) => serial(async (): Promise<HistoryUpdate> => {
      await initialize()
      let previous = !backend && !volatile ? readFallback() : memory!, next = previous
      if (backend && !dirty && !volatile) {
        let result: HistoryUpdate | undefined, calculationError: unknown, legacyUsed: string | null = null
        try {
          await backend.transact(saved => {
            legacyUsed = storage.getItem(predictionHistoryKey)
            previous = mergeSnapshots(decode(saved), readFallback()); try { next = update(previous) } catch (error) { calculationError = error; throw error }
            checkpointChanges(previous, next)
            const before = encode(previous), after = encode(next)
            result = { previous, records: next, changed: before !== after, durable: true }
            return after
          })
          memory = next
          clearCommittedCheckpoints(next)
          if (legacyUsed && storage.getItem(predictionHistoryKey) === legacyUsed) { try { storage.removeItem(predictionHistoryKey) } catch { /* Already committed to IndexedDB. */ } }
          return result!
        } catch (error) {
          if (error instanceof HistoryDataError || calculationError) throw calculationError || error
          if (!result) { previous = memory!; next = update(previous) }
          dirty = true; retryAt = now() + 15000
        }
      } else { next = update(previous) }
      checkpointChanges(previous, next)
      const changed = encode(previous) !== encode(next)
      memory = next
      if (!changed && !volatile) return { previous, records: next, changed: false, durable: true }
      if (volatile && now() < retryAt) return { previous, records: next, changed, durable: false, error: storageMessage }
      // If disk writes recover, combine unflushed entries with newer cross-tab records.
      if (backend && now() >= retryAt) {
        try {
          await backend.transact(saved => {
            next = mergeSnapshots(mergeSnapshots(decode(saved), readFallback()), next); return encode(next)
          })
          memory = next; volatile = false; dirty = false
          clearCommittedCheckpoints(next)
          if (lastFallback && storage.getItem(predictionHistoryKey) === lastFallback) { try { storage.removeItem(predictionHistoryKey) } catch { /* Database commit is durable. */ } }
          lastFallback = undefined
          return { previous, records: next, changed, durable: true }
        } catch (error) { if (error instanceof HistoryDataError) throw error; retryAt = now() + 15000 }
      }
      try { writePredictionHistory(storage, next); lastFallback = encode(next); volatile = false; clearCommittedCheckpoints(next); return { previous, records: next, changed, durable: true } }
      catch { volatile = true; retryAt = now() + 15000; return { previous, records: next, changed, durable: false, error: storageMessage } }
    }),
  }
}
