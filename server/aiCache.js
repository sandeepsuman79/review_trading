import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Stores public headline assessments and provider cooldown only; never keys, prompts or credentials. */
export function createAiCache(file) {
  let saved = {}
  try { if (file && existsSync(file) && statSync(file).size <= 2_000_000) saved = JSON.parse(readFileSync(file, 'utf8')) } catch { /* A corrupt cache cannot stop chart evaluation. */ }
  const store = { entries: new Map(saved.version === 1 && Array.isArray(saved.entries) ? saved.entries.filter(item => Array.isArray(item) && typeof item[0] === 'string').slice(-1000) : []), providerState: saved.version === 1 ? saved.providerState : undefined }
  let writes = Promise.resolve()
  const save = () => {
    if (!file) return
    while (store.entries.size > 1000) store.entries.delete(store.entries.keys().next().value)
    const data = JSON.stringify({ version: 1, entries: [...store.entries], providerState: store.providerState })
    writes = writes.catch(() => {}).then(async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, data, { mode: 0o600 }); await rename(`${file}.tmp`, file)
    })
    writes.catch(() => {}) // Disk problems disable persistence, not technical trading.
  }
  return Object.assign(store, { save, flush: () => writes })
}
