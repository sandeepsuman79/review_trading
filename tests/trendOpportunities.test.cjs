const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {findMomentumSetups}=require('../src/analysis/momentumSetups.ts')
const {analyzeDirectionalAlignment}=require('../src/analysis/directionalAlignment.ts')
const {analyzePriceAction}=require('../src/analysis/priceAction.ts')
const {analyzeTradingEvidence,tradingEvidenceRules}=require('../src/analysis/tradingEvidence.ts')
const {buildEarlyPrediction}=require('../src/analysis/earlyPrediction.ts')
const {createPredictionRecord,observeConfirmedAgentReversal}=require('../src/analysis/predictionHistory.ts')
const {mcxSession}=require('../src/analysis/commodities.ts')
const {scenario,markets,intervals}=require('./helpers/trendScenarios.cjs')
const atmVwapFixture=require('./helpers/atmVwap.cjs')

function contractFor(input){
 return input.root?{name:input.instrument,root:input.root,token:'12345',symbol:`${input.root}20NOV26FUT`,exchange:'MCX',exchangeType:5,expiry:'2026-11-20',expiresAt:mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close,tickSize:input.root==='NATURALGAS'?.1:1}:undefined
}
function assess(input,d){
 const analysis=analyzePriceAction(input.candles,input.interval,input.now,input.instrument)
 const options=input.root?undefined:atmVwapFixture(input.instrument,analysis.currentPrice,input.now,d)
 const evidence=analyzeTradingEvidence({...input,analysis,atmVwap:options})
 const prediction=buildEarlyPrediction(analysis,input.instrument,input.interval,input.now,undefined,undefined,evidence,contractFor(input))
 return {analysis,evidence,prediction}
}
function controlled(d=1,interval='FIVE_MINUTE'){
 const input=scenario(markets[0],1,interval),candles=input.candles.map(row=>[row[0],100,101,99,100,0])
 for(const [offset,open,high,low,close] of [[-4,109.8,115,109.5,110],[-3,110,110.9,109.9,110.7],[-2,110.7,111.45,110.6,111.25],[-1,111.25,112.1,111.15,112]])candles[candles.length+offset]=[candles[candles.length+offset][0],open,high,low,close,0]
 let averages=candles.map(()=>({ema20:107,ema50:108}))
 let indicators=candles.map(()=>({atr14:2,rsi14:60,adx14:25,plusDi14:30,minusDi14:10,supertrend10:104,supertrendDirection:'UP'}))
 if(d===-1){
  for(let i=0;i<candles.length;i++){const row=candles[i];candles[i]=[row[0],200-row[1],200-row[3],200-row[2],200-row[4],0]}
  averages=averages.map(p=>({ema20:200-p.ema20,ema50:200-p.ema50}))
  indicators=indicators.map(p=>({...p,rsi14:100-p.rsi14,supertrend10:200-p.supertrend10,supertrendDirection:'DOWN',plusDi14:p.minusDi14,minusDi14:p.plusDi14}))
 }
 return {candles,averages,indicators,interval}
}
function find(data){
 const alignment=analyzeDirectionalAlignment(data.candles,data.averages,data.indicators,data.interval)
 return {alignment,candidates:findMomentumSetups(data.candles,data.averages,data.indicators,data.interval,undefined,undefined,alignment)}
}

test('flat Supertrend with a fresh local break supports continuation despite a distant, flat EMA and an older wick',()=>{
 for(const interval of Object.keys(intervals))for(const d of [1,-1]){
  const data=controlled(d,interval),{alignment,candidates}=find(data),latest=data.candles.at(-1)
  assert(Math.abs(latest[4]-data.averages.at(-1).ema20)>1.8*data.indicators.at(-1).atr14)
  assert.equal(alignment.routes.length,1);assert.equal(alignment.routes[0].family,'SUPERTREND');assert.match(alignment.routes[0].name,/held/)
  assert.equal(candidates.length,1);assert.equal(candidates[0].pattern,'TREND_CONTINUATION_BREAK');assert.equal(candidates[0].side,d===1?'CALL':'PUT')
  assert(d*(candidates[0].entry-candidates[0].stopLoss)>=2)
  assert(d*(candidates[0].target-candidates[0].entry)>0)
 }
})

