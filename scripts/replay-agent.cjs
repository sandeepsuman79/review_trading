#!/usr/bin/env node
// Offline only: transpile the project's TypeScript in memory; never contact a broker.
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const args = process.argv.slice(2)
if (args.length < 1 || args.length > 3 || args.length === 2 || args.length === 3 && args[1] !== '--output') {
  process.stderr.write('Usage: node scripts/replay-agent.cjs candles.json [--output report.json]\n')
  process.exit(1)
}
try {
  const source = path.resolve(args[0])
  if (!fs.statSync(source).isFile() || fs.statSync(source).size > 5 * 1024 * 1024) throw new Error('Input must be a JSON file no larger than 5 MB.')
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
  const { replayStrategy } = require('../src/analysis/strategyReplay.ts')
  const report = JSON.stringify(replayStrategy(JSON.parse(fs.readFileSync(source, 'utf8'))), null, 2) + '\n'
  if (args[2]) {
    if (path.resolve(args[2]) === source) throw new Error('Output must differ from input.')
    // An existing result is never silently overwritten.
    fs.writeFileSync(args[2], report, { flag: 'wx' })
    process.stderr.write(`Replay report saved to ${args[2]}\n`)
  } else process.stdout.write(report)
} catch (error) {
  process.stderr.write(`Replay failed: ${error.message}\n`)
  process.exitCode = 1
}
