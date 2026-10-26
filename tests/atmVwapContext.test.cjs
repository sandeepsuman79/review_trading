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


test('last-session display data never becomes a current-day signal even just after midnight', () => {
 const time = Date.parse('2026-10-17T00:00:30+05:30')
 const leg = {symbol:'fixture',token:'1',exchange:'NFO',close:90,vwap:100,volume:100,asOf:'2026-10-16T23:59:30+05:30',coverage:'FULL_SESSION'}
 const data = {index:'Nifty 50',strike:22000,expiry:'2026-10-20',fetchedAt:new Date(time).toISOString(),method:'SESSION_HLC3_VOLUME',referenceIndexPrice:22000,ce:leg,pe:{...leg,close:110}}
 assert.equal(atmVwapBias(data,'Nifty 50',22000,time),undefined)
})

test('chart and agent requests share ATM candles and isolate strikes, indices and broker sessions', async () => {
 const {getSharedAtmVwap} = require('../src/api/atmVwap.ts')
 const originalFetch = global.fetch, originalStorage = global.localStorage
 let auth = 'A', calls = 0
 global.localStorage = {getItem:()=>auth}
 global.fetch = async (_url, options) => {
  calls++
  const {index,price} = JSON.parse(options.body)
  const leg = {symbol:'fixture',token:'1',exchange:index==='Sensex'?'BFO':'NFO',close:90,vwap:100,volume:100,asOf:new Date(now).toISOString(),coverage:'FULL_SESSION'}
  return {ok:true,status:200,json:async()=>({index,strike:Math.round(price/(index==='Nifty 50'?50:100))*(index==='Nifty 50'?50:100),expiry:'2026-10-20',fetchedAt:new Date(now).toISOString(),method:'SESSION_HLC3_VOLUME',referenceIndexPrice:price,ce:leg,pe:{...leg,close:110}})}
 }
 try {
  const [a,b] = await Promise.all([getSharedAtmVwap('Nifty 50',22001,now),getSharedAtmVwap('Nifty 50',22002,now)])
  assert.deepEqual(a,b);assert.equal(calls,1)
  await getSharedAtmVwap('Nifty 50',22051,now);assert.equal(calls,2)
  await getSharedAtmVwap('Sensex',74000,now);assert.equal(calls,3)
  auth='B';await getSharedAtmVwap('Nifty 50',22001,now);assert.equal(calls,4)
 } finally { global.fetch=originalFetch;global.localStorage=originalStorage }
})

test('ATM context requires the exact current strike and fresh valid broker timestamps', () => {
 const leg={symbol:'fixture',token:'1',exchange:'NFO',close:110,vwap:100,volume:600,asOf:new Date(now).toISOString(),coverage:'FULL_SESSION'}
 const snapshot={index:'Nifty 50',strike:22000,expiry:'2026-10-20',fetchedAt:new Date(now).toISOString(),method:'BROKER_AVERAGE_PRICE',referenceIndexPrice:22000,ce:leg,pe:{...leg,close:90}}
 assert.equal(atmVwapBias(snapshot,'Nifty 50',22020,now),'BULLISH')
 assert.equal(atmVwapBias(snapshot,'Nifty 50',22030,now),undefined)
 for(const patch of [{fetchedAt:'invalid'},{expiry:'invalid'},{ce:{...leg,asOf:null}},{ce:{...leg,volume:0}},{ce:{...leg,vwap:NaN}},{ce:{...leg,priceAsOf:null}},{ce:{...leg,priceAsOf:new Date(now-120000).toISOString()}}])assert.equal(atmVwapBias({...snapshot,...patch},'Nifty 50',22000,now),undefined)
})
test('frontend shares pending ATM requests across heartbeat/minute boundaries and refreshes completed results', async () => {
 const {getSharedAtmVwap}=require('../src/api/atmVwap.ts')
 const oldFetch=global.fetch,oldStorage=global.localStorage
 let calls=0,release
 global.localStorage={getItem:()=> 'pending-regression'}
 global.fetch=async()=>{
  calls++;if(calls===1)await new Promise(resolve=>{release=resolve})
  const leg={symbol:'fixture',token:'1',exchange:'NFO',close:110,vwap:100,volume:600,asOf:new Date(now).toISOString(),coverage:'FULL_SESSION'}
  return {ok:true,status:200,json:async()=>({index:'Nifty 50',strike:23000,expiry:'2026-10-20',fetchedAt:new Date(now).toISOString(),method:'BROKER_AVERAGE_PRICE',referenceIndexPrice:23000,ce:leg,pe:{...leg,close:90}})}
 }
 try {
  const first=getSharedAtmVwap('Nifty 50',23000,now)
  const later=getSharedAtmVwap('Nifty 50',23000,now+60000)
  assert.equal(first,later);assert.equal(calls,1)
  release();await Promise.all([first,later])
  await getSharedAtmVwap('Nifty 50',23000,now+60000)
  assert.equal(calls,2)
  await getSharedAtmVwap('Nifty 50',23000,now+60001)
  assert.equal(calls,2)
 } finally {global.fetch=oldFetch;global.localStorage=oldStorage}
})