test('a shallow pullback can resume without touching the distant EMA20 or breaking an older wick',()=>{
 for(const d of [1,-1]){
  const data=controlled(d)
  for(const [offset,o,h,l,c] of [[-4,110.8,115,110.5,111],[-3,111,111.2,110.6,110.7]]){
   const row=data.candles.at(offset)
   data.candles[data.candles.length+offset]=d===1?[row[0],o,h,l,c,0]:[row[0],200-o,200-l,200-h,200-c,0]
  }
  const result=find(data)
  assert.equal(result.candidates[0]?.pattern,'TREND_CONTINUATION_BREAK')
  assert.equal(result.candidates[0].side,d===1?'CALL':'PUT')
  const cap=d===1?112.5:87.5
  const capped=findMomentumSetups(data.candles,data.averages,data.indicators,data.interval,d===-1?cap:undefined,d===1?cap:undefined,result.alignment)
  assert.equal(capped[0].target,cap,'nearby opposing levels cannot be moved to force approval')
 }
})

test('an impulse needs RSI acceleration and a true range break, and rejects gaps and oversized spikes',()=>{
 function impulse(){
  const data=controlled()
  data.candles.at(-4)[2]=110.2
  data.candles.at(-1).splice(1,4,111.25,114.65,111.2,114.5)
  data.averages.at(-1).ema20=110
  data.indicators.at(-2).rsi14=55
  return data
 }
 assert.equal(find(impulse()).candidates[0]?.pattern,'DIRECTIONAL_IMPULSE_BREAK')
 for(const mutate of [
  data=>{data.indicators.at(-2).rsi14=65},
  data=>{data.candles.at(-4)[2]=116},
  data=>{data.candles.at(-1).splice(1,4,112.5,114.65,112.4,114.5)},
  data=>{data.candles.at(-1).splice(1,4,111.25,118,111,117.5);data.averages.at(-1).ema20=114},
 ]){const data=impulse();mutate(data);assert.equal(find(data).candidates.length,0)}
})

test('continuation needs a fresh event and cannot bypass gaps, wrong direction, missing RSI, indecision or extension limits',()=>{
 for(const mutate of [
  data=>{data.candles.at(-1)[0]=new Date(Date.parse(data.candles.at(-1)[0])+60000).toISOString()},
  data=>{data.candles.at(-4)[0]=new Date(Date.parse(data.candles.at(-4)[0])+60000).toISOString()},
  data=>{data.indicators.at(-1).rsi14=45},
  data=>{data.indicators.at(-1).rsi14=undefined},
  data=>{data.candles.at(-1)[1]=111.99},
  data=>{data.candles.at(-1).splice(1,4,112.4,113.1,112.3,113)},
  data=>{data.candles.at(-1).splice(1,4,111.25,113.6,111.15,113.5)},
  data=>{data.candles.at(-1).splice(1,4,111.25,111.4,111.1,111.3)},
 ]){
  const data=controlled();mutate(data)
  assert.equal(find(data).candidates.length,0)
 }
 const data=controlled(),alignment=find(data).alignment
 assert.equal(findMomentumSetups(data.candles,data.averages,data.indicators,data.interval,undefined,undefined,{...alignment,at:data.candles.at(-2)[0]}).length,0)
})

for(const kind of ['continuation','impulse'])for(const date of ['2026-10-14','2026-10-15','2026-10-16']){
 test(`generated ${kind} scenarios confirm both directions across seven instruments and three intervals on ${date}`,()=>{
  for(const market of markets)for(const interval of Object.keys(intervals))for(const d of [1,-1]){
   const input=scenario(market,d,interval,date,kind),{analysis,evidence,prediction}=assess(input,d)
   const pattern=kind==='continuation'?'TREND_CONTINUATION_BREAK':'DIRECTIONAL_IMPULSE_BREAK'
   const label=`${input.instrument} ${interval} ${d}: ${evidence.reason}`
   assert(analysis.detectedSetups?.some(item=>item.pattern===pattern),`${label}; expected ${pattern}`)
   assert.equal(evidence.canConfirm,true,label)
   assert.equal(prediction.plan?.stage,'CONFIRMED',`${label}; ${prediction.reason}`)
   assert.equal(prediction.side,d===1?'CALL':'PUT',label)
   assert(prediction.plan.riskReward>=1.2);assert(evidence.coverage>=70)
   assert.equal(evidence.layers.find(layer=>layer.key==='rsiVwap').weight,50)
   assert.equal(evidence.requiredScore,0);assert.equal(evidence.requiredGap,0)
   if(interval==='ONE_HOUR'&&!input.root){
    const datePart=new Date(input.now+19800000).toISOString().slice(0,10)
    assert(input.candles.filter(bar=>new Date(Date.parse(bar[0])+19800000).toISOString().startsWith(datePart)).length<7)
   }
  }
 })
}

