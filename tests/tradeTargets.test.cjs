const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m,f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {createPredictionRecord,observePredictionTick,observePredictionCandles,syncPredictionRecord,readPredictionHistory,writePredictionHistory}=require('../src/analysis/predictionHistory.ts')
const {currentTradeTarget,nextStructureTarget,targetRules}=require('../src/analysis/tradeTargets.ts')
const {predictionEvents}=require('../src/analysis/predictionEvents.ts')
const {commoditySpecs,mcxSession}=require('../src/analysis/commodities.ts')
const now=Date.parse('2026-11-05T14:05:00+05:30'),start=now-300000
const markets=['Nifty 50','Sensex','Bank Nifty',...commoditySpecs.map(s=>s.name)]
function pending(instrument='Nifty 50',d=1,targetGain=12){
 const spec=commoditySpecs.find(s=>s.name===instrument),contract=spec?{...spec,token:'12345',symbol:spec.root+'20NOV26FUT',expiry:'2026-11-20',expiresAt:mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close,exchange:'MCX',exchangeType:5,tickSize:.1}:undefined
 return {...createPredictionRecord({id:instrument+d,instrument,...(contract?{contract}:{}),side:d===1?'CALL':'PUT',interval:'FIVE_MINUTE',stage:'CONFIRMED',strategyVersion:'technical-v2',signalCandleTime:new Date(start-300000).toISOString(),generatedAt:start,expiresAt:now,entry:1000,stopLoss:1000-d*10,target:1000+d*targetGain,riskReward:targetGain/10,targetBasis:'Observed level',reason:'Fixture',technicalEvidence:[],coverage:[],newsEvidence:[],newsSummary:'',contextMode:'TECHNICAL_ONLY',bullishScore:70,bearishScore:10}),targetPolicy:'STRUCTURE_TARGETS_V1'}
}
function review(record,d=1,levels=[20,30]){
 const asOf=new Date(start).toISOString()
 return {instrument:record.instrument,contractToken:record.contract?.token,interval:'FIVE_MINUTE',asOf,reviewedAt:now,
  targetEvidence:{advancing:true,structure:{version:2,asOf,bars:52,tolerance:.1,trend:d===1?'UPTREND':'DOWNTREND',zones:[],lines:[],swings:levels.map((gain,i)=>({index:i+2,at:new Date(start-1200000).toISOString(),confirmedAt:new Date(start-600000).toISOString(),price:1000+d*gain,kind:d===1?'HIGH':'LOW',label:d===1?'HH':'LL'}))}}}
}
const active=(name,d,target=12)=>observePredictionTick(pending(name,d,target),1000,now-1)
const reload=record=>{let raw;writePredictionHistory({setItem:(_,v)=>raw=v},[record]);return readPredictionHistory({getItem:()=>raw})[0]}
test('target touch exits at actual quote without usable extension, mirrored across all seven markets',()=>{
 for(const name of markets)for(const d of[1,-1]){
  const a=active(name,d),closed=observePredictionTick(a,1000+d*13,now+1)
  assert.equal(closed.status,'TARGET_HIT');assert.equal(closed.exitPrice,1000+d*13);assert.equal(closed.points,13)
  assert.deepEqual(reload(closed),closed);assert.equal(observePredictionTick(closed,1000+d*50,now+2),closed)
 }
})
test('same-direction structure advances to nearest known level and persists original confirmation levels',()=>{
 for(const name of markets)for(const d of[1,-1]){
  const a=active(name,d),r=review(a,d),extended=observePredictionTick(a,1000+d*12,now+1,true,r)
  assert.equal(extended.status,'ACTIVE');assert.equal(extended.target,a.target)
  assert.equal(currentTradeTarget(extended),1000+d*20);assert.equal(extended.targetManagement.revisions,1)
  assert.equal(extended.protection.risk,10);assert(d*(extended.protection.stop-a.protection.stop)>=0)
  assert.deepEqual(reload(extended),extended)
  assert.equal(predictionEvents([a],[extended])[0].reason,'Target achieved · Extended')
  const next=observePredictionTick(extended,1000+d*21,now+2,true,r)
  assert.equal(currentTradeTarget(next),1000+d*30);assert.equal(next.targetManagement.revisions,2)
  assert.equal(observePredictionTick(next,1000+d*30,now+3,true,r).status,'TARGET_HIT','no farther observed level means book profit')
 }
})
test('stale, future, forming, mismatched, nonadvancing or opposite evidence cannot extend targets',()=>{
 const a=active('Crude Oil',1),base=review(a)
 const cases=[undefined,{...base,reviewedAt:now-31000},{...base,reviewedAt:now+2},{...base,asOf:new Date(now).toISOString()},
  {...base,instrument:'Gold'},{...base,contractToken:'different'},{...base,targetEvidence:{...base.targetEvidence,advancing:false}},
  {...base,targetEvidence:{...base.targetEvidence,structure:{...base.targetEvidence.structure,trend:'DOWNTREND'}}}]
 for(const r of cases)assert.equal(observePredictionTick(a,1012,now+1,true,r).status,'TARGET_HIT')
 const r=review(a,1,[5,12,20]);r.targetEvidence.structure.swings.at(-1).confirmedAt=new Date(now+300000).toISOString()
 assert.equal(nextStructureTarget(a,1012,now+1,r),undefined,'future and already crossed levels cannot manufacture a target')
})
test('a swing inside the reached zone is not treated as another resistance target',()=>{
 const a=active('Nifty 50',1),r=review(a,1,[20.1,30])
 r.targetEvidence.structure.zones=[{low:1020,high:1020.2,role:'RESISTANCE',originalRole:'RESISTANCE',touches:2,firstAt:r.asOf,lastAt:r.asOf,flipped:false}]
 assert.equal(nextStructureTarget(a,1020,now+1,r).target,1030)
})
test('same-side pattern holds but opposite completed pattern exits without waiting for wide TSL',()=>{
 for(const d of[1,-1]){
  const a=active('Nifty 50',d,100),r=review(a,d),side=a.side
  const signal={policy:'five-minute-candles-v2',instrument:a.instrument,asOf:r.asOf,reviewedAt:now,side,pattern:'ENGULFING_REVERSAL',level:1000,invalidation:990,trigger:1010}
  r.targetEvidence.signal=signal
  assert.equal(observePredictionTick(a,1000+d*3,now+1,true,r).status,'ACTIVE')
  r.targetEvidence.signal={...signal,side:d===1?'PUT':'CALL'}
  const exit=observePredictionTick(a,1000+d*3,now+1,true,r)
  assert.equal(exit.status,'EARLY_EXIT');assert.equal(exit.earlyExitSource,'AGENT_REVERSAL');assert.equal(exit.points,3)
  assert.equal(exit.exitPrice,1000+d*3,'first completed pattern after entry can exit even if its candle started before entry')
 }
})
test('profit giveback guard exits before distant TSL after +1R, but does not exit rising prices or ordinary losses',()=>{
 assert.equal(targetRules.maximumProfitGiveback,.35)
 for(const d of[1,-1]){
  const a=active('Nifty 50',d,100),peak=observePredictionTick(a,1000+d*10,now+1)
  assert.equal(peak.status,'ACTIVE')
  assert.equal(observePredictionTick(peak,1000+d*7,now+2).status,'ACTIVE')
  const exit=observePredictionTick(peak,1000+d*6,now+2)
  assert.equal(exit.status,'EARLY_EXIT');assert.equal(exit.earlyExitSource,'AGENT_PROTECTION');assert.equal(exit.points,6)
  assert(d*(exit.exitPrice-peak.protection.stop)>0,'guard protects profit before TSL touch')
  assert.equal(observePredictionTick(a,1000-d*2,now+1).status,'ACTIVE')
  const tick={token:'99926000',exchangeType:1,ltp:1000+d*6,timestamp:now+45000}
  assert.equal(syncPredictionRecord(peak,[],tick,now+45000,false,undefined,null).status,'EARLY_EXIT','fresh guard breach remains actionable after a quote gap')
 }
})
test('recovery uses known opens and marks simultaneous target/stop touches ambiguous',()=>{
 for(const d of[1,-1]){
  const candidate=pending('Nifty 50',d),a=observePredictionTick(candidate,1000,start+1)
  const source={...a,observedThrough:start},row=(o,h,l,c)=>[new Date(start).toISOString(),o,h,l,c,0]
  const both=observePredictionCandles(source,[row(1000,1020,980,1001)],now)
  assert.equal(both.status,'AMBIGUOUS');assert.equal(both.points,undefined)
  const open=1000+d*13,known=observePredictionCandles(source,[row(open,open+.1,open-.1,open)],now)
  assert.equal(known.status,'TARGET_HIT');assert.equal(known.exitPrice,open)
 }
})
test('malformed target updates are rejected while the initial target and existing records remain readable',()=>{
 const a=active('Nifty 50',1),extended=observePredictionTick(a,1012,now+1,true,review(a))
 for(const patch of [{target:1010},{target:NaN},{revisions:0},{updatedAt:now+400000},{asOf:'bad'}])
  assert.throws(()=>reload({...extended,targetManagement:{...extended.targetManagement,...patch}}),/invalid format/)
 assert.deepEqual(reload(a),a)
})
test('actual current candle plans use target management by default and keep their saved confirmation valid',()=>{
 const {fixture,markets:rows}=require('./helpers/confirmation.cjs'),{analyzeCandleAgent}=require('../src/analysis/candleAgent.ts')
 for(const row of rows)for(const d of[1,-1]){
  const f=fixture(row,d,'FIVE_MINUTE',now),contract=pending(row[0],d).contract
  const plan=analyzeCandleAgent({candles:f.candles,instrument:f.instrument,now,contract}).plan
  assert(plan)
  const a=observePredictionTick(createPredictionRecord(plan),plan.entry,now+1)
  assert.equal(observePredictionTick(a,plan.target,now+2).status,'TARGET_HIT')
  const time=now+300001,r=review(a,d)
  r.asOf=new Date(now).toISOString();r.reviewedAt=time;r.targetEvidence.structure.asOf=r.asOf
  r.targetEvidence.structure.swings[0].price=plan.target+d*20*row[2]
  r.targetEvidence.structure.swings=r.targetEvidence.structure.swings.slice(0,1)
  const extended=observePredictionTick(a,plan.target,time,true,r)
  assert.equal(extended.status,'ACTIVE');assert.equal(extended.target,plan.target)
  assert.equal(currentTradeTarget(extended),plan.target+d*20*row[2])
  assert.deepEqual(reload(extended),JSON.parse(JSON.stringify(extended)))
 }
})
test('an older active position adopts target management only from a fresh live five-minute review',()=>{
 const a=active('Nifty 50',1);delete a.targetPolicy
 assert.equal(observePredictionTick(a,1012,now+1).status,'ACTIVE','an absent archived review cannot change a recorded policy')
 const stale={...review(a),reviewedAt:now-31000}
 assert.equal(observePredictionTick(a,1012,now+1,true,stale).targetPolicy,undefined)
 const upgraded=observePredictionTick(a,1012,now+1,true,review(a))
 assert.equal(upgraded.targetPolicy,'STRUCTURE_TARGETS_V1');assert.equal(currentTradeTarget(upgraded),1020)
 assert.deepEqual(reload(upgraded),upgraded)
})
test('a fresh confirmed opposite pattern can protect an observed position after a quote gap',()=>{
 const a=active('Nifty 50',1,100),time=now+45000,r=review(a)
 r.reviewedAt=time;r.targetEvidence.signal={policy:'five-minute-candles-v2',instrument:a.instrument,asOf:r.asOf,reviewedAt:time,side:'PUT',pattern:'ENGULFING_REVERSAL',level:1000,invalidation:1010,trigger:990}
 const tick={token:'99926000',exchangeType:1,timestamp:time,ltp:1003}
 const exited=syncPredictionRecord(a,[],tick,time,false,undefined,null,r,r.targetEvidence.signal)
 assert.equal(exited.status,'EARLY_EXIT');assert.equal(exited.earlyExitSource,'AGENT_REVERSAL')
 assert.equal(exited.exitAt,time);assert.equal(exited.exitPrice,1003);assert.match(exited.outcomeNote,/after a gap/)
})
