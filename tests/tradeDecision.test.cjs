const atmVwapFixture = require('./helpers/atmVwap.cjs')
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
const { analyzeTradingEvidence, tradingEvidenceRules } = require('../src/analysis/tradingEvidence.ts')
const { buildEarlyPrediction } = require('../src/analysis/earlyPrediction.ts')
const { diagnoseTradeEntry } = require('../src/analysis/tradeEntry.ts')
const { recordTradeDiagnostics, readTradeDiagnostics } = require('../src/analysis/tradeDecision.ts')
const { registerConfirmedPrediction, createPredictionRecord, syncPredictionRecord, canEnterConfirmedPrediction } = require('../src/analysis/predictionHistory.ts')
const now = Date.parse('2026-10-14T10:30:00+05:30')
function fixture(d=1,count=80,time=now) {
  const candles = Array.from({length:count},(_,i)=>{const close=100-d*(count-1-i)*.1;return[new Date(time-(count-i)*300000).toISOString(),close-d*.1,close+.2,close-.2,close,0]})
  const side=d===1?'CALL':'PUT'
  const analysis={side,pattern:d===1?'BREAKOUT_RETEST':'BREAKDOWN_RETEST',setup:'Completed retest',reason:'Fixture',phase:d===1?'UPTREND':'DOWNTREND',structure:'Fixture trend',structureEvent:'Established',location:'At level',candleBehavior:'Directional close',analyzedCandles:count,latestCandleTime:candles.at(-1)[0],currentPrice:100,entry:100,stopLoss:100-d*10,target:100+d*20,
    earlyBias:d===1?'BULLISH':'BEARISH',bullishScore:d===1?80:10,bearishScore:d===1?10:80,bullishEvidence:d===1?['Directional buying','Rising lows']:[],bearishEvidence:d===-1?['Directional selling','Falling highs']:[],movingAverage20:100-d,exponentialMovingAverage20:100-d*.8,exponentialMovingAverage50:100-d*2,rsi14:50,rsi14Momentum:0,atr14:2,supertrendDirection:d===1?'DOWN':'UP',alignment:{at:candles.at(-1)[0],routes:[{family:'EMA',side,name:'EMA trajectory'}]}}
  return {analysis,candles,instrument:'Nifty 50',interval:'FIVE_MINUTE',now:time,atmVwap:atmVwapFixture('Nifty 50',100,time,0)}
}

test('1.5x confirms standard CALL and PUT, while high VIX retains 65/20',()=>{
  assert.equal(tradingEvidenceRules.minimumScore,0);assert.equal(tradingEvidenceRules.minimumGap,0)
  for(const d of [1,-1]){
    const input=fixture(d), evidence=analyzeTradingEvidence(input), own=evidence.decisions.find(item=>item.side===input.analysis.side)
    assert.equal(evidence.canConfirm,true,evidence.reason);assert.equal(evidence.quality,'STANDARD')
    assert(own.supportScore>0 && own.supportScore>=1.5*own.opposingScore);assert.equal(own.state,'CONFIRMED')
    assert.equal(buildEarlyPrediction(input.analysis,input.instrument,input.interval,now,undefined,undefined,evidence).plan.stage,'CONFIRMED')
    for(const [price,changePercent] of [[26,0],[15,10]]) {
      const high=analyzeTradingEvidence({...input,indiaVix:{status:'AVAILABLE',fetchedAt:new Date(now).toISOString(),data:{symbol:'^INDIAVIX',price,changePercent,asOf:new Date(now).toISOString()}}})
      assert.equal(high.requiredScore,65);assert.equal(high.requiredGap,20);assert.equal(high.canConfirm,false)
      assert(high.decisions.find(item=>item.side===input.analysis.side).reasons.includes('SCORE_BELOW_THRESHOLD'))
    }
  }
})

test('opposite pipeline can confirm independently when the original chart selection fails',()=>{
  for(const d of [1,-1]) {
    const input=fixture(d), original={...input.analysis}, other=d===1?'PUT':'CALL'
    input.analysis={...input.analysis,side:other,pattern:d===1?'BREAKDOWN_RETEST':'BREAKOUT_RETEST',entry:100,stopLoss:100+d*10,target:100-d*20,detectedSetups:[{side:original.side,pattern:original.pattern,setup:original.setup,reason:'Other eligible setup',entry:100,stopLoss:original.stopLoss,target:original.target,score:80,confluence:[],invalidation:'Fixture'}]}
    const evidence=analyzeTradingEvidence(input)
    assert(evidence.canConfirm);assert.equal(evidence.selectedAnalysis.side,original.side)
    assert.equal(evidence.decisions.length,2);assert.equal(evidence.decisions.find(item=>item.side===original.side).state,'CONFIRMED')
    assert(evidence.decisions.find(item=>item.side===other).reasons.includes('NO_DIRECTIONAL_ROUTE'))
    assert.equal(buildEarlyPrediction(input.analysis,input.instrument,input.interval,now,undefined,undefined,evidence).plan.side,original.side)
  }
})

