import { predictionHistoryKey, readPredictionHistory, writePredictionHistory, type PredictionRecord } from '../analysis/predictionHistory'

export type HistoryUpdate = { previous: PredictionRecord[]; records: PredictionRecord[]; changed: boolean; durable: boolean; error?: string }
export type HistoryBackend = {
  transact: (update: (saved: string | undefined) => string) => Promise<string>
  read: () => Promise<string | undefined>
}
const encode = (records: PredictionRecord[]) => JSON.stringify({ version: 1, records })
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
  const stamp = (r: PredictionRecord) => Math.max(r.observedThrough, r.latestPriceAt ?? 0, r.exitAt ?? 0, r.earlyExitAcknowledgedAt ?? 0, r.generatedAt)
  for (const record of incoming) {
    const other = combined.get(record.id)
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
  async function initialize() {
    if (loaded) return
    if (!initialization) initialization = (async () => {
      const legacyRaw = storage.getItem(predictionHistoryKey), legacy = decode(legacyRaw)
      if (backend) {
        try {
          const raw = await backend.transact(saved => {
            const existing = decode(saved)
            return encode(mergeSnapshots(existing, legacy))
          })
          memory = decode(raw)
          if (legacyRaw !== null && storage.getItem(predictionHistoryKey) === legacyRaw) { try { storage.removeItem(predictionHistoryKey) } catch { /* The committed database is already authoritative. */ } }
          loaded = true; return
        } catch (error) {
          // Never silently replace an unreadable database with an empty legacy ledger.
          if (error instanceof HistoryDataError || !legacyRaw) throw error
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
    load: () => serial(async () => { await initialize(); if (!dirty && !volatile && backend) { try { memory = mergeSnapshots(decode(await backend.read()), decode(storage.getItem(predictionHistoryKey))) } catch { /* Preserve already loaded records during temporary read failures. */ } } else if (!backend && !volatile) memory = decode(storage.getItem(predictionHistoryKey)); return memory! }),
    update: (update: (records: PredictionRecord[]) => PredictionRecord[]) => serial(async (): Promise<HistoryUpdate> => {
      await initialize()
      let previous = !backend && !volatile ? decode(storage.getItem(predictionHistoryKey)) : memory!, next = previous
      if (backend && !dirty && !volatile) {
        let result: HistoryUpdate | undefined, calculationError: unknown, legacyUsed: string | null = null
        try {
          await backend.transact(saved => {
            legacyUsed = storage.getItem(predictionHistoryKey)
            previous = mergeSnapshots(decode(saved), decode(legacyUsed)); try { next = update(previous) } catch (error) { calculationError = error; throw error }
            const before = encode(previous), after = encode(next)
            result = { previous, records: next, changed: before !== after, durable: true }
            return after
          })
          memory = next
          if (legacyUsed && storage.getItem(predictionHistoryKey) === legacyUsed) { try { storage.removeItem(predictionHistoryKey) } catch { /* Already committed to IndexedDB. */ } }
          return result!
        } catch (error) {
          if (error instanceof HistoryDataError || calculationError) throw calculationError || error
          if (!result) { previous = memory!; next = update(previous) }
          dirty = true; retryAt = now() + 15000
        }
      } else { next = update(previous) }
      const changed = encode(previous) !== encode(next)
      memory = next
      if (!changed && !volatile) return { previous, records: next, changed: false, durable: true }
      if (volatile && now() < retryAt) return { previous, records: next, changed, durable: false, error: storageMessage }
      // If disk writes recover, combine unflushed entries with newer cross-tab records.
      if (backend && now() >= retryAt) {
        try {
          await backend.transact(saved => {
            next = mergeSnapshots(mergeSnapshots(decode(saved), decode(storage.getItem(predictionHistoryKey))), next); return encode(next)
          })
          memory = next; volatile = false; dirty = false
          if (lastFallback && storage.getItem(predictionHistoryKey) === lastFallback) { try { storage.removeItem(predictionHistoryKey) } catch { /* Database commit is durable. */ } }
          lastFallback = undefined
          return { previous, records: next, changed, durable: true }
        } catch (error) { if (error instanceof HistoryDataError) throw error; retryAt = now() + 15000 }
      }
      try { writePredictionHistory(storage, next); lastFallback = encode(next); volatile = false; return { previous, records: next, changed, durable: true } }
      catch { volatile = true; retryAt = now() + 15000; return { previous, records: next, changed, durable: false, error: storageMessage } }
    }),
  }
}
