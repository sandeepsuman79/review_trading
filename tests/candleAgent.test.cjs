const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {analyzeCandleAgent,validCandleConfirmation}=require('../src/analysis/candleAgent.ts')
const {createPredictionRecord,observePredictionTick,observeCandleAgentExit,readPredictionHistory,writePredictionHistory,registerConfirmedPrediction,syncPredictionRecord}=require('../src/analysis/predictionHistory.ts')
const {candleAgentDecisions}=require('../src/analysis/candleAgentDiagnostics.ts')
const {mcxSession}=require('../src/analysis/commodities.ts')
const {fixture,markets}=require('./helpers/confirmation.cjs')
const now=Date.parse('2026-11-04T14:00:00+05:30'),step=300000
const contract=row=>row[3]?{name:row[0],root:row[3],token:'12345',symbol:row[3]+'20NOV26FUT',expiry:'2026-11-20',expiresAt:mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close,exchange:'MCX',exchangeType:5,tickSize:row[3]==='NATURALGAS'?.1:1}:undefined
const assess=(f,overrides={})=>analyzeCandleAgent({candles:f.candles,instrument:f.instrument,now,contract:contract(markets.find(r=>r[0]===f.instrument)),...overrides})
function patternFixture(row,d,pattern){
 const f=fixture(row,d,'FIVE_MINUTE',now)
 f.candles=f.slots.map((t,i)=>{const v=12-i*.15;return f.candle(t,v,v+.2,v-.25,v-.1,0)})
 if(pattern==='ENGULFING_REVERSAL'){
  f.candles[50]=f.candle(f.slots[50],3,3.1,1.5,2,0);f.candles[51]=f.candle(f.slots[51],1.9,4.6,1.7,4.5,0)
 }else if(pattern==='REJECTION_BREAK'){
  f.candles[50]=f.candle(f.slots[50],2,2.4,.5,2.2,0);f.candles[51]=f.candle(f.slots[51],2.2,3.1,2.1,3,0)
 }else{
  f.candles[49]=f.candle(f.slots[49],3,4,1,2.5,0);f.candles[50]=f.candle(f.slots[50],2.6,3.3,2.5,2.8,0);f.candles[51]=f.candle(f.slots[51],2.9,4.8,2.8,4.6,0)
 }
 return f
}
test('one five-minute engine confirms mirrored range breaks across all seven markets without indicator or volume feeds',()=>{
 for(const row of markets)for(const d of[1,-1]){
  const f=fixture(row,d,'FIVE_MINUTE',now),a=assess(f)
  assert(a.plan,`${row[0]} ${d}: ${a.reason}`);assert.equal(a.plan.strategyVersion,'candle-v2');assert.equal(a.plan.interval,'FIVE_MINUTE')
  assert.equal(a.signal.side,f.side);assert.equal(a.signal.pattern,'ACCEPTED_RANGE_BREAK');assert(a.plan.riskReward>0)
  assert(a.plan.candleConfirmation.checks.every(c=>c.passed));assert(validCandleConfirmation(a.plan.candleConfirmation,a.plan))
  assert.equal(a.plan.confirmationSnapshot,undefined);assert.equal(a.plan.evidenceSummary,undefined)
  assert.deepEqual(assess({...f,candles:f.candles.map(b=>[...b.slice(0,5),0])},{indiaVix:{price:99},atmVwap:undefined,candlesByInterval:{ONE_HOUR:[]}}),a)
 }
})
test('engulfing, rejection and inside-bar patterns confirm only after their directional close',()=>{
 for(const pattern of['ENGULFING_REVERSAL','REJECTION_BREAK','INSIDE_BAR_BREAK'])for(const d of[1,-1]){
  const f=patternFixture(markets[0],d,pattern),a=assess(f)
  assert(a.signal,`${pattern} ${d}: ${a.reason}`);assert.equal(a.signal.pattern,pattern);assert.equal(a.signal.side,f.side)
  assert(a.plan,`${pattern}: ${a.reason}`)
  const forming=f.candle(now,1,999,-99,998)
  assert.deepEqual(assess({...f,candles:[...f.candles,forming]}),a)
  const notClosed=assess({...f,candles:f.candles.slice(0,-1)},{now:now-step})
  assert.notEqual(notClosed.signal?.pattern,pattern)
 }
})
test('sideways, stale or incomplete candles cannot become a confirmed trade',()=>{
 const f=fixture(markets[0],1,'FIVE_MINUTE',now)
 const sideways=assess({...f,candles:f.slots.map(t=>f.candle(t,1,2,0,1,0))})
 assert.equal(sideways.state,'SIDEWAYS');assert.equal(sideways.plan,undefined)
 assert.equal(assess(f,{now:now+step}).state,'STALE')
 assert.equal(assess({...f,candles:f.candles.slice(-19)}).plan,undefined)
 assert.equal(assess({...f,candles:f.candles.filter((_,i)=>i!==50)}).plan,undefined)
 assert.equal(assess({...f,candles:f.candles.map((b,i)=>i===51?[b[0],b[4],b[2]+20,b[3],b[4],0]:b)}).plan,undefined)
 assert.equal(assess(f,{now:Date.parse('2026-11-04T15:20:00+05:30')}).plan,undefined)
 const mcx=fixture(markets[3],1,'FIVE_MINUTE',now);assert.equal(assess(mcx,{contract:undefined}).plan,undefined)
})
test('candle plans persist independently of legacy indicator snapshots and reject malformed price evidence',()=>{
 const f=fixture(markets[0],1,'FIVE_MINUTE',now),plan=assess(f).plan
 let value;const storage={setItem:(_,v)=>value=v,getItem:()=>value}
 writePredictionHistory(storage,[createPredictionRecord(plan)]);assert.deepEqual(readPredictionHistory(storage)[0].candleConfirmation,JSON.parse(JSON.stringify(plan.candleConfirmation)))
 for(const patch of[{interval:'ONE_HOUR'},{checks:[]},{policy:'adaptive-confirmation-v3'},{trigger:0},{side:'PUT'}]){
  const bad={...createPredictionRecord(plan),candleConfirmation:{...plan.candleConfirmation,...patch}}
  assert.throws(()=>readPredictionHistory({getItem:()=>JSON.stringify({version:1,records:[bad]})}),/preserved/)
 }
})
test('entry waits for a subsequent observed trigger and keeps one position per instrument without a ratio floor',()=>{
 for(const d of[1,-1]){
  const f=fixture(markets[0],d,'FIVE_MINUTE',now),plan=assess(f).plan,pending=createPredictionRecord(plan)
  assert.equal(observePredictionTick(pending,plan.entry-d*.1,now+1).status,'PENDING')
  const active=observePredictionTick(pending,plan.entry,now+1);assert.equal(active.status,'ACTIVE');assert.equal(active.protection.version,2)
  assert.equal(registerConfirmedPrediction([active],{...plan,id:'another'},now+2).length,1)
  const risk=d*(plan.entry-plan.stopLoss),bad=observePredictionTick(pending,plan.entry+d*risk*.8,now+2)
  assert.equal(bad.status,'ACTIVE','positive remaining reference reward does not need a minimum ratio')
  assert.equal(observePredictionTick(pending,plan.target,now+2).status,'EXPIRED','an already consumed reference move still cannot enter')
  assert.equal(observePredictionTick(pending,plan.entry,now+step).status,'EXPIRED')
 }
})

