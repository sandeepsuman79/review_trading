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
test('ordinary noise before 0.75R does not arm a trail and removed minute-pressure data cannot force an exit',()=>{
 for(const side of ['CALL','PUT']){
  const d=side==='CALL'?1:-1,record=position(side),context=review(record)
  const unarmed=observePredictionTick(record,1000+d*3,now+1,true,context);assert.equal(unarmed.protection.armed,false)
  const minute={...context,interval:'ONE_MINUTE',asOf:new Date(now-60000).toISOString(),pressure:{side:side==='CALL'?'PUT':'CALL',confirmed:true,reasons:['Price break','RSI weakening','EMA turn']}}
  const closed=syncPredictionRecord(record,[],quote(record,now,1000-d*2),now,false,undefined,null,minute)
  assert.equal(closed.status,'ACTIVE');assert.equal(closed.reversalInterval,undefined);assert.equal(closed.points,undefined)
  assert.equal(closed.protection.atr,10,'removed minute ATR is ignored')
 }
})
test('saved protective stops survive reload and replay cannot turn an ambiguous stop/target candle into a win',()=>{
 let record=position();record=observePredictionTick(record,1015,now,true,review(record))
 const start=Date.parse('2026-10-16T13:05:00+05:30');record={...record,observedThrough:start}
 const bar=[new Date(start).toISOString(),1015,1035,1000,1025,0]
 const replay=observePredictionCandles(record,[bar],start+300000,false);assert.equal(replay.status,'AMBIGUOUS');assert.equal(replay.points,undefined)
 const trailOnly=observePredictionCandles(record,[[bar[0],1015,1016,1000,1005,0]],start+300000,false);assert.equal(trailOnly.status,'EARLY_EXIT');assert.equal(trailOnly.earlyExitSource,'AGENT_PROTECTION')
})
