const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {createPredictionRecord,observePredictionTick,syncPredictionRecord,observePredictionCandles,readPredictionHistory,writePredictionHistory}=require('../src/analysis/predictionHistory.ts')
const {mcxSession}=require('../src/analysis/commodities.ts')
const now=Date.parse('2026-10-16T13:02:00+05:30')
function position(side='CALL',commodity=false){const d=side==='CALL'?1:-1,contract=commodity?{name:'Crude Oil',root:'CRUDEOIL',token:'12345',symbol:'CRUDEOIL20NOV26FUT',expiry:'2026-11-20',expiresAt:mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close,exchange:'MCX',exchangeType:5,tickSize:1}:undefined
 return{...createPredictionRecord({id:'protect-'+side,instrument:commodity?'Crude Oil':'Nifty 50',contract,side,interval:'FIVE_MINUTE',stage:'CONFIRMED',strategyVersion:'technical-v2',signalCandleTime:new Date(now-420000).toISOString(),generatedAt:now-120000,expiresAt:now+900000,entry:1000,stopLoss:1000-d*10,target:1000+d*30,riskReward:3,reason:'Fixture',technicalEvidence:[],newsEvidence:[],newsSummary:'Unavailable',contextMode:'TECHNICAL_ONLY',coverage:[],bullishScore:70,bearishScore:10,targetBasis:'Fixture'}),status:'ACTIVE',entryPrice:1000,entryAt:now-120000,observedThrough:now-1000,latestPrice:1000,latestPriceAt:now-1000,latestPriceSource:'LIVE'} }
const quote=(record,time,price)=>({token:record.contract?.token??'99926000',exchangeType:record.contract?5:1,timestamp:time,ltp:price})
function review(record){return{instrument:record.instrument,contractToken:record.contract?.token,interval:'FIVE_MINUTE',asOf:new Date(now-420000).toISOString(),reviewedAt:now,atr:2}}
test('CALL/PUT and MCX LONG/SHORT trail observed profit and exit on a quote without any opposite setup',()=>{
 for(const side of ['CALL','PUT'])for(const commodity of [false,true]){
  let record=position(side,commodity);const d=side==='CALL'?1:-1,context=review(record)
  record=observePredictionTick(record,1000+d*8,now+1,true,context);assert.equal(record.status,'ACTIVE');assert(record.protection.armed)
  record=observePredictionTick(record,1000+d*15,now+2,true,context);assert.equal(record.status,'ACTIVE');const stop=record.protection.stop;assert((stop-1000)*d>0)
  record=observePredictionTick(record,1000+d*14,now+3,true,{...context,atr:100});assert.equal(record.protection.stop,stop,'higher ATR cannot loosen the saved stop')
  const exit=stop-d*1,closed=observePredictionTick(record,exit,now+4,true,context)
  assert.equal(closed.status,'EARLY_EXIT');assert.equal(closed.earlyExitSource,'AGENT_PROTECTION');assert.equal(closed.exitPrice,exit);assert(closed.points>0);assert.match(closed.outcomeNote,/observed quote/)
  let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[closed]);assert.deepEqual(readPredictionHistory({getItem:()=>saved}),JSON.parse(saved).records)
 }
})
test('TSL is automatic before 0.75R and removed minute-pressure data cannot force an exit',()=>{
 for(const side of ['CALL','PUT']){
  const d=side==='CALL'?1:-1,record=position(side),context=review(record)
  const unarmed=observePredictionTick(record,1000+d*3,now+1,true,context);assert.equal(unarmed.protection.armed,true);assert((unarmed.protection.stop-record.stopLoss)*d>=0)
  const minute={...context,interval:'ONE_MINUTE',asOf:new Date(now-60000).toISOString(),pressure:{side:side==='CALL'?'PUT':'CALL',confirmed:true,reasons:['Price break','RSI weakening','EMA turn']}}
  const closed=syncPredictionRecord(record,[],quote(record,now,1000-d*2),now,false,undefined,null,minute)
  assert.equal(closed.status,'ACTIVE');assert.equal(closed.reversalInterval,undefined);assert.equal(closed.points,undefined)
  assert.equal(closed.protection.atr,10,'removed minute ATR is ignored')
 }
})
test('saved protective stops settle even when the same candle crosses the reference target',()=>{
 let record=position();record=observePredictionTick(record,1015,now,true,review(record))
 const start=Date.parse('2026-10-16T13:05:00+05:30');record={...record,observedThrough:start}
 const bar=[new Date(start).toISOString(),1015,1035,1000,1025,0]
 const replay=observePredictionCandles(record,[bar],start+300000,false);assert.equal(replay.status,'EARLY_EXIT');assert.equal(replay.exitPrice,record.protection.stop)
 const trailOnly=observePredictionCandles(record,[[bar[0],1015,1016,1000,1005,0]],start+300000,false);assert.equal(trailOnly.status,'EARLY_EXIT');assert.equal(trailOnly.earlyExitSource,'AGENT_PROTECTION')
})

