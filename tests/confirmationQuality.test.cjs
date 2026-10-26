const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {assessConfirmationQuality,aggregateConfirmationCandles,passesConfirmationScore}=require('../src/analysis/confirmationQuality.ts')
const {analyzeMultiTimeframe,selectReversalPlan}=require('../src/analysis/multiTimeframe.ts')
const {analyzeTradingEvidence,technicalWeights,tradingEvidenceRules}=require('../src/analysis/tradingEvidence.ts')
const {analyzePriceAction}=require('../src/analysis/priceAction.ts')
const {createPredictionRecord,observePredictionTick,readPredictionHistory,writePredictionHistory}=require('../src/analysis/predictionHistory.ts')
const {mcxSession}=require('../src/analysis/commodities.ts')
const {markets,fixture,reversalFixture,duration}=require('./helpers/confirmation.cjs'),atm=require('./helpers/atmVwap.cjs')
const now=Date.parse('2026-10-26T14:00:00+05:30')
function input(row=markets[0],d=1,family='ACCEPTED_BREAK',interval='FIVE_MINUTE'){
 const f=fixture(row,d,interval,now,family),higher=interval==='FIVE_MINUTE'?'FIFTEEN_MINUTE':interval==='FIFTEEN_MINUTE'?'ONE_HOUR':undefined
 return{...f,interval,higherCandles:higher?fixture(row,d,higher,now).candles:undefined}
}
const quality=source=>assessConfirmationQuality({...source,candles:source.candles,now})
const contract=row=>row[3]?{name:row[0],root:row[3],token:'12345',symbol:row[3]+'20NOV26FUT',expiry:'2026-11-20',expiresAt:mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close,exchange:'MCX',exchangeType:5,tickSize:row[3]==='NATURALGAS'?.1:1}:undefined

