const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const { atmVwapBias } = require('../src/api/atmVwap.ts')
const now=Date.parse('2026-10-16T13:02:00+05:30')
test('raw ATM volume context rejects partial, stale, distant or wrong-instrument data without running minute technical analysis',()=>{
 const leg=close=>({symbol:'fixture',token:'1',exchange:'NFO',close,vwap:100,volume:100,asOf:new Date(now).toISOString(),coverage:'FULL_SESSION'})
 const snapshot={index:'Nifty 50',strike:22000,expiry:'2026-10-20',fetchedAt:new Date(now).toISOString(),method:'SESSION_HLC3_VOLUME',referenceIndexPrice:22000,ce:leg(90),pe:leg(110)}
 assert.equal(atmVwapBias(snapshot,'Nifty 50',22000,now),'BEARISH')
 assert.equal(atmVwapBias({...snapshot,ce:{...snapshot.ce,coverage:'PARTIAL_SESSION'}},'Nifty 50',22000,now),undefined)
 assert.equal(atmVwapBias(snapshot,'Nifty 50',22000,now+120000),undefined)
 assert.equal(atmVwapBias(snapshot,'Nifty 50',22500,now),undefined)
 assert.equal(atmVwapBias({...snapshot,index:'Gold'},'Gold',22000,now),undefined)
})
