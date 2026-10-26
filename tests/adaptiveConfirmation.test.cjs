const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {deriveAdaptiveThresholds,validSavedAdaptive}=require('../src/analysis/adaptiveConfirmation.ts')
const {assessConfirmationQuality}=require('../src/analysis/confirmationQuality.ts')
const {analyzeMultiTimeframe}=require('../src/analysis/multiTimeframe.ts')
const {createPredictionRecord,readPredictionHistory,writePredictionHistory}=require('../src/analysis/predictionHistory.ts')
const {fixture,reversalFixture,markets}=require('./helpers/confirmation.cjs'),atm=require('./helpers/atmVwap.cjs')
const {mcxSession}=require('../src/analysis/commodities.ts')
const now=Date.parse('2026-10-26T14:00:00+05:30')
const regime=(row=markets[0],d=1)=>fixture(row,d,'FIFTEEN_MINUTE',now,'ACCEPTED_BREAK',100)
const calculate=(f,changes={})=>deriveAdaptiveThresholds({candles:f.candles,instrument:f.instrument,now,side:f.side,reversal:false,higherAligned:true,...changes})
const contract=row=>row[3]?{name:row[0],root:row[3],token:'12345',symbol:row[3]+'20NOV26FUT',expiry:'2026-11-20',expiresAt:mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close,exchange:'MCX',exchangeType:5,tickSize:row[3]==='NATURALGAS'?.1:1}:undefined

