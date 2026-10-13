import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { newsRuntimePath, startNewsWorker } from './localNews.js'

// Only explicit setup downloads a model/runtime. Ordinary server inference stays offline.
if (!newsRuntimePath()) {
  console.log('Preparing a supported runtime in .cache/news-runtime for local inference…')
  const installed = spawnSync('npm', ['install', '--prefix', resolve('.cache/news-runtime'), '--save-exact', 'node@22'], { stdio: 'inherit' })
  if (installed.status !== 0) process.exit(1)
}
const runtime = newsRuntimePath()
const dependencies = spawnSync(runtime, ['--input-type=module', '-e', 'await import("@huggingface/transformers")'], { stdio: 'ignore', timeout: 30_000 })
if (dependencies.status !== 0) {
  if (!process.env.npm_execpath) { console.error('Please run npm run news:setup to prepare native classifier dependencies.'); process.exit(1) }
  console.log('Preparing optional native classifier dependencies with the supported runtime…')
  const installed = spawnSync(runtime, [process.env.npm_execpath, 'install', '--include=optional'], { stdio: 'inherit' })
  if (installed.status !== 0) process.exit(1)
}
console.log('Preparing the quantized FinBERT classifier in .cache/models…')
const child = startNewsWorker(resolve('.cache/models'), true)
let completed = false
const timer = setTimeout(() => { console.error('Local model setup timed out.'); child.kill(); process.exitCode = 1 }, 5 * 60_000)
child.on('message', message => {
  if (message.ready) child.send({ id: 1, articles: [{ id: 'smoke', title: 'The company reported a strong increase in profits.' }] })
  else { completed = true; clearTimeout(timer); if (message.error) { console.error(message.error); process.exitCode = 1 } else console.log(`Local classifier ready: ${message.results[0].sentiment} (text sentiment only).`); child.kill() }
})
child.on('error', error => { clearTimeout(timer); console.error(`Model setup failed: ${error.message}`); process.exitCode = 1 })
child.on('exit', () => { clearTimeout(timer); if (!completed) { console.error('Local model setup did not complete.'); process.exitCode = 1 } })