test('low reward/risk patterns confirm, persist and enter symmetrically across all seven markets',()=>{
 const {diagnoseTradeEntry}=require('../src/analysis/tradeEntry.ts')
 for(const row of markets)for(const d of[1,-1]){
  const f=fixture(row,d,'FIVE_MINUTE',now)
  f.candles[30]=f.candle(f.slots[30],3,10,2,3.1)
  const a=assess(f),plan=a.plan
  assert(plan,`${row[0]} ${d}: ${a.reason}`)
  assert(plan.riskReward>0&&plan.riskReward<1.2,`${row[0]} ${d}: ${plan.riskReward}`)
  assert(validCandleConfirmation(plan.candleConfirmation,plan))
  let raw;writePredictionHistory({setItem:(_,v)=>raw=v},[createPredictionRecord(plan)])
  const pending=readPredictionHistory({getItem:()=>raw})[0]
  assert.equal(pending.target,plan.target,'nearby chart target must not be stretched')
  const price=plan.entry+d*.25*Math.abs(plan.target-plan.entry)
  const quote={token:plan.contract?.token??(row[0]==='Sensex'?'99919000':row[0]==='Bank Nifty'?'99926009':'99926000'),exchangeType:plan.contract?5:row[0]==='Sensex'?3:1,timestamp:now+1,ltp:price}
  assert.equal(diagnoseTradeEntry(plan,quote,true,now+1,false).state,'ELIGIBLE QUOTE')
  const active=observePredictionTick(pending,price,now+1)
  assert.equal(active.status,'ACTIVE');assert.equal(active.protection.basis,'CANDLE_STRUCTURE')
  assert.equal(observePredictionTick(pending,plan.target,now+1).status,'EXPIRED')
  assert.equal(observePredictionTick(pending,plan.stopLoss,now+1).status,'EXPIRED')
 }
})
test('price-only TSL calculation tightens symmetrically and reaches break-even at +1R independently of target management',()=>{
 const {updateTradeProtection}=require('../src/analysis/tradeProtection.ts')
 for(const row of markets)for(const d of[1,-1]){
  const f=fixture(row,d,'FIVE_MINUTE',now),plan=assess(f).plan
  let active=observePredictionTick(createPredictionRecord(plan),plan.entry,now+1)
  const risk=Math.abs(plan.entry-plan.stopLoss);let old=active.protection.stop
  for(const r of[.5,1,2,3,5]){
   const price=plan.entry+d*risk*r,time=now+1000*r
   active=updateTradeProtection({...active,observedThrough:time,latestPrice:price,latestPriceAt:time},price,time)
   assert.equal(active.status,'ACTIVE');assert(d*(active.protection.stop-old)>=-1e-8)
   if(r>=1)assert(d*(active.protection.stop-plan.entry)>=-1e-8)
   old=active.protection.stop
  }
  let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[active]);active=readPredictionHistory({getItem:()=>saved})[0]
  const exit=observePredictionTick(active,active.protection.stop-d*(row[3]?plan.contract.tickSize:.01),now+10000)
  assert.equal(exit.status,'EARLY_EXIT');assert.equal(exit.earlyExitSource,'AGENT_PROTECTION');assert(exit.points>0)
 }
})
test('opposite completed patterns exit open positions even when the opposite entry risk fails, without permitting an old/pre-entry signal',()=>{
 for(const d of[1,-1]){
  const f=fixture(markets[0],d,'FIVE_MINUTE',now),plan=assess(f).plan,entered=observePredictionTick(createPredictionRecord(plan),plan.entry,now+1)
  const later=now+2*step+1,signal={policy:'five-minute-candles-v2',instrument:f.instrument,side:d===1?'PUT':'CALL',pattern:'ENGULFING_REVERSAL',asOf:new Date(now+step).toISOString(),reviewedAt:later,level:plan.entry,invalidation:plan.stopLoss,trigger:plan.entry}
  const live={...entered,latestPrice:plan.entry+d*.1,latestPriceAt:later,latestPriceSource:'LIVE'}
  assert.equal(observeCandleAgentExit(live,signal,later).status,'EARLY_EXIT')
  assert.equal(observeCandleAgentExit(live,{...signal,asOf:plan.signalCandleTime},later).status,'ACTIVE')
  assert.equal(observeCandleAgentExit({...live,latestPriceAt:later-31000},signal,later).status,'ACTIVE')
  assert.equal(observeCandleAgentExit(live,{...signal,contractToken:'wrong'},later).status,'ACTIVE')
 }
})
test('new-policy exports contain candle checks without leaking weighted-score rules',()=>{
 const a=assess(fixture(markets[0],1,'FIVE_MINUTE',now)),decisions=candleAgentDecisions(a)
 assert(decisions.every(d=>d.basis==='CANDLE_ONLY'&&d.requiredScore===0&&d.requiredGap===0))
 assert.equal(decisions.find(d=>d.side==='CALL').state,'CONFIRMED');assert(decisions.every(d=>!d.checks.some(c=>/VWAP|ADX|RSI|score|coverage/i.test(c.label))))
})
test('only confirmed post-entry structure can tighten TSL, with tick-rounded break-even at the actual entry',()=>{
 const {updateTradeProtection}=require('../src/analysis/tradeProtection.ts')
 for(const d of[1,-1]){
  const f=fixture(markets[3],d,'FIVE_MINUTE',now),plan=assess(f).plan
  const entry=plan.entry+d*.03,active=observePredictionTick(createPredictionRecord(plan),entry,now+1),risk=Math.abs(entry-active.stopLoss)
  const time=now+4*step+1000,price=entry+d*risk*.4
  const swing={price:entry+d*risk*.2,at:new Date(now+step).toISOString()}
  const review={instrument:f.instrument,contractToken:plan.contract.token,interval:'FIVE_MINUTE',asOf:new Date(now+3*step).toISOString(),reviewedAt:time,candleStops:{[plan.side]:swing}}
  const trailed=updateTradeProtection(active,price,time,review)
  assert(d*(trailed.protection.stop-entry)>0)
  for(const invalid of[{...review,contractToken:'wrong'},{...review,candleStops:{[plan.side]:{...swing,at:new Date(time+step).toISOString()}}},{...review,candleStops:{[plan.side]:{...swing,at:new Date(now-step).toISOString()}}}]){
   const ignored=updateTradeProtection(active,price,time,invalid)
   assert(d*(ignored.protection.stop-entry)<0)
  }
  const breakEven=updateTradeProtection(active,entry+d*risk*1.01,time)
  assert(d*(breakEven.protection.stop-entry)>=-1e-8)
 }
})
test('the live sync path exits on the completed opposite pattern and preserves stop priority',()=>{
 const f=fixture(markets[0],1,'FIVE_MINUTE',now),plan=assess(f).plan,entered=observePredictionTick(createPredictionRecord(plan),plan.entry,now+1)
 const end=now+2*step+1000,signal={policy:'five-minute-candles-v2',instrument:f.instrument,side:'PUT',pattern:'ENGULFING_REVERSAL',asOf:new Date(now+step).toISOString(),reviewedAt:end,level:plan.entry,invalidation:plan.stopLoss,trigger:plan.entry}
 const active={...entered,observedThrough:end-1000},tick={token:'99926000',exchangeType:1,ltp:plan.entry+.1,timestamp:end}
 const exit=syncPredictionRecord(active,[],tick,end,false,undefined,null,undefined,signal)
 assert.equal(exit.status,'EARLY_EXIT');assert.equal(exit.earlyExitSource,'AGENT_REVERSAL');assert.equal(exit.exitPrice,tick.ltp)
 const stopped=syncPredictionRecord(active,[],{...tick,ltp:plan.stopLoss-.1},end,false,undefined,null,undefined,signal)
 assert.equal(stopped.status,'STOP_LOSS_HIT')
 let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[exit]);assert.equal(readPredictionHistory({getItem:()=>saved})[0].status,'EARLY_EXIT')
})
test('structure trailing confirms higher lows and lower highs only after two completed right-hand bars',()=>{
 for(const d of[1,-1]){
  const f=fixture(markets[0],d,'FIVE_MINUTE',now)
  f.candles=f.slots.map((t,i)=>{const low=i===44?1:i===49?3:10;return f.candle(t,low+1,low+2,low,low+1.2,0)})
  assert.equal(assess(f,{now:now-step}).candleStops[f.side],undefined,'one completed right-hand candle cannot confirm a swing')
  const a=assess(f),swing=a.candleStops[f.side]
  assert(swing);assert.equal(swing.at,f.slots[49]===undefined?undefined:new Date(f.slots[49]).toISOString())
  const pivot=d===1?f.candles[49][3]:f.candles[49][2]
  assert(Math.abs(swing.price-(pivot-d*.01))<1e-7)
 }
})
test('new candle-only replay needs no ATM or indicator context and does not alter archived policies',()=>{
 const {replayStrategy,evaluateReplayAdaptiveSetup}=require('../src/analysis/strategyReplay.ts')
 const f=fixture(markets[0],1,'FIVE_MINUTE',now),report=replayStrategy({instrument:f.instrument,candles:f.candles})
 assert.equal(report.data.minimumBars,20);assert.deepEqual(report.diagnostics.missingRequiredInputs,[])
 assert.match(report.assumptions.strategy,/five-minute-candles-v2/);assert.deepEqual(report.assumptions.missingContext,[])
 assert(report.diagnostics.bySide.CALL.confirmed>0)
 assert(replayStrategy({instrument:f.instrument,candles:f.candles},evaluateReplayAdaptiveSetup).diagnostics.missingRequiredInputs.length>0)
})