test('RR-rejected patterns stay visible with actual levels and cannot enter the ledger',()=>{
  const input=fixture();input.atmVwap=atmVwapFixture('Nifty 50',100,now,1);input.analysis.rsi14=70;input.analysis.rsi14Momentum=8;input.analysis={...input.analysis,side:'WAIT',pattern:'NO_CONFIRMED_PATTERN',detectedSetups:[{side:'CALL',pattern:'BREAKOUT_RETEST',setup:'Detected retest',reason:'Fixture',entry:100,stopLoss:95,target:105.5,score:80,confluence:[],invalidation:'Fixture'}]}
  const evidence=analyzeTradingEvidence(input), decision=evidence.decisions.find(item=>item.side==='CALL')
  assert.equal(decision.state,'EARLY');assert.equal(decision.riskReward,1.1);assert.equal(decision.entry,100)
  assert(decision.reasons.includes('RR_BELOW_MINIMUM'));assert.equal(evidence.canConfirm,false)
  const prediction=buildEarlyPrediction(input.analysis,input.instrument,input.interval,now,undefined,undefined,evidence)
  assert.equal(prediction.side,'WAIT');assert(!prediction.plan)
})

test('30-bar analysis can show an early candidate but cannot bypass EMA50 readiness',()=>{
  for(const d of [1,-1]) {
    const input=fixture(d,30);input.atmVwap=atmVwapFixture('Nifty 50',100,now,d)
    input.analysis.exponentialMovingAverage50=undefined;input.analysis.supertrendDirection=d===1?'UP':'DOWN';input.analysis.rsi14=d===1?70:30;input.analysis.rsi14Momentum=8*d
    input.analysis.alignment.routes=[{family:'SUPERTREND',side:input.analysis.side,name:'Supertrend trajectory'}]
    const result=analyzeTradingEvidence(input), own=result.decisions.find(item=>item.side===input.analysis.side)
    assert.equal(result.canConfirm,false);assert.equal(own.state,'EARLY');assert(own.reasons.includes('INDICATOR_NOT_READY'))
    assert(own.coverage>=60 && own.coverage<80)
    const insufficient=analyzeTradingEvidence({...input,candles:input.candles.slice(1),analysis:{...input.analysis,analyzedCandles:29}})
    assert.notEqual(insufficient.decisions.find(item=>item.side===input.analysis.side).state,'EARLY')
  }
})

test('all rejection codes are visible and freshness, ATR, session continuity and entry hours remain hard gates',()=>{
  const cases=[['STALE_DATA',input=>{input.now+=300000}],['ATR_INVALID',input=>{input.analysis.atr14=0}],['SESSION_DATA_GAP',input=>{input.candles.splice(-2,1)}],['OUTSIDE_ENTRY_WINDOW',()=>{}]]
  for(const [code,change] of cases) {
    const input=fixture(1,80,code==='OUTSIDE_ENTRY_WINDOW'?Date.parse('2026-10-14T15:25:00+05:30'):now);change(input)
    const result=analyzeTradingEvidence(input)
    assert.equal(result.canConfirm,false);assert(result.decisions[0].reasons.includes(code),`${code}: ${JSON.stringify(result.decisions[0].reasons)}`)
    assert.notEqual(result.decisions[0].state,'EARLY')
  }
})

test('entry diagnostics separate missing quote, unreached trigger, insufficient live RR and entered trades',()=>{
  const input=fixture(), evidence=analyzeTradingEvidence(input), plan=buildEarlyPrediction(input.analysis,input.instrument,input.interval,now,undefined,undefined,evidence).plan
  assert.equal(registerConfirmedPrediction([], {...plan,stage:'RISKY'},now).length,0)
  const time=now+1000,tick=price=>({timestamp:time,ltp:price})
  assert.equal(diagnoseTradeEntry(plan,undefined,true,time,false).checks.find(c=>c.code==='QUOTE_STALE').status,'FAIL')
  assert.equal(diagnoseTradeEntry(plan,tick(99),true,time,false).state,'AWAITING ENTRY')
  assert.equal(diagnoseTradeEntry(plan,tick(99),true,time,false).checks.find(c=>c.code==='RR_BELOW_MINIMUM').status,'NOT_CHECKED')
  assert.equal(diagnoseTradeEntry(plan,tick(100),true,time,false).state,'ELIGIBLE QUOTE')
  assert.equal(diagnoseTradeEntry(plan,tick(105),true,time,false).checks.find(c=>c.code==='RR_BELOW_MINIMUM').status,'FAIL')
  assert.equal(diagnoseTradeEntry(plan,tick(100),false,time,false).state,'ENTRY PAUSED')
  assert.equal(diagnoseTradeEntry(plan,tick(100),true,time+31000,false).checks.find(c=>c.code==='QUOTE_STALE').status,'FAIL')
  assert.equal(diagnoseTradeEntry(undefined,tick(100),true,time,false).state,'NOT CHECKED')
  assert.equal(diagnoseTradeEntry(plan,tick(100),true,time,true).state,'OPEN TRADE')
})

