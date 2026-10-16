const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {analyzeMinuteMonitor,rollingMinuteReviews,minutePlanOpposes}=require('../src/analysis/minuteMonitor.ts')
const {createPredictionRecord,syncPredictionRecord,registerConfirmedPrediction,readPredictionHistory,writePredictionHistory}=require('../src/analysis/predictionHistory.ts')
const {predictionEvents}=require('../src/analysis/predictionEvents.ts')
const {mcxSession}=require('../src/analysis/commodities.ts')
const {historyIntervals,chartIntervals,agentInterval}=require('../src/analysis/timeframes.ts')
const {prioritizeHistoryJobs}=require('../src/analysis/historySync.ts')
const now=Date.parse('2026-10-16T13:02:00+05:30')
const markets=[['Nifty 50',22000,1],['Sensex',74000,3],['Bank Nifty',50000,2],['Natural Gas',300,.2,'NATURALGAS'],['Crude Oil',6000,2,'CRUDEOIL'],['Gold',110000,10,'GOLD'],['Silver',90000,10,'SILVER']]
function fixture(row=markets[0],d=-1,end=now){
 const [instrument,base,scale,root]=row
 const contract=root?{name:instrument,root,token:'12345',symbol:`${root}20NOV26FUT`,exchange:'MCX',exchangeType:5,expiry:'2026-11-20',expiresAt:mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close,tickSize:root==='NATURALGAS'?.1:1}:undefined
 const candles=Array.from({length:52},(_,i)=>{const o=base+d*(i*.3+Math.sin(i/4)*6)*scale,c=o+d*2*scale;return[new Date(end-(52-i)*60000).toISOString(),o,Math.max(o,c)+.7*scale,Math.min(o,c)-.7*scale,c,root?100:0]})
 return{candles,instrument,now:end,contract}
}
function position(review,profit=2){
 const plan=review.plan,d=plan.side==='PUT'?1:-1,side=d===1?'CALL':'PUT',entry=plan.entry-d*profit
 return{...createPredictionRecord({...plan,id:'active-five-minute',interval:'FIVE_MINUTE',side,generatedAt:now-180000,entry,stopLoss:entry-d*100,target:entry+d*200,riskReward:2}),status:'ACTIVE',entryAt:now-120000,entryPrice:entry,observedThrough:now-1000,latestPrice:entry,latestPriceAt:now-1000,latestPriceSource:'LIVE'}
}
const quote=(record,time,price)=>({token:record.contract?.token??'99926000',exchangeType:record.contract?5:1,mode:record.contract?2:1,timestamp:time,ltp:price})
test('all seven instruments produce independent minute technical and sentiment reviews without issuing minute entries',()=>{
 for(const row of markets)for(const d of [1,-1]){
  const review=analyzeMinuteMonitor(fixture(row,d));assert.equal(review.state,'CONFIRMED',row[0]+': '+review.reason);assert.equal(review.plan.side,d===1?'CALL':'PUT');assert.equal(review.plan.interval,'ONE_MINUTE')
  assert(review.indicators.rsi!==undefined);assert(review.indicators.atr>0);assert.equal(review.sentiment.bias,'UNAVAILABLE');assert.equal(registerConfirmedPrediction([],review.plan,now).length,0)
 }
 assert.equal(agentInterval,'FIVE_MINUTE');assert(!chartIntervals.includes('ONE_MINUTE'));assert(historyIntervals.includes('ONE_MINUTE'))
 const jobs=historyIntervals.flatMap(interval=>markets.map(([token])=>({token,interval})))
 assert.equal(jobs.length,28);assert.deepEqual(prioritizeHistoryJobs(jobs,'Gold','ONE_HOUR').slice(0,3).map(j=>j.interval),['FIVE_MINUTE','ONE_MINUTE','ONE_HOUR'])
})
test('minute reversal books CALL/PUT and LONG/SHORT profit or loss inside the unfinished five-minute candle',()=>{
 for(const row of markets)for(const d of [1,-1])for(const profit of [-2,2]){
  const review=analyzeMinuteMonitor(fixture(row,d)),record=position(review,profit)
  assert(now%300000!==0,'fixture must reverse before a five-minute close')
  const closed=syncPredictionRecord(record,[],quote(record,now,review.plan.entry),now,false,undefined,review.plan)
  assert.equal(closed.status,'EARLY_EXIT');assert.equal(closed.reversalInterval,'ONE_MINUTE');assert.equal(closed.points,profit);assert.equal(closed.exitAt,now);assert.match(closed.outcomeNote,/1-minute/)
  assert.equal(predictionEvents([record],[closed])[0].reason,'1-minute reversal · Exit')
  const memory=new Map(),storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};writePredictionHistory(storage,[closed]);assert.deepEqual(readPredictionHistory(storage),JSON.parse(JSON.stringify([closed])))
 }
})
test('developing, stale, forming, disconnected and wrong-contract minute signals cannot manufacture exits',()=>{
 const input=fixture(markets[3]),review=analyzeMinuteMonitor(input),record=position(review)
 for(const plan of [{...review.plan,stage:'RISKY'},{...review.plan,side:record.side},{...review.plan,instrument:'Gold'},{...review.plan,contract:{...review.plan.contract,token:'54321'}},{...review.plan,generatedAt:now-60000},{...review.plan,signalCandleTime:new Date(now).toISOString()},{...review.plan,signalCandleTime:new Date(record.entryAt-60000).toISOString()}])assert.equal(syncPredictionRecord(record,[],quote(record,now,review.plan.entry),now,false,undefined,plan).status,'ACTIVE')
 assert.equal(syncPredictionRecord(record,[],undefined,now,false,undefined,review.plan).status,'ACTIVE')
 const forming=analyzeMinuteMonitor({...input,candles:[...input.candles,[new Date(now).toISOString(),1,1000,.1,1,100]],now:now+1000});assert.equal(forming.asOf,review.asOf)
 const stale=analyzeMinuteMonitor({...input,now:now+60000});assert.equal(stale.state,'STALE');assert.equal(stale.plan,undefined)
 const warm=analyzeMinuteMonitor({...input,candles:input.candles.slice(-20)});assert.equal(warm.state,'WARMING_UP');assert.equal(warm.plan,undefined)
})
test('full post-entry minute and a fresh matching quote after its close are required; stop/target outcomes take priority',()=>{
 const review=analyzeMinuteMonitor(fixture()),record=position(review)
 const partial={...record,entryAt:now-30000}
 assert.equal(syncPredictionRecord(partial,[],quote(partial,now,review.plan.entry),now,false,undefined,review.plan).status,'ACTIVE')
 assert.equal(syncPredictionRecord(record,[],quote(record,now,record.stopLoss-1),now,false,undefined,review.plan).status,'STOP_LOSS_HIT')
 assert.equal(syncPredictionRecord(record,[],quote(record,now,record.target+1),now,false,undefined,review.plan).status,'TARGET_HIT')
 assert.equal(minutePlanOpposes(record,review.plan,now,now),true)
 assert.equal(minutePlanOpposes(record,review.plan,now-60000,now),false)
 assert.equal(minutePlanOpposes(record,{...review.plan,side:record.side},now,now),false)
})
test('last-five-minute memory deduplicates revisions and leaves missing minutes missing',()=>{
 const review=analyzeMinuteMonitor(fixture());let history=[]
 for(let i=0;i<5;i++)history=rollingMinuteReviews(history,{...review,asOf:new Date(now-(5-i)*60000).toISOString()},now)
 assert.equal(history.length,5)
 history=rollingMinuteReviews(history,{...review,bullishScore:99},now);assert.equal(history.length,5);assert.equal(history.at(-1).bullishScore,99)
 history=rollingMinuteReviews(history,{...review,current:false},now+2*60000);assert.equal(history.length,3)
 history=rollingMinuteReviews(history,{...review,current:false},now+6*60000);assert.equal(history.length,0)
})