test('automatic TSL starts at confirmed entry across all seven instruments and both directions',()=>{
 const {commoditySpecs}=require('../src/analysis/commodities.ts')
 for(const instrument of ['Nifty 50','Sensex','Bank Nifty',...commoditySpecs.map(spec=>spec.name)])for(const side of ['CALL','PUT']){
  const d=side==='CALL'?1:-1,spec=commoditySpecs.find(spec=>spec.name===instrument)
  let base=position(side,Boolean(spec))
  base={...base,instrument,...(spec?{contract:{...base.contract,name:instrument,root:spec.root,symbol:`${spec.root}20NOV26FUT`}}:{})}
  const pending={...base,status:'PENDING',entryAt:undefined,entryPrice:undefined,observedThrough:now,target:1000+d*12,riskReward:1.2}
  const context=review(base)
  assert.equal(pending.protection,undefined)
  const entered=observePredictionTick(pending,1000,now+1,true,context)
  assert.equal(entered.status,'ACTIVE');assert.equal(entered.protection.armed,true)
  assert.equal(entered.protection.stop,pending.stopLoss,'keep the initial stop at entry')
  assert.equal(entered.protection.peakPrice,1000)
  const earlyTrail=observePredictionTick(entered,1000+d*1,now+2,true,context)
  assert((earlyTrail.protection.stop-pending.stopLoss)*d>0,'trail can tighten before the former 0.75R activation')
  assert.equal(earlyTrail.stopLoss,pending.stopLoss,'original risk levels remain immutable')
  let saved;writePredictionHistory({setItem:(_,value)=>saved=value},[earlyTrail])
  assert.deepEqual(readPredictionHistory({getItem:()=>saved}),JSON.parse(saved).records)
 }
})
test('TSL reaches break-even at 1R, never loosens on larger ATR and exits at the observed gap quote',()=>{
 for(const side of ['CALL','PUT']){
  const d=side==='CALL'?1:-1,base=position(side),context={...review(base),atr:10}
  const record=observePredictionTick(base,1000+d*10,now+1,true,context)
  assert.equal(record.protection.stop,1000)
  const held=observePredictionTick(record,1000+d*9,now+2,true,{...context,atr:100})
  assert.equal(held.protection.stop,1000)
  const exit=1000-d*3,closed=observePredictionTick(held,exit,now+3,true,context)
  assert.equal(closed.status,'EARLY_EXIT');assert.equal(closed.earlyExitSource,'AGENT_PROTECTION')
  assert.equal(closed.exitPrice,exit);assert.equal(closed.points,-3,'a gap can pass a break-even stop; do not invent a fill')
 }
})
test('pending, stale, future and out-of-order quotes cannot move automatic TSL',()=>{
 const {updateTradeProtection}=require('../src/analysis/tradeProtection.ts')
 const base=position(),context=review(base)
 assert.equal(updateTradeProtection({...base,status:'PENDING'},1005,now,context).protection,undefined)
 const tracked=observePredictionTick(base,1005,now,true,context)
 assert.equal(updateTradeProtection(tracked,1010,now-1,context),tracked)
 assert.equal(updateTradeProtection(tracked,1010,NaN,context),tracked)
 for(const timestamp of [now-31000,now+1001]){
  const source=timestamp<now?{...tracked,observedThrough:now-40000,latestPriceAt:now-40000,protection:{...tracked.protection,peakAt:now-40000}}:tracked
  const changed=syncPredictionRecord(source,[],quote(source,timestamp,1020),now,false,undefined,null,context)
  assert.deepEqual(changed.protection,source.protection)
  assert.equal(changed.status,'ACTIVE')
 }
})
test('reconstructed entry seeds TSL without using candle extremes; the original stop keeps its classification',()=>{
 const start=Date.parse('2026-10-16T13:05:00+05:30'),base=position()
 const record={...base,status:'PENDING',entryAt:undefined,entryPrice:undefined,generatedAt:start,observedThrough:start,expiresAt:start+300000,signalCandleTime:new Date(start-300000).toISOString(),target:1012,riskReward:1.2}
 const entry=[new Date(start).toISOString(),1000,1008,999,1005,0]
 const active=observePredictionCandles(record,[entry],start+300000,true)
 assert.equal(active.status,'ACTIVE');assert.equal(active.protection.armed,true)
 assert.equal(active.protection.peakPrice,1000,'no intrabar high may become a synthetic trailing peak')
 assert.equal(active.protection.stop,990)
 const slipped=observePredictionCandles(record,[[entry[0],1000.01,1008,999,1005,0]],start+300000,true)
 assert.equal(slipped.status,'EXPIRED','a gapped candle entry must still retain 1.20 reward/risk')
 const stopped=observePredictionCandles(active,[[new Date(start+300000).toISOString(),1005,1006,989,995,0]],start+600000,false)
 assert.equal(stopped.status,'STOP_LOSS_HIT');assert.equal(stopped.exitPrice,990)
})
