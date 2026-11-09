const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {adjacentIndicatorBars,indicatorHistoryCounts}=require('../src/analysis/indicatorHistory.ts')
const {cachedCandleIndicators}=require('../src/analysis/candleIndicatorCache.ts')
const {analyzePriceAction}=require('../src/analysis/priceAction.ts')
const {analyzeTradingEvidence}=require('../src/analysis/tradingEvidence.ts')
const {analyzeMultiTimeframe}=require('../src/analysis/multiTimeframe.ts')
const {deriveAdaptiveThresholds}=require('../src/analysis/adaptiveConfirmation.ts')
const {indicatorTrajectoryRows}=require('../src/analysis/scoreTrajectory.ts')
const {calculateSessionVwap}=require('../src/analysis/vwap.ts')
const {mcxSession}=require('../src/analysis/commodities.ts')
const {fixture,markets,duration}=require('./helpers/confirmation.cjs'),atm=require('./helpers/atmVwap.cjs')
const at=s=>Date.parse(s+'+05:30'),day=86400000
function rollingFixture(row,d,interval,now,count=100){
 const f=fixture(row,d,interval,now,'ACCEPTED_BREAK',count),times=[],step=duration[interval]
 for(let back=20;back>=0;back--){
  const date=new Date(now-back*day).toISOString().slice(0,10),open=at(date+(row[3]?'T09:00:00':'T09:15:00'))
  if([0,6].includes(new Date(open).getUTCDay()))continue
  const close=row[3]?mcxSession(open).close:at(date+'T15:30:00')
  for(let time=open;time<close&&time+step<=now;time+=step)times.push(time)
 }
 const slots=times.slice(-count),candles=f.candles.map((b,i)=>[new Date(slots[i]).toISOString(),...b.slice(1)])
 return {...f,slots,candles}
}

test('indicator continuity spans regular overnight/weekend closures for each market and timeframe',()=>{
 for(const row of markets)for(const [interval,step] of Object.entries(duration)){
  const now=at(row[3]?'2026-11-02T10:00:00':'2026-11-02T10:15:00'),f=rollingFixture(row,1,interval,now,52)
  for(let i=1;i<f.candles.length;i++)assert(adjacentIndicatorBars(f.slots[i-1],f.slots[i],step,row[0]),`${row[0]} ${interval} ${f.candles[i][0]}`)
 }
 assert(!adjacentIndicatorBars(at('2026-10-30T15:20:00'),at('2026-11-02T09:15:00'),300000,'Nifty 50'),'a missing closing bar is not a regular closure')
 assert(!adjacentIndicatorBars(at('2026-10-30T15:25:00'),at('2026-11-02T09:20:00'),300000,'Nifty 50'),'a missing opening bar must be backfilled')
 assert(!adjacentIndicatorBars(at('2026-11-02T10:00:00'),at('2026-11-02T10:10:00'),300000,'Nifty 50'))
 assert(!adjacentIndicatorBars(at('2026-10-29T15:25:00'),at('2026-11-02T09:15:00'),300000,'Nifty 50'),'an absent weekday is not guessed to be a holiday')
})

test('three new candles plus previous-session history can confirm without waiting for fifty today',()=>{
 for(const row of markets)for(const d of[1,-1]){
  const now=at(row[3]?'2026-11-02T09:15:00':'2026-11-02T09:30:00')
  const five=rollingFixture(row,d,'FIVE_MINUTE',now),fifteen=rollingFixture(row,d,'FIFTEEN_MINUTE',now)
  const counts=indicatorHistoryCounts(five.candles,now)
  assert.equal(counts.currentSessionBars,3);assert.equal(counts.previousSessionBars,97)
  const contract=row[3]?{name:row[0],root:row[3],token:'12345',symbol:row[3]+'20NOV26FUT',expiry:'2026-11-20',expiresAt:mcxSession(at('2026-11-20T12:00:00')).close,exchange:'MCX',exchangeType:5,tickSize:row[3]==='NATURALGAS'?.1:1}:undefined
  const review=analyzeMultiTimeframe({instrument:row[0],contract,now,candlesByInterval:{FIVE_MINUTE:five.candles,FIFTEEN_MINUTE:fifteen.candles},atmVwap:row[3]?undefined:atm(row[0],five.candles.at(-1)[4],now,d)}).reviews[0]
  assert(review.evidence.checks.find(c=>c.label==='Indicator warmup').passed,review.reason)
  assert(review.evidence.coverage>=70);assert(review.evidence.confirmation.passed,review.evidence.confirmation.reason)
  assert(review.plan,`${row[0]} ${d}: ${review.reason}`)
  assert.deepEqual(review.evidence.indicatorHistory,counts)
  const recent=analyzePriceAction(five.candles.slice(-3),'FIVE_MINUTE',now,row[0])
  assert.equal(recent.exponentialMovingAverage50,undefined,'today alone is insufficient, but historical warmup supplies EMA50')
 }
})