test('ATM option VWAP is separate from spot VWAP and partial/stale option data never votes',()=>{
 const {atmVwapBias}=require('../src/api/atmVwap.ts'),leg=(close)=>({symbol:'fixture',token:'1',exchange:'NFO',close,vwap:100,volume:100,asOf:new Date(now).toISOString(),coverage:'FULL_SESSION'})
 const snapshot={index:'Nifty 50',strike:22000,expiry:'2026-10-20',fetchedAt:new Date(now).toISOString(),method:'SESSION_HLC3_VOLUME',referenceIndexPrice:22000,ce:leg(90),pe:leg(110)}
 assert.equal(atmVwapBias(snapshot,'Nifty 50',22000,now),'BEARISH')
 assert.equal(atmVwapBias({...snapshot,ce:{...snapshot.ce,coverage:'PARTIAL_SESSION'}},'Nifty 50',22000,now),undefined)
 assert.equal(atmVwapBias(snapshot,'Nifty 50',22000,now+120000),undefined)
 assert.equal(atmVwapBias(snapshot,'Nifty 50',22500,now),undefined)
 assert.equal(atmVwapBias({...snapshot,index:'Gold'},'Gold',22000,now),undefined)
 const result=analyzeMinuteMonitor({...fixture(),optionVwap:snapshot});assert.equal(result.indicators.vwap,undefined)
})