test('accepted breaks and actual pullbacks qualify symmetrically across all seven instruments',()=>{
 for(const row of markets)for(const d of[1,-1])for(const family of['ACCEPTED_BREAK','PULLBACK']){
  const source=input(row,d,family),result=quality(source)
  assert.equal(result.passed,true,`${row[0]} ${d} ${family}: ${JSON.stringify(result.checks.filter(c=>!c.passed))}`)
  assert.equal(result.family,family);assert.equal(result.higherBias,source.side)
 }
})
test('all seven instruments can still confirm through the actual multi-timeframe score, pattern, volume and risk pipeline',()=>{
 for(const row of markets)for(const d of[1,-1]){
  const data=Object.fromEntries(['FIVE_MINUTE','FIFTEEN_MINUTE','ONE_HOUR'].map(interval=>[interval,fixture(row,d,interval,now).candles]))
  const source={instrument:row[0],now,contract:contract(row),candlesByInterval:data,atmVwap:row[3]?undefined:atm(row[0],data.FIVE_MINUTE.at(-1)[4],now,d)}
  const result=analyzeMultiTimeframe(source),five=result.reviews[0]
  assert(five.plan,`${row[0]} ${d}: ${five.reason}`);assert.equal(five.plan.side,d===1?'CALL':'PUT')
  assert.equal(five.plan.confirmationSnapshot.policy,'adaptive-confirmation-v3');assert(five.plan.confirmationSnapshot.passed)
  assert(five.plan.riskReward>=1.2);assert.equal(five.evidence.layers.reduce((sum,l)=>sum+l.weight,0),100)
  let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[createPredictionRecord(five.plan)])
  assert.equal(readPredictionHistory({getItem:()=>saved})[0].confirmationSnapshot.policy,'adaptive-confirmation-v3')
 }
 assert.equal(technicalWeights.rsiVwap,50);assert.equal(tradingEvidenceRules.minimumScore,0);assert.equal(tradingEvidenceRules.minimumGap,0)
})
test('the first impulse, a wick-only breakout, and repeated trend candles do not count as accepted entries',()=>{
 for(const d of[1,-1]){
  const source=input(markets[0],d),first={...source,candles:[...source.candles]}
  first.candles[50]=source.candle(source.slots[50],5,6.5,3.6,5.1)
  assert.equal(quality(first).checks.find(c=>c.code==='PRICE_ACCEPTANCE').passed,false)
  const wick={...source,candles:[...source.candles]};wick.candles[51]=source.candle(source.slots[51],6.8,12,5.8,6)
  assert.equal(quality(wick).passed,false)
  const plain={...source,candles:source.slots.map((time,i)=>source.candle(time,i*.1,i*.1+1.5,i*.1-1.4,i*.1+.1))}
  assert.equal(quality(plain).checks.find(c=>c.code==='PRICE_ACCEPTANCE').passed,false)
 }
})
test('flat ADX, a conflicting higher trend and an overextended candle produce explicit blockers',()=>{
 const source=input(),flat={...source,candles:source.slots.map(time=>source.candle(time,0,1,-1,0))}
 assert.equal(quality(flat).checks.find(c=>c.code==='TREND_REGIME').passed,false)
 const conflict={...source,higherCandles:fixture(markets[0],-1,'FIFTEEN_MINUTE',now).candles}
 assert.equal(quality(conflict).checks.find(c=>c.code==='HIGHER_TREND').passed,false)
 const late={...source,candles:[...source.candles]};late.candles[51]=source.candle(source.slots[51],7,20,6.5,19)
 assert.equal(quality(late).checks.find(c=>c.code==='ENTRY_EXTENSION').passed,false)
})
test('zero spot volume is not fabricated and commodities need real relative volume',()=>{
 assert.equal(quality(input()).checks.find(c=>c.code==='PARTICIPATION').passed,true)
 for(const row of markets.filter(r=>r[3])){
  const source=input(row),bad={...source,candles:source.candles.map(bar=>[...bar.slice(0,5),0])}
  assert.equal(quality(bad).checks.find(c=>c.code==='PARTICIPATION').passed,false)
  const thin={...source,candles:source.candles.map((bar,i)=>i===51?[...bar.slice(0,5),1]:bar)}
  assert.equal(quality(thin).passed,false)
 }
})
test('forming/future candles never improve confirmation or higher trend',()=>{
 const source=input(),expected=quality(source),future=source.candle(now,0,999,-100,998)
 assert.deepEqual(quality({...source,candles:[...source.candles,future],higherCandles:[...source.higherCandles,future]}),expected)
 assert.equal(quality({...source,higherCandles:[]}).passed,false)
 assert.equal(quality({...source,higherCandles:source.higherCandles.slice(0,-2)}).passed,false)
 assert.equal(quality({...source,candles:source.candles.filter((_,i)=>i!==50)}).passed,false)
})
test('higher bars aggregate only complete contiguous source candles and never bridge gaps',()=>{
 const source=input(),bars=aggregateConfirmationCandles(source.candles,'FIVE_MINUTE','FIFTEEN_MINUTE',source.instrument,now)
 assert(bars.length>0);assert(bars.every(b=>Date.parse(b[0])+900000<=now))
 const missing=source.candles.filter((_,i)=>i!==48),other=aggregateConfirmationCandles(missing,'FIVE_MINUTE','FIFTEEN_MINUTE',source.instrument,now)
 assert.equal(other.length,bars.length-1)
})
test('fresh matching VWAP is required by the revised live path without redistributing weights',()=>{
 const source=input(),analysis=analyzePriceAction(source.candles,source.interval,now,source.instrument),context={analysis,candles:source.candles,interval:source.interval,instrument:source.instrument,now,confirmationContext:{higherCandles:source.higherCandles}}
 const good=analyzeTradingEvidence({...context,atmVwap:atm(source.instrument,analysis.currentPrice,now,1)})
 assert(good.canConfirm,good.reason)
 const opposite=analyzeTradingEvidence({...context,atmVwap:atm(source.instrument,analysis.currentPrice,now,-1)})
 assert(!opposite.canConfirm);assert.equal(opposite.checks.find(c=>c.label==='VWAP confirmation').passed,false)
 const missing=analyzeTradingEvidence(context);assert(!missing.canConfirm)
 assert.equal(missing.layers.find(l=>l.key==='rsiVwap').weight,50)
})
test('saved policy snapshots survive actual entry and invalid snapshots cannot corrupt the ledger',()=>{
 const row=markets[0],data=Object.fromEntries(['FIVE_MINUTE','FIFTEEN_MINUTE','ONE_HOUR'].map(interval=>[interval,fixture(row,1,interval,now).candles]))
 const plan=analyzeMultiTimeframe({instrument:row[0],now,candlesByInterval:data,atmVwap:atm(row[0],data.FIVE_MINUTE.at(-1)[4],now,1)}).reviews[0].plan
 assert(plan);const active=observePredictionTick(createPredictionRecord(plan),plan.entry,now+1)
 assert.equal(active.status,'ACTIVE');assert(active.confirmationSnapshot.passed)
 const invalid={...active,confirmationSnapshot:{...active.confirmationSnapshot,passed:false}}
 assert.throws(()=>readPredictionHistory({getItem:()=>JSON.stringify({version:1,records:[invalid]})}),/preserved/)
})
test('confirmed structure reversals qualify before EMA crossover or ADX 20 in both directions across all instruments',()=>{
 for(const row of markets)for(const d of[1,-1]){
  const source=reversalFixture(row,d),higherCandles=fixture(row,-d,'FIFTEEN_MINUTE',now).candles
  const q=quality({...source,interval:'FIVE_MINUTE',higherCandles})
  assert(q.passed,`${row[0]} ${d}: ${JSON.stringify(q.checks.filter(c=>!c.passed))}`)
  assert.equal(q.setupType,'REVERSAL');assert.equal(q.family,'STRUCTURE_REVERSAL');assert.equal(q.higherBias,d===1?'PUT':'CALL')
  assert(d*(q.ema20-q.ema50)<0,'EMA crossover is still pending');assert(q.adx<20)
  assert.equal(q.requiredScore,65);assert.equal(q.requiredLead,20);assert(Number.isFinite(q.invalidationLevel))
 }
})
test('index reversals pass the full live pipeline, retain structural stops and qualify for a post-entry reversal exit',()=>{
 for(const row of markets.filter(r=>!r[3]))for(const d of[1,-1]){
  const f=reversalFixture(row,d),candlesByInterval={FIVE_MINUTE:f.candles,FIFTEEN_MINUTE:fixture(row,-d,'FIFTEEN_MINUTE',now).candles,ONE_HOUR:fixture(row,-d,'ONE_HOUR',now).candles}
  const result=analyzeMultiTimeframe({instrument:f.instrument,now,candlesByInterval,atmVwap:atm(f.instrument,f.candles.at(-1)[4],now,d)}),five=result.reviews[0],plan=five.plan
  assert(plan,`${row[0]} ${d}: ${five.reason}`);assert.equal(plan.confirmationSnapshot.setupType,'REVERSAL')
  assert((plan.entry-plan.stopLoss)*d>0);assert((plan.stopLoss-plan.confirmationSnapshot.invalidationLevel)*d<=0)
  assert(plan.riskReward>=1.2);assert.equal(five.evidence.requiredScore,65);assert.equal(five.evidence.requiredGap,20)
  assert.equal(selectReversalPlan({instrument:f.instrument,status:'ACTIVE',side:d===1?'PUT':'CALL',entryAt:now-1200000},result.reviews,now)?.id,plan.id)
  let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[createPredictionRecord(plan)])
  assert.equal(readPredictionHistory({getItem:()=>saved})[0].confirmationSnapshot.setupType,'REVERSAL')
 }
})
test('reversal observations cannot be supplied by a wick, a single impulse, future candles or missing higher history',()=>{
 const f=reversalFixture(),source={...f,interval:'FIVE_MINUTE',higherCandles:fixture(markets[0],-1,'FIFTEEN_MINUTE',now).candles}
 const expected=quality(source);assert(expected.passed)
 const first={...source,candles:[...source.candles]};first.candles[50]=source.candle(source.slots[50],1,4,0,1.5)
 assert.notEqual(quality(first).setupType,'REVERSAL');assert(!quality(first).passed)
 const wick={...source,candles:[...source.candles]};wick.candles[51]=source.candle(source.slots[51],3.9,5,1,2)
 assert(!quality(wick).passed)
 assert(!quality({...source,higherCandles:[]}).passed)
 assert.deepEqual(quality({...source,candles:[...source.candles,source.candle(now,5,50,4,49)]}),expected)
})
test('a slope turn alone remains a transition when the opposing structure has not broken',()=>{
 const f=reversalFixture(),candles=[...f.candles]
 candles[50]=f.candle(f.slots[50],1.8,3.3,1.7,3.1)
 candles[51]=f.candle(f.slots[51],3.1,3.5,3,3.4)
 const q=quality({...f,candles,interval:'FIVE_MINUTE',higherCandles:fixture(markets[0],-1,'FIFTEEN_MINUTE',now).candles})
 assert.equal(q.setupType,'TRANSITION');assert(!q.passed);assert.equal(q.checks.find(c=>c.code==='PRICE_ACCEPTANCE').passed,false)
})
test('exactly the configured indicator is required; another passing indicator cannot replace it',()=>{
 const f=input(),candles=[...f.candles];candles[51]=f.candle(f.slots[51],6.3,6.8,6.25,6.7)
 const source={...f,candles},ema=quality({...source,indicator:'EMA20_50'}),rsi=quality({...source,indicator:'RSI14'}),st=quality({...source,indicator:'SUPERTREND'})
 assert(ema.passed,ema.reason);assert(st.passed,st.reason)
 assert(!rsi.passed);assert.equal(rsi.indicator,'RSI14');assert.equal(rsi.checks.find(c=>c.code==='MOMENTUM_CONFIRMATION').passed,false)
 assert(!quality({...source,indicator:'INVALID'}).passed)
 for(const mode of['EMA20_50','RSI14','SUPERTREND']){
  const result=analyzeMultiTimeframe({instrument:f.instrument,now,confirmationIndicator:mode,candlesByInterval:{FIVE_MINUTE:candles,FIFTEEN_MINUTE:f.higherCandles,ONE_HOUR:fixture(markets[0],1,'ONE_HOUR',now).candles},atmVwap:atm(f.instrument,candles.at(-1)[4],now,1)})
  assert.equal(result.reviews[0].evidence.confirmation.indicator,mode)
  if(mode==='RSI14')assert.equal(result.reviews[0].plan,undefined)
 }
})
test('OI/PCR is reference-only; fixed technical and market-context weights stay unchanged',()=>{
 const f=input(),analysis=analyzePriceAction(f.candles,f.interval,now,f.instrument),source={analysis,candles:f.candles,interval:f.interval,instrument:f.instrument,now,confirmationContext:{higherCandles:f.higherCandles},atmVwap:atm(f.instrument,analysis.currentPrice,now)}
 const base=analyzeTradingEvidence(source)
 for(const d of[1,-1]){
  const context={instrument:f.instrument,revision:'oi',retrievedAt:new Date(now).toISOString(),articles:[],feeds:[],inputs:{global:[],openInterest:{status:'AVAILABLE',fetchedAt:new Date(now).toISOString(),data:{asOf:new Date(now).toISOString(),expiry:'2026-11-05',unit:'CONTRACTS',symbol:'NIFTY',pcr:d===1?1.6:.4,callOiChange:d===1?20:80,putOiChange:d===1?80:20}}}}
  const changed=analyzeTradingEvidence({...source,context})
  assert.deepEqual(changed.layers,base.layers.map(l=>l.key==='oi'?changed.layers.find(x=>x.key==='oi'):l))
  assert.equal(changed.bullishScore,base.bullishScore);assert.equal(changed.bearishScore,base.bearishScore);assert.equal(changed.coverage,base.coverage);assert.equal(changed.canConfirm,base.canConfirm)
  assert.equal(changed.layers.find(l=>l.key==='oi').weight,0);assert.equal(changed.layers.find(l=>l.key==='oi').coverage,0)
  assert.equal(changed.sentiment.layers.find(l=>l.key==='pcr'),undefined)
  assert.equal(changed.sentiment.bullishScore,base.sentiment.bullishScore);assert.equal(changed.sentiment.bearishScore,base.sentiment.bearishScore)
 }
 assert.equal(technicalWeights.chart,35);assert.equal(technicalWeights.indicators,15);assert.equal(technicalWeights.rsiVwap,50)
 assert.equal(base.requiredScore,60);assert.equal(base.requiredGap,20)
})
test('VIX flags high risk without a directional vote and raises continuation floors',()=>{
 const f=input(),analysis=analyzePriceAction(f.candles,f.interval,now,f.instrument),source={analysis,candles:f.candles,interval:f.interval,instrument:f.instrument,now,confirmationContext:{higherCandles:f.higherCandles},atmVwap:atm(f.instrument,analysis.currentPrice,now)},base=analyzeTradingEvidence(source)
 const indiaVix={status:'AVAILABLE',fetchedAt:new Date(now).toISOString(),data:{symbol:'^INDIAVIX',price:30,changePercent:12,asOf:new Date(now).toISOString()}}
 const high=analyzeTradingEvidence({...source,indiaVix})
 assert.equal(high.sentiment.state,'HIGH_RISK');assert.equal(high.requiredScore,65);assert.equal(high.requiredGap,20)
 assert.equal(high.bullishScore,base.bullishScore);assert.equal(high.bearishScore,base.bearishScore)
})
test('new history validation preserves v1 records and rejects malformed v2 reversal state',()=>{
 const row=markets[0],data=Object.fromEntries(['FIVE_MINUTE','FIFTEEN_MINUTE','ONE_HOUR'].map(interval=>[interval,fixture(row,1,interval,now).candles]))
 const plan=analyzeMultiTimeframe({instrument:row[0],now,candlesByInterval:data,atmVwap:atm(row[0],data.FIVE_MINUTE.at(-1)[4],now)}).reviews[0].plan
 const legacy=createPredictionRecord({...plan,confirmationSnapshot:{...plan.confirmationSnapshot,policy:'chart-confirmation-v1'}})
 let saved;writePredictionHistory({setItem:(_,v)=>saved=v},[legacy]);assert.equal(readPredictionHistory({getItem:()=>saved})[0].confirmationSnapshot.policy,'chart-confirmation-v1')
 const bad=createPredictionRecord({...plan,confirmationSnapshot:{...plan.confirmationSnapshot,setupType:'REVERSAL'}})
 assert.throws(()=>readPredictionHistory({getItem:()=>JSON.stringify({version:1,records:[bad]})}),/preserved/)
})
test('separate continuation/reversal score floors replace the ratio and preserve exact lead boundaries',()=>{
 assert(passesConfirmationScore(55,40,55,15),'55/40 passes 55/15 even though it does not satisfy a 1.5× ratio')
 assert(!passesConfirmationScore(54.9,0,55,15));assert(!passesConfirmationScore(55,40.1,55,15))
 assert(!passesConfirmationScore(64.9,0,65,20));assert(passesConfirmationScore(65,45,65,20))
 assert(!passesConfirmationScore(65,45.1,65,20));assert(!passesConfirmationScore(0,0,0,0))
 assert(!passesConfirmationScore(NaN,0,55,15));assert(!passesConfirmationScore(65,-1,65,20))
})
test('a neutral higher view is permitted but an extreme flat regime still blocks adaptive entry',()=>{
 const f=input(),higherCandles=f.higherCandles.map(bar=>[bar[0],f.base,f.base+1,f.base-1,f.base,0])
 const result=quality({...f,higherCandles,thresholdMode:'FIXED'})
 assert.equal(result.higherBias,'NEUTRAL');assert(result.passed,result.reason)
 const adaptive=quality({...f,higherCandles})
 assert.equal(adaptive.higherBias,'NEUTRAL');assert(!adaptive.passed);assert(adaptive.adaptive.blocked)
 assert.equal(quality({...f,higherCandles:[]}).higherBias,'UNAVAILABLE')
})
test('MCX reversal risk still rejects nearby opposing levels after widening to the structural stop',()=>{
 for(const row of markets.filter(r=>r[3]))for(const d of[1,-1]){
  const f=reversalFixture(row,d),result=analyzeMultiTimeframe({instrument:f.instrument,now,contract:contract(row),candlesByInterval:{FIVE_MINUTE:f.candles,FIFTEEN_MINUTE:fixture(row,-d,'FIFTEEN_MINUTE',now).candles,ONE_HOUR:fixture(row,-d,'ONE_HOUR',now).candles}}).reviews[0]
  assert.equal(result.evidence.confirmation.setupType,'REVERSAL');assert(result.evidence.confirmation.passed)
  assert.equal(result.plan,undefined,`${row[0]} ${d}: a target must not be stretched to force approval`)
  assert.match(result.reason,/reward.to.risk|reward to risk/i)
 }
})
test('a qualified price event supplies a candidate independently of the older combined-indicator routes',()=>{
 for(const d of[1,-1]){
  const f=reversalFixture(markets[0],d),raw=analyzePriceAction(f.candles,'FIVE_MINUTE',now,f.instrument)
  const analysis={...raw,side:'WAIT',pattern:'NO_CONFIRMED_PATTERN',detectedSetups:undefined,entry:undefined,stopLoss:undefined,target:undefined,alignment:{at:raw.latestCandleTime,routes:[]}}
  const evidence=analyzeTradingEvidence({analysis,candles:f.candles,interval:'FIVE_MINUTE',instrument:f.instrument,now,atmVwap:atm(f.instrument,f.candles.at(-1)[4],now,d),confirmationContext:{higherCandles:fixture(markets[0],-d,'FIFTEEN_MINUTE',now).candles}})
  assert(evidence.canConfirm,evidence.reason);assert.equal(evidence.selectedAnalysis.side,f.side)
  assert.equal(evidence.confirmation.setupType,'REVERSAL');assert.equal(evidence.selectedAnalysis.pattern,'LEVEL_BREAK_REVERSAL')
  assert(evidence.selectedAnalysis.targetBasis.includes('not an observed level'))
 }
})