test('strong completed trends use bounded floors symmetrically on all seven markets',()=>{
 for(const row of markets)for(const d of[1,-1]){
  const f=regime(row,d),r=calculate(f)
  assert(r.ready,`${row[0]}: ${r.reason}`);assert.equal(r.regime,'STRONG_TREND');assert.equal(r.direction,f.side)
  assert.equal(r.minimumScore,55);assert.equal(r.minimumLead,15);assert.equal(r.minimumAdx,18)
  assert.equal(r.baselineBars,50);assert(r.relativeAtr>0);assert.equal(r.blocked,false)
  assert(validSavedAdaptive(r,now,false))
 }
})
test('higher volatility raises requirements even when ADX is very strong, with extreme regimes returning WAIT',()=>{
 const f=regime(),baseline=calculate(f)
 const expand=(count,width)=>f.candles.map((b,i)=>i>=f.candles.length-count?[b[0],b[1],b[4]+width,b[4]-width,b[4],b[5]]:b)
 const high=calculate({...f,candles:expand(3,8)})
 assert.equal(high.regime,'HIGH_VOLATILITY');assert(high.relativeAtr>=1.5&&high.relativeAtr<2.5)
 assert(high.minimumScore>=65&&high.minimumScore>baseline.minimumScore);assert(high.minimumLead>=20);assert(high.minimumAdx>=22)
 const extreme=calculate({...f,candles:expand(6,20)})
 assert(extreme.blocked);assert(extreme.relativeAtr>=2.5);assert(!validSavedAdaptive(extreme,now,false))
})
test('chop and repeated direction changes raise floors or block without inventing index VWAP',()=>{
 const f=regime(),start=f.candles.length-13
 function changed(pattern){return f.candles.map((b,i)=>{if(i<start)return b;const v=3+pattern[i-start];return f.candle(Date.parse(b[0]),v-.1,v+1.5,v-1.4,v,100)})}
 const mixed=calculate({...f,candles:changed([0,1,2,1,2,3,2,3,4,3,4,5,6])})
 assert(mixed.chop>0);assert(mixed.minimumScore>=65);assert(mixed.minimumLead>=20);assert.equal(mixed.vwapCrossings,undefined)
 const oscillating=calculate({...f,candles:changed([0,1,0,1,0,1,0,1,0,1,0,1,0])})
 assert(oscillating.blocked);assert(oscillating.chop>=.8)
})
test('one regime is stable between 15-minute closes and cannot see forming/future observations',()=>{
 const f=regime(),r=calculate(f),forming=f.candle(now,5,100,-100,80,50000)
 assert.deepEqual(calculate(f,{now:now+5*60000}),r)
 assert.deepEqual(calculate({...f,candles:[...f.candles,forming]},{now:now+10*60000}),r)
 assert.deepEqual(calculate({...f,candles:[...f.candles,forming]}),r)
 const next=calculate({...f,candles:[...f.candles,forming]},{now:now+15*60000})
 assert.notEqual(next.asOf,r.asOf)
 assert.equal(calculate(f,{now:now+15*60000}).regime,'UNAVAILABLE')
})
test('insufficient baselines use explicit conservative fallback; absent regime data cannot confirm',()=>{
 const f=fixture(markets[0],1,'FIFTEEN_MINUTE',now),r=calculate(f)
 assert.equal(r.regime,'WARMING_UP');assert.equal(r.relativeAtr,undefined);assert(r.baselineBars<50)
 assert.equal(r.minimumScore,60);assert.equal(r.minimumLead,20)
 const reversal=calculate(f,{reversal:true});assert.equal(reversal.minimumScore,65);assert.equal(reversal.minimumLead,20);assert.equal(reversal.minimumAdx,0)
 assert(calculate({...f,candles:[]}).blocked)
})
test('a known extreme volatility reading cannot be bypassed while early-session chop warms up',()=>{
 const early=Date.parse('2026-10-26T10:00:00+05:30'),f=fixture(markets[0],1,'FIFTEEN_MINUTE',early,'ACCEPTED_BREAK',100)
 const candles=f.candles.map((bar,i)=>i>=f.candles.length-3?[bar[0],bar[1],bar[4]+30,bar[4]-30,bar[4],bar[5]]:bar)
 const result=calculate({...f,candles},{now:early})
 assert.equal(result.ready,false);assert.equal(result.chop,undefined);assert(result.relativeAtr>=2.5);assert(result.blocked)
 assert(!validSavedAdaptive({...result,blocked:false},early,false))
})
test('live adaptive continuation still confirms both directions across all instruments and saves the exact policy',()=>{
 for(const row of markets)for(const d of[1,-1]){
  const f=fixture(row,d),candlesByInterval={FIVE_MINUTE:f.candles,FIFTEEN_MINUTE:regime(row,d).candles,ONE_HOUR:fixture(row,d,'ONE_HOUR',now).candles}
  const assessment=analyzeMultiTimeframe({instrument:f.instrument,contract:contract(row),now,candlesByInterval,atmVwap:row[3]?undefined:atm(f.instrument,f.candles.at(-1)[4],now,d)}),review=assessment.reviews[0]
  assert(review.plan,`${row[0]} ${d}: ${review.reason}`);assert.equal(review.evidence.requiredScore,55)
  assert.equal(review.plan.confirmationSnapshot.policy,'adaptive-confirmation-v3');assert(review.plan.confirmationSnapshot.adaptive.ready)
  let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[createPredictionRecord(review.plan)])
  assert.deepEqual(readPredictionHistory({getItem:()=>saved})[0].confirmationSnapshot,JSON.parse(JSON.stringify(review.plan.confirmationSnapshot)))
 }
})
test('early reversals do not wait for EMA crossover, ADX20 or an aligned slower trend',()=>{
 for(const row of markets)for(const d of[1,-1]){
  const f=reversalFixture(row,d),higher=regime(row,-d)
  const q=assessConfirmationQuality({...f,interval:'FIVE_MINUTE',higherCandles:higher.candles,regimeCandles:higher.candles,now})
  assert(q.passed,`${row[0]} ${d}: ${q.reason}`);assert.equal(q.setupType,'REVERSAL');assert.equal(q.requiredScore,65)
  assert.equal(q.adaptive.minimumAdx,0);assert(q.adx<20);assert(d*(q.ema20-q.ema50)<0)
  if(!row[3]){
   const result=analyzeMultiTimeframe({instrument:f.instrument,now,candlesByInterval:{FIVE_MINUTE:f.candles,FIFTEEN_MINUTE:higher.candles,ONE_HOUR:fixture(row,-d,'ONE_HOUR',now).candles},atmVwap:atm(f.instrument,f.candles.at(-1)[4],now,d)})
   assert(result.reviews[0].plan,result.reviews[0].reason)
  }
 }
})
test('adaptive metadata is validated without making old v2 snapshots unreadable',()=>{
 const f=fixture(),frames={FIVE_MINUTE:f.candles,FIFTEEN_MINUTE:regime().candles,ONE_HOUR:fixture(markets[0],1,'ONE_HOUR',now).candles}
 const source={instrument:f.instrument,now,candlesByInterval:frames,atmVwap:atm(f.instrument,f.candles.at(-1)[4],now)}
 const adaptive=analyzeMultiTimeframe(source).reviews[0].plan,fixed=analyzeMultiTimeframe({...source,thresholdMode:'FIXED'}).reviews[0].plan
 assert.equal(fixed.confirmationSnapshot.policy,'structure-confirmation-v2')
 let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[createPredictionRecord(fixed)])
 assert.equal(readPredictionHistory({getItem:()=>saved})[0].confirmationSnapshot.policy,'structure-confirmation-v2')
 for(const change of[{minimumScore:0},{closedAt:now+1},{blocked:true},{chop:1},{relativeAtr:9}]){
  const bad=createPredictionRecord({...adaptive,confirmationSnapshot:{...adaptive.confirmationSnapshot,adaptive:{...adaptive.confirmationSnapshot.adaptive,...change}}})
  assert.throws(()=>readPredictionHistory({getItem:()=>JSON.stringify({version:1,records:[bad]})}),/preserved/)
 }
})
test('VIX cannot relax adaptive floors, and the actual applied thresholds are saved',()=>{
 const f=fixture(),frames={FIVE_MINUTE:f.candles,FIFTEEN_MINUTE:regime().candles,ONE_HOUR:fixture(markets[0],1,'ONE_HOUR',now).candles}
 const indiaVix={status:'AVAILABLE',fetchedAt:new Date(now).toISOString(),data:{symbol:'^INDIAVIX',price:30,changePercent:15,asOf:new Date(now).toISOString()}}
 const source={instrument:f.instrument,now,candlesByInterval:frames,atmVwap:atm(f.instrument,f.candles.at(-1)[4],now),indiaVix}
 const review=analyzeMultiTimeframe(source).reviews[0]
 assert(review.plan,review.reason);assert.equal(review.evidence.requiredScore,65);assert.equal(review.evidence.requiredGap,20)
 assert.equal(review.plan.confirmationSnapshot.adaptive.minimumScore,55)
 assert.equal(review.plan.confirmationSnapshot.appliedScore,65);assert.equal(review.plan.confirmationSnapshot.appliedLead,20)
 let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[createPredictionRecord(review.plan)])
 assert.equal(readPredictionHistory({getItem:()=>saved})[0].confirmationSnapshot.appliedScore,65)
})
test('the 1.20 risk boundary and actual quote checks still hold under adaptive thresholds',()=>{
 const {diagnoseTradeEntry}=require('../src/analysis/tradeEntry.ts')
 const f=fixture(),frames={FIVE_MINUTE:f.candles,FIFTEEN_MINUTE:regime().candles,ONE_HOUR:fixture(markets[0],1,'ONE_HOUR',now).candles}
 const plan=analyzeMultiTimeframe({instrument:f.instrument,now,candlesByInterval:frames,atmVwap:atm(f.instrument,f.candles.at(-1)[4],now)}).reviews[0].plan
 assert(plan);const quote=plan.target-1.2*(plan.target-plan.stopLoss)/2.2
 const tick=ltp=>({token:'99926000',exchangeType:1,ltp,timestamp:now+1000,receivedAt:now+1000})
 const eligible=diagnoseTradeEntry(plan,tick(plan.entry),true,now+1000,false)
 assert.equal(eligible.state,'ELIGIBLE QUOTE');assert(eligible.checks.some(c=>c.code==='RR_BELOW_MINIMUM'&&c.status==='PASS'))
 const late=diagnoseTradeEntry(plan,tick(quote+.1),true,now+1000,false)
 assert(late.checks.some(c=>c.code==='RR_BELOW_MINIMUM'&&c.status==='FAIL'))
 assert.equal(diagnoseTradeEntry(plan,tick(plan.entry),false,now+1000,false).state,'ENTRY PAUSED')
})
