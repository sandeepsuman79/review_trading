const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8').replace(/import\.meta\.env\.VITE_ANGELONE_API_KEY/g,'"fixture"'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file)
const {getAtmOptionCandles}=require('../src/api/atmOptionCandles.ts')
const fixture=require('./helpers/atmVwap.cjs')
const now=Date.parse('2026-10-26T11:00:05+05:30'),bar=(time,close,volume)=>[new Date(time).toISOString(),close,close+1,close-1,close,volume]

test('ATM charts fetch actual CE/PE candles for all indices, isolate interval/session/strike and never reuse spot volume',async()=>{
 const oldFetch=global.fetch,oldStorage=global.localStorage
 let auth='chart-A',calls=[]
 global.localStorage={getItem:()=>auth}
 global.fetch=async(_url,options)=>{
  const request=JSON.parse(options.body);calls.push({...request,auth:options.headers.Authorization})
  const rows=request.symboltoken==='1'?[bar(now-600000,120,300),bar(now-300000,125,200)]:[bar(now-600000,90,700),bar(now-300000,85,400)]
  return {ok:true,status:200,json:async()=>({status:true,data:rows})}
 }
 try {
  for(const [index,price] of [['Nifty 50',22000],['Sensex',74000],['Bank Nifty',48000]]) {
   const snapshot=fixture(index,price,now)
   const [first,second]=await Promise.all([getAtmOptionCandles(snapshot,'FIVE_MINUTE',now),getAtmOptionCandles(snapshot,'FIVE_MINUTE',now)])
   assert.deepEqual(first,second)
   assert.equal(first.ce[0][4],120);assert.equal(first.ce[0][5],300);assert.equal(first.pe[0][5],700)
   const recent=calls.slice(-2)
   assert(recent.every(call=>call.exchange===(index==='Sensex'?'BFO':'NFO')))
   assert.deepEqual(recent.map(call=>call.symboltoken).sort(),['1','2'])
  }
  assert.equal(calls.length,6)
  const snapshot=fixture('Nifty 50',22000,now)
  await getAtmOptionCandles(snapshot,'FIFTEEN_MINUTE',now);assert.equal(calls.length,8)
  auth='chart-B';await getAtmOptionCandles(snapshot,'FIVE_MINUTE',now);assert.equal(calls.length,10)
  await getAtmOptionCandles({...snapshot,strike:22050,ce:{...snapshot.ce,token:'101'},pe:{...snapshot.pe,token:'102'}},'FIVE_MINUTE',now);assert.equal(calls.length,12)
 }finally{global.fetch=oldFetch;global.localStorage=oldStorage}
})
test('minute-boundary retries share pending history and incremental sync overlaps broker data rather than multiplying volume',async()=>{
 const oldFetch=global.fetch,oldStorage=global.localStorage
 let release,calls=0,clock=now
 const requests=[]
 global.localStorage={getItem:()=> 'chart-pending'}
 global.fetch=async(_url,options)=>{
  const request=JSON.parse(options.body);requests.push(request);calls++
  if(calls===1)await new Promise(resolve=>{release=resolve})
  return {ok:true,status:200,json:async()=>({status:true,data:[bar(now-605000,120,clock===now?300:400),bar(now-305000,125,0),...(clock===now?[]:[bar(now-5000,126,150)])]})}
 }
 try{
  const snapshot=fixture('Nifty 50',23000,now)
  const first=getAtmOptionCandles(snapshot,'FIVE_MINUTE',now)
  await new Promise(resolve=>setImmediate(resolve))
  const later=getAtmOptionCandles(snapshot,'FIVE_MINUTE',now+60000)
  assert.equal(first,later);release()
  const initial=await first;assert.equal(initial.ce[1][5],0)
  clock+=60000
  const next=await getAtmOptionCandles(snapshot,'FIVE_MINUTE',clock)
  assert.equal(calls,4)
  assert(requests.slice(2).every(request=>request.fromdate==='2026-10-26 10:50'))
  assert.equal(next.ce.reduce((sum,row)=>sum+row[5],0),550)
  await getAtmOptionCandles(snapshot,'FIVE_MINUTE',clock);assert.equal(calls,4)
 }finally{global.fetch=oldFetch;global.localStorage=oldStorage}
})
test('invalid contracts, empty feeds and broker authentication failures never become fabricated chart candles',async()=>{
 const oldFetch=global.fetch,oldStorage=global.localStorage
 global.localStorage={getItem:key=>key==='angelone_jwt_token'?'chart-errors':null}
 const snapshot=fixture('Sensex',74000,now)
 try {
  await assert.rejects(getAtmOptionCandles({...snapshot,ce:{...snapshot.ce,exchange:'NFO'}},'FIVE_MINUTE',now),/Valid index ATM/)
  global.fetch=async()=>({ok:true,status:200,json:async()=>({status:true,data:[]})})
  await assert.rejects(getAtmOptionCandles(snapshot,'FIVE_MINUTE',now),/unavailable from the broker/)
  global.fetch=async()=>({ok:true,status:200,json:async()=>({status:false,errorcode:'AG8001',message:'Session expired'})})
  await assert.rejects(getAtmOptionCandles(snapshot,'FIVE_MINUTE',now),/session expired/i)
 }finally{global.fetch=oldFetch;global.localStorage=oldStorage}
})
