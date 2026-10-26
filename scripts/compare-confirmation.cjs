#!/usr/bin/env node
// Offline diagnostic comparison; never connect to a broker or tune rules from the result.
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const args = process.argv.slice(2)
if (args.length !== 1 && !(args.length === 3 && args[1] === '--output')) {
  process.stderr.write('Usage: node scripts/compare-confirmation.cjs candles.json [--output report.json]\n'); process.exit(1)
}
try {
  const source = path.resolve(args[0])
  if (!fs.statSync(source).isFile() || fs.statSync(source).size > 5 * 1024 * 1024) throw new Error('Input must be JSON no larger than 5 MB.')
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
  const { replayStrategy, evaluateReplaySetup, evaluateReplayLegacySetup, evaluateReplayFixedSetup } = require('../src/analysis/strategyReplay.ts')
  const input = JSON.parse(fs.readFileSync(source, 'utf8'))
  const legacy = replayStrategy(input, evaluateReplayLegacySetup), fixed = replayStrategy(input, evaluateReplayFixedSetup), revised = replayStrategy(input, evaluateReplaySetup)
  const report = JSON.stringify({ version: 2, instrument: input.instrument, legacy, fixed, revised,
    warning: 'Same fixed-target comparison exit model and supplied costs for legacy, fixed-v2 and adaptive-v3 entries. Live open-profit TSL is not simulated. Missing historical ATM snapshots cannot be replaced by current data. This is a diagnostic, not an out-of-sample performance claim or automatic parameter optimisation.' }, null, 2) + '\n'
  if (args[2]) { if (path.resolve(args[2]) === source) throw new Error('Output must differ from input.'); fs.writeFileSync(args[2], report, { flag: 'wx' }) }
  else process.stdout.write(report)
} catch (error) { process.stderr.write(`Comparison failed: ${error.message}\n`); process.exitCode = 1 }
