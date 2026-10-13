import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function newsRuntimePath() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major > 20 || major === 20 && minor >= 9) return process.execPath
  const cached = resolve('.cache/news-runtime/node_modules/node/bin/node')
  return existsSync(cached) ? cached : undefined
}

export function startNewsWorker(cacheDir, download = false) {
  const runtime = newsRuntimePath()
  if (!runtime) throw new Error('Run npm run news:setup to prepare the optional local classifier runtime.')
  return fork(fileURLToPath(new URL('./localNewsWorker.js', import.meta.url)), [], {
    execPath: runtime, execArgv: [], stdio: ['ignore', 'ignore', download ? 'inherit' : 'ignore', 'ipc'],
    env: { PATH: process.env.PATH, NEWS_WORKER_CONFIG: JSON.stringify({ cacheDir, download }) },
  })
}

/** Inference runs outside the API process and only loads already downloaded files. */
export function createLocalNewsClassifier({ enabled = 'auto', cacheDir = resolve('.cache/models'), now = Date.now } = {}) {
  let worker, starting, failedUntil = 0, sequence = 0, queue = Promise.resolve()
  const jobs = new Map()
  function reset() {
    const previous = worker; worker = undefined; starting = undefined; previous?.kill()
    failedUntil = now() + 10 * 60_000
    for (const job of jobs.values()) job.reject(new Error('Local classifier unavailable'))
    jobs.clear()
  }
  function start() {
    if (!starting) starting = new Promise((resolveReady, reject) => {
      const child = startNewsWorker(cacheDir); worker = child; child.unref()
      const timer = setTimeout(() => { reject(new Error('Local loading timed out')); reset() }, 20_000)
      child.on('message', message => {
        if (message.ready) { clearTimeout(timer); resolveReady() }
        else { const job = jobs.get(message.id); if (job) { jobs.delete(message.id); message.error ? job.reject(new Error(message.error)) : job.resolve(message.results) } }
      })
      const failed = () => { clearTimeout(timer); reject(new Error('Local classifier unavailable')); if (worker === child) reset() }
      child.on('error', failed); child.on('exit', failed)
    })
    return starting
  }
  async function run(articles) {
    if (enabled === 'off' || failedUntil > now() || !articles.length || !newsRuntimePath()) return []
    try {
      await start()
      return await new Promise((resolveResult, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => { reject(new Error('Local inference timed out')); reset() }, 15_000)
        jobs.set(id, { resolve: result => { clearTimeout(timer); resolveResult(result) }, reject: error => { clearTimeout(timer); reject(error) } })
        worker.send({ id, articles })
      })
    } catch { return [] }
  }
  return { classify(articles) { const result = queue.then(() => run(articles)); queue = result.catch(() => {}); return result }, close() { reset() } }
}