test('memory diagnostic log deduplicates heartbeats, stays bounded and exports both directions',()=>{
  const result=analyzeTradingEvidence(fixture()), instrument='Diagnostic fixture'
  const initial=readTradeDiagnostics().length
  recordTradeDiagnostics(instrument,'FIVE_MINUTE','fixture',now,result.decisions)
  recordTradeDiagnostics(instrument,'FIVE_MINUTE','fixture',now+1000,result.decisions)
  assert.equal(readTradeDiagnostics().length,initial+1)
  for(let i=0;i<500;i++)recordTradeDiagnostics(instrument,'FIVE_MINUTE',String(i),now+i,result.decisions)
  const log=readTradeDiagnostics(instrument)
  assert(log.length<=400);assert.equal(log.at(-1).decisions.length,2)
  log[0].decisions[0].reasons.push('MUTATION')
  assert(!readTradeDiagnostics(instrument)[0].decisions[0].reasons.includes('MUTATION'))
})


test('actual tracker rejects stale entry quotes and outside-hour entries while keeping open-trade exits active',()=>{
  const input=fixture(), evidence=analyzeTradingEvidence(input)
  const original=buildEarlyPrediction(input.analysis,input.instrument,input.interval,now,undefined,undefined,evidence).plan
  const plan={...original,generatedAt:now+5000}, record={...createPredictionRecord(plan),observedThrough:now+19000}
  const paused=syncPredictionRecord(record,input.candles,{timestamp:now+20000,ltp:100},now+60000,true,plan)
  assert.equal(paused.status,'PENDING');assert.equal(paused.entryAt,undefined)
  const late=Date.parse('2026-10-14T15:15:00+05:30'), latePlan={...original,generatedAt:late-2000,signalCandleTime:new Date(late-300000).toISOString(),expiresAt:late+900000}
  assert.equal(canEnterConfirmedPrediction(createPredictionRecord(latePlan),latePlan,late,late),false)
  const active={...createPredictionRecord(latePlan),status:'ACTIVE',entryAt:late-1000,entryPrice:100,observedThrough:late-1000}
  const closed=syncPredictionRecord(active,[],{timestamp:late,ltp:120},late,false)
  assert.equal(closed.status,'EARLY_EXIT');assert.equal(closed.earlyExitSource,'SESSION_SQUARE_OFF')
})

test('1.20 reward/risk is consistent in confirmation, planned levels, diagnostics and the actual entry fill',()=>{
 const {minimumRewardRisk,meetsMinimumRewardRisk}=require('../src/analysis/tradeRisk.ts')
 const {observePredictionTick}=require('../src/analysis/predictionHistory.ts')
 assert.equal(minimumRewardRisk,1.2)
 for(const value of [1.2,1.2000001,1.5])assert.equal(meetsMinimumRewardRisk(value),true)
 for(const value of [1.19999,1,0,NaN,Infinity])assert.equal(meetsMinimumRewardRisk(value),false)
 for(const d of [1,-1]){
  const input=fixture(d);input.analysis.target=100+d*12
  const evidence=analyzeTradingEvidence(input)
  assert.equal(evidence.canConfirm,true,evidence.reason)
  const decision=evidence.decisions.find(item=>item.side===input.analysis.side)
  assert.equal(decision.riskReward,1.2)
  assert.match(decision.checks.find(check=>check.code==='RR_BELOW_MINIMUM').detail,/1\.20:1 required/)
  const {plan}=buildEarlyPrediction(input.analysis,input.instrument,input.interval,now,undefined,undefined,evidence)
  assert.equal(plan.target,input.analysis.target,'a lower minimum must not move the original target')
  const record=createPredictionRecord(plan)
  const quote=price=>({token:'99926000',exchangeType:1,timestamp:now+1,ltp:price})
  assert.equal(diagnoseTradeEntry(plan,quote(100),true,now+1,false).state,'ELIGIBLE QUOTE')
  assert.equal(observePredictionTick(record,100,now+1).status,'ACTIVE')
  const slipped=100+d*.01
  assert.equal(diagnoseTradeEntry(plan,quote(slipped),true,now+1,false).state,'ENTRY PAUSED')
  assert.equal(observePredictionTick(record,slipped,now+1).status,'EXPIRED','slippage cannot consume the new minimum')
  const below=analyzeTradingEvidence({...input,analysis:{...input.analysis,target:100+d*11.9}})
  assert.equal(below.canConfirm,false)
 }
})