test('a forming move, stale assessment, absent ATM data or nearby target cannot force full confirmation',()=>{
 const input=scenario(markets[0],1),base=assess(input,1)
 const forming=[new Date(input.now).toISOString(),25000,27000,24000,26000,1000]
 assert.deepEqual(analyzePriceAction([...input.candles,forming],input.interval,input.now,input.instrument),base.analysis)
 assert.equal(analyzeTradingEvidence({...input,analysis:base.analysis,now:input.now+intervals[input.interval]}).canConfirm,false)
 assert.equal(analyzeTradingEvidence({...input,analysis:base.analysis}).canConfirm,false)
 const selected=base.evidence.selectedAnalysis
 const target=selected.entry+.1*base.analysis.atr14
 const capped={...base.analysis,target,detectedSetups:base.analysis.detectedSetups.map(item=>({...item,target}))}
 const rejected=analyzeTradingEvidence({...input,analysis:capped,atmVwap:atmVwapFixture(input.instrument,base.analysis.currentPrice,input.now,1)})
 assert.equal(rejected.canConfirm,false)
 assert(rejected.decisions.find(item=>item.side==='CALL').reasons.includes('RR_BELOW_MINIMUM'))
 assert.equal(tradingEvidenceRules.minimumCoverage,70);assert.equal(tradingEvidenceRules.minimumRewardRisk,1.2)
})

test('newly detected opposite setups use the existing fresh post-entry reversal exit checks',()=>{
 for(const kind of ['continuation','impulse'])for(const d of [1,-1]){
  const input=scenario(markets[4],d,'FIVE_MINUTE','2026-10-16',kind),{prediction}=assess(input,d),plan=prediction.plan
  assert.equal(plan?.stage,'CONFIRMED')
  const oldSide=d===1?'PUT':'CALL',entryAt=Date.parse(plan.signalCandleTime)-60000
  const record={...createPredictionRecord({...plan,id:'older-position',side:oldSide}),status:'ACTIVE',entryAt,entryPrice:plan.entry,observedThrough:input.now,latestPrice:plan.entry,latestPriceAt:input.now,latestPriceSource:'LIVE'}
  const exited=observeConfirmedAgentReversal(record,plan,input.now)
  assert.equal(exited.status,'EARLY_EXIT');assert.equal(exited.earlyExitSource,'AGENT_REVERSAL')
  assert.equal(observeConfirmedAgentReversal({...record,entryAt:input.now-1000},plan,input.now).status,'ACTIVE')
  assert.equal(observeConfirmedAgentReversal({...record,latestPriceAt:input.now-31000},plan,input.now).status,'ACTIVE')
 }
})

test('zero-volume spot indices can confirm both directions with real ATM volume context, without changing thresholds',()=>{
 for(const market of markets.slice(0,3))for(const direction of [1,-1]){
  const input=scenario(market,direction,'FIVE_MINUTE')
  assert(input.candles.every(bar=>bar[5]===0))
  const analysis=analyzePriceAction(input.candles,input.interval,input.now,input.instrument)
  const missing=analyzeTradingEvidence({...input,analysis})
  assert.equal(missing.canConfirm,false)
  assert(missing.coverage<70)
  const atm=atmVwapFixture(input.instrument,analysis.currentPrice,input.now,direction)
  atm.method='BROKER_AVERAGE_PRICE'
  const ready=analyzeTradingEvidence({...input,analysis,atmVwap:atm})
  assert.equal(ready.canConfirm,true,`${input.instrument}: ${ready.reason}`)
  assert.equal(ready.requiredScore,missing.requiredScore);assert.equal(ready.requiredGap,missing.requiredGap)
  assert.equal(Math.round((ready.coverage-missing.coverage)*10)/10,25)
  assert(input.candles.every(bar=>bar[5]===0),'option volume must not alter spot candles')
 }
})