test('RSI swing coverage and EMA trajectories use rolling history rather than resetting each morning',()=>{
 const now=at('2026-11-02T09:30:00'),f=rollingFixture(markets[0],1,'FIVE_MINUTE',now,75)
 const candles=f.candles.map((b,i)=>{const close=22000-3*i+.05*i*i+20*Math.sin(i);return[b[0],close-1,close+2,close-2,close,0]})
 const continuous=candles.map((b,i)=>[new Date(now-(75-i)*300000).toISOString(),...b.slice(1)])
 const actual=cachedCandleIndicators(candles,'FIVE_MINUTE',now,'Nifty 50'),reference=cachedCandleIndicators(continuous,'FIVE_MINUTE',now,'Nifty 50')
 assert.deepEqual(actual.averages,reference.averages);assert.deepEqual(actual.trajectory.indicatorSeries,reference.trajectory.indicatorSeries)
 assert.equal(actual.trajectory.slopeVote,reference.trajectory.slopeVote)
 const rsi=result=>result.trajectory.swingEvidence.find(e=>e.name==='RSI').structure
 assert.notEqual(rsi(actual).trend,'WARMING_UP');assert.deepEqual(rsi(actual),rsi(reference))
 const analyze=bars=>analyzeTradingEvidence({analysis:analyzePriceAction(bars,'FIVE_MINUTE',now,'Nifty 50'),candles:bars,interval:'FIVE_MINUTE',instrument:'Nifty 50',now,confirmationContext:{},atmVwap:atm('Nifty 50',bars.at(-1)[4],now)})
 const evidence=analyze(candles),baseline=analyze(continuous)
 assert.equal(evidence.coverage,baseline.coverage);assert.equal(evidence.coverage,100)
 const missing=analyzeTradingEvidence({analysis:analyzePriceAction(candles,'FIVE_MINUTE',now,'Nifty 50'),candles,interval:'FIVE_MINUTE',instrument:'Nifty 50',now,confirmationContext:{}})
 assert.equal(missing.coverage,evidence.coverage-25);assert(!missing.canConfirm,'old indicator history does not replace missing current ATM VWAP')
 const displayed=indicatorTrajectoryRows(actual.closed.map((b,i)=>({at:Date.parse(b[0]),bullish:0,bearish:0,indicators:{RSI:actual.trajectory.indicatorSeries[i].rsi14}})),300000,'Nifty 50').find(r=>r.name==='RSI')
 assert.deepEqual(displayed.structure,rsi(actual),'displayed swings and scoring must use the same historical observations')
 const forming=[new Date(now).toISOString(),23000,25000,21000,24000,0]
 assert.deepEqual(cachedCandleIndicators([...candles,forming],'FIVE_MINUTE',now,'Nifty 50'),actual)
 const next=cachedCandleIndicators([...candles,forming],'FIVE_MINUTE',now+300000,'Nifty 50')
 assert.equal(next.closed.length,76);assert.notDeepEqual(next.trajectory.indicatorSeries.at(-1),actual.trajectory.indicatorSeries.at(-1))
})

test('regime chop carries the previous session while stale signals, missing bars and session VWAP stay explicit',()=>{
 for(const row of markets){
  const now=at(row[3]?'2026-11-02T09:15:00':'2026-11-02T09:30:00'),f=rollingFixture(row,1,'FIFTEEN_MINUTE',now)
  const result=deriveAdaptiveThresholds({candles:f.candles,instrument:row[0],now,side:'CALL',reversal:false,higherAligned:true})
  assert(result.ready,`${row[0]}: ${result.reason}`);assert.equal(result.baselineBars,50)
  const stale=deriveAdaptiveThresholds({candles:f.candles,instrument:row[0],now:now+900000,side:'CALL',reversal:false,higherAligned:true})
  assert(stale.blocked);assert.equal(stale.regime,'UNAVAILABLE')
 }
 const now=at('2026-11-02T09:30:00'),f=rollingFixture(markets[0],1,'FIVE_MINUTE',now)
 const broken=f.candles.filter((_,i)=>i!==98),cached=cachedCandleIndicators(broken,'FIVE_MINUTE',now,'Nifty 50')
 assert.equal(cached.trajectory.slopeVote,undefined)
 assert.equal(cached.trajectory.swingEvidence.find(e=>e.name==='RSI').structure.trend,'WARMING_UP')
 const volume=f.candles.map((b,i)=>[b[0],100,101,99,100,i<97?1000:0])
 assert.equal(calculateSessionVwap(volume).at(-1),undefined,'yesterday\'s volume cannot manufacture today\'s VWAP')
})
