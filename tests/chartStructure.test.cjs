const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {analyzeChartStructure,completedChartHistory,observedSessionGap,trendLinePrice}=require('../src/analysis/chartStructure.ts')
const {chartStructureOverlay}=require('../src/analysis/chartStructureOverlay.ts')
const {analyzeCandleAgent}=require('../src/analysis/candleAgent.ts')
const {fixture,markets}=require('./helpers/confirmation.cjs')
const now=Date.parse('2026-11-04T14:00:00+05:30'),step=300000
function trendFixture(d=1){
 const f=fixture(markets[0],d,'FIVE_MINUTE',now)
 f.candles=f.slots.map((t,i)=>{const v=10+i*.1+[2,1,0,1,2,3][i%6];return f.candle(t,v+.7,v+2,v,v+1,0)})
 return f
}
const assess=f=>analyzeCandleAgent({candles:f.candles,instrument:f.instrument,now})
test('mirrored HH/HL and LH/LL trends have three-touch validated lines; two anchors remain provisional',()=>{
 for(const d of[1,-1]){
  const f=trendFixture(d),s=analyzeChartStructure(f.candles,.01)
  assert.equal(s.trend,d===1?'UPTREND':'DOWNTREND')
  const line=s.lines.find(l=>l.kind===(d===1?'SUPPORT':'RESISTANCE'))
  assert(line?.validated);assert(line.touches>=3);assert(d*line.slope>0)
  assert(s.swings.some(p=>p.label===(d===1?'HL':'LH')))
  const two=analyzeChartStructure(f.candles.slice(0,12),.01).lines.find(l=>l.kind===line.kind)
  assert(two);assert.equal(two.validated,false);assert.equal(two.touches,2)
  assert.equal(analyzeChartStructure(f.candles.slice(0,10),.01).swings.some(p=>p.index===8),false)
 }
})
test('never force a rising support line through an intervening close below it',()=>{
 const f=trendFixture(),s=analyzeChartStructure(f.candles,.01),line=s.lines.find(l=>l.kind==='SUPPORT')
 const bars=f.candles.map(b=>[...b]);bars[30]=f.candle(f.slots[30],0,1,-1,0)
 const broken=analyzeChartStructure(bars,.01)
 assert(!broken.lines.some(l=>l.start.at===line.start.at&&l.anchor.at===line.anchor.at))
})
test('repeated pivot zones require two closes to flip roles; a wick or one close is insufficient',()=>{
 const f=fixture(markets[0],1,'FIVE_MINUTE',now)
 const bars=f.slots.map((t,i)=>f.candle(t,5,6,i===20||i===30?0:4,5,0))
 const support=analyzeChartStructure(bars,.01).zones.find(z=>z.originalRole==='SUPPORT')
 assert.equal(support.touches,2);assert.equal(support.flipped,false)
 bars[50]=f.candle(f.slots[50],5,6,-2,5)
 assert.equal(analyzeChartStructure(bars,.01).zones.find(z=>z.firstAt===support.firstAt).flipped,false)
 bars[50]=f.candle(f.slots[50],-1,0,-2,-1)
 assert.equal(analyzeChartStructure(bars.slice(0,51),.01).zones.find(z=>z.firstAt===support.firstAt).flipped,false)
 bars[51]=f.candle(f.slots[51],-1,0,-2,-1)
 const flipped=analyzeChartStructure(bars,.01).zones.find(z=>z.firstAt===support.firstAt)
 assert.equal(flipped.role,'RESISTANCE');assert.equal(flipped.flipped,true)
})
test('trend pullback signals require validated price structure and respect nearby opposing targets',()=>{
 for(const d of[1,-1]){
  const f=trendFixture(d)
  f.candles[50]=f.candle(f.slots[50],15.8,16.7,15,16.2,0)
  f.candles[51]=f.candle(f.slots[51],16.1,18.6,16,18.4,0)
  const a=assess(f)
  assert.equal(a.signal?.pattern,'TREND_PULLBACK');assert.equal(a.signal.side,f.side)
  assert(a.signal.chartStructure.lines.some(l=>l.validated))
  assert(a.plan,'a nearby opposing swing no longer blocks confirmation through a ratio floor')
  assert(a.plan.riskReward>0&&a.plan.riskReward<1.2)
  assert.equal(a.plan.targetBasis,'Nearest observed opposing swing, price zone or unfilled gap edge')
 }
})
function doubleFixture(d){
 const f=fixture(markets[0],d,'FIVE_MINUTE',now)
 const top=(t,o,h,l,c)=>f.candle(t,-o,-l,-h,-c,0)
 f.candles=f.slots.map((t,i)=>i<35?top(t,i*.2,i*.2+1,i*.2-1,i*.2+.1):top(t,13,14,12,13))
 f.candles[38]=top(f.slots[38],15,16,14,15)
 f.candles[41]=top(f.slots[41],11,12,10,11)
 f.candles[44]=top(f.slots[44],15,16.05,14,15)
 f.candles[50]=top(f.slots[50],9.8,10,9.3,9.5)
 f.candles[51]=top(f.slots[51],9.4,9.6,8.7,8.9)
 return f
}
test('double bottoms/tops stay potential until their neckline has two accepted closes',()=>{
 for(const d of[1,-1]){
  const f=doubleFixture(d),a=assess(f)
  assert.equal(a.signal?.pattern,d===1?'DOUBLE_BOTTOM_BREAK':'DOUBLE_TOP_BREAK')
  assert.equal(a.signal.side,f.side)
  assert.equal(a.signal.level,d===1?f.base-10:f.base+10)
  const pending=analyzeCandleAgent({candles:f.candles,instrument:f.instrument,now:now-step})
  assert(!pending.signal?.pattern.startsWith('DOUBLE_'))
  const invalid=doubleFixture(d);invalid.candles[44]=invalid.candle(invalid.slots[44],-15,-14,-18,-15)
  assert(!assess(invalid).signal?.pattern.startsWith('DOUBLE_'),'unequal turning points cannot become a double pattern')
 }
})
test('missing bars and forming/future extremes cannot establish chart geometry',()=>{
 const f=trendFixture(),full=assess(f)
 assert.deepEqual(assess({...f,candles:[...f.candles,f.candle(now,500,999,-100,800)]}),full)
 const broken=completedChartHistory(f.candles.filter((_,i)=>i!==45),f.instrument,now)
 assert.equal(broken.tail.length,6)
 assert(!analyzeChartStructure(broken.tail,.01).lines.some(l=>l.validated))
 const bad=[...f.candles,[new Date(now-step+1000).toISOString(),22000,22001,21999,22000,0]]
 assert.equal(completedChartHistory(bad,f.instrument,now).closed.length,f.candles.length)
})
test('session gaps need complete prior observations and track partial/filled state without predicting exhaustion',()=>{
 const prior=Date.parse('2026-11-03T09:15:00+05:30'),open=Date.parse('2026-11-04T09:15:00+05:30')
 const previous=Array.from({length:75},(_,i)=>[new Date(prior+i*step).toISOString(),100,105,95,101,0])
 const first=[new Date(open).toISOString(),110,113,109,112,0]
 const gap=observedSessionGap([...previous,first],'Nifty 50')
 assert.deepEqual({direction:gap.direction,state:gap.state,low:gap.low,high:gap.high},{direction:'UP',state:'OPEN',low:105,high:109})
 assert.equal(observedSessionGap([...previous.slice(1),first],'Nifty 50'),undefined)
 assert.equal(observedSessionGap([...previous,[...first.slice(0,3),104,112,0]],'Nifty 50'),undefined)
 const next=[new Date(open+step).toISOString(),112,113,107,110,0]
 assert.equal(observedSessionGap([...previous,first,next],'Nifty 50').state,'PARTIAL')
 assert.equal(observedSessionGap([...previous,first,[...next.slice(0,3),104,110,0]],'Nifty 50').state,'FILLED')
 const mirror=bars=>bars.map(([t,o,h,l,c,v])=>[t,300-o,300-l,300-h,300-c,v])
 assert.equal(observedSessionGap(mirror([...previous,first]),'Nifty 50').direction,'DOWN')
})
test('chart overlays map actual bar timestamps, draw sloped lines and label only confirmed swings',()=>{
 const f=trendFixture(),s=analyzeChartStructure(f.candles,.01),overlay=chartStructureOverlay(s,f.candles)
 assert(overlay.lines.length);assert(overlay.points.some(p=>p.label.text==='HH'));assert(overlay.points.some(p=>p.label.text==='HL'))
 for(const line of overlay.lines){
  assert.equal(line.data.at(-1).x,51)
  assert.notEqual(line.data[0].y,line.data.at(-1).y)
  const source=s.lines.find(l=>line.name.startsWith(l.kind==='SUPPORT'?'Rising':'Falling'))
  assert.equal(line.data.at(-1).y,trendLinePrice(source,51))
 }
 assert(overlay.points.every(p=>p.x<=49));assert(overlay.zones.length<=4)
})
test('trend-line reversals also need two closes beyond the last opposing swing',()=>{
 for(const d of[1,-1]){
  const f=trendFixture(-d)
  f.candles[50]=f.candle(f.slots[50],13.2,13.4,11.8,12,0)
  f.candles[51]=f.candle(f.slots[51],12,12.1,10.5,10.7,0)
  const a=assess(f)
  assert.equal(a.signal?.pattern,'TREND_STRUCTURE_BREAK');assert.equal(a.signal.side,d===1?'CALL':'PUT')
  f.candles[50]=f.candle(f.slots[50],15.4,15.6,14.7,14.9,0)
  f.candles[51]=f.candle(f.slots[51],15.2,15.3,14.6,14.8,0)
  assert.notEqual(assess(f).signal?.pattern,'TREND_STRUCTURE_BREAK','a line break alone cannot establish trend reversal')
 }
})
test('a broken repeated resistance/support zone confirms only on its held retest',()=>{
 for(const d of[1,-1]){
  const f=fixture(markets[0],d,'FIVE_MINUTE',now)
  f.candles=f.slots.map((t,i)=>f.candle(t,4,5,3,4.5,0))
  for(const i of[25,35])f.candles[i]=f.candle(f.slots[i],4,8,3,4.5,0)
  for(const i of[46,47,48,49])f.candles[i]=f.candle(f.slots[i],9,10,8.5,9.5,0)
  f.candles[50]=f.candle(f.slots[50],8.8,9.3,8.05,9.1,0)
  f.candles[51]=f.candle(f.slots[51],9.1,10.2,9,10,0)
  const a=assess(f)
  assert.equal(a.signal?.pattern,'ZONE_RETEST');assert.equal(a.signal.side,f.side)
  assert(a.signal.chartStructure.zones.some(z=>z.flipped&&z.touches===2))
  f.candles[50]=f.candle(f.slots[50],7.9,9.3,7,7.8,0)
  assert.notEqual(assess(f).signal?.pattern,'ZONE_RETEST','failed hold must not become a retest entry')
 }
})
test('versioned chart evidence survives reload while earlier candle-v1 records keep their identity',()=>{
 const {createPredictionRecord,observePredictionTick,writePredictionHistory,readPredictionHistory}=require('../src/analysis/predictionHistory.ts')
 const f=fixture(markets[0],1,'FIVE_MINUTE',now),plan=assess(f).plan
 assert.equal(plan.strategyVersion,'candle-v2');assert.equal(plan.candleConfirmation.chartStructure.version,2)
 let saved;const storage={setItem:(_,v)=>saved=v,getItem:()=>saved}
 const old={...plan,id:'old-candle-v1',strategyVersion:'candle-v1',candleConfirmation:{...plan.candleConfirmation,policy:'five-minute-candles-v1'}}
 delete old.candleConfirmation.chartStructure
 const active=observePredictionTick(createPredictionRecord(old),old.entry,now+1)
 writePredictionHistory(storage,[createPredictionRecord(plan),active])
 const restored=readPredictionHistory(storage)
 assert.equal(restored[0].strategyVersion,'candle-v2');assert.deepEqual(restored[0].candleConfirmation.chartStructure,JSON.parse(JSON.stringify(plan.candleConfirmation.chartStructure)))
 assert.equal(restored[1].strategyVersion,'candle-v1');assert.equal(restored[1].protection.version,2)
 const bad={...createPredictionRecord(plan),candleConfirmation:{...plan.candleConfirmation,chartStructure:{...plan.candleConfirmation.chartStructure,asOf:plan.signalCandleTime}}}
 assert.throws(()=>readPredictionHistory({getItem:()=>JSON.stringify({version:1,records:[bad]})}),/preserved/)
})
test('chart annotations retain Nifty, Sensex and Bank Nifty history after a recent gap without joining across it',()=>{
 const {chartStructureDisplay}=require('../src/analysis/chartStructureDisplay.ts')
 for(const row of markets.slice(0,3)){
  const f=fixture(row,1,'FIVE_MINUTE',now)
  f.candles=f.slots.map((t,i)=>{const v=10+i*.1+[2,1,0,1,2,3][i%6];return f.candle(t,v+.7,v+2,v,v+1,0)})
  const later=f.candle(now+step,20,21,19,20.5,0),bars=[...f.candles,later]
  const display=chartStructureDisplay(bars,f.instrument,.01,now+2*step,0,54)
  assert.equal(display.segments,2);assert.equal(display.latest.bars,1)
  assert(display.points.some(p=>p.label.text==='HH'));assert(display.points.some(p=>p.label.text==='HL'))
  assert(display.lines.length>0);assert(display.lines.every(l=>l.data.at(-1).x===51))
  assert.match(display.lineStatus,/five completed/)
 }
})
test('historical chart windows show their own confirmed swings without using later candles',()=>{
 const {chartStructureDisplay}=require('../src/analysis/chartStructureDisplay.ts'),f=trendFixture()
 const first=chartStructureDisplay(f.candles,f.instrument,.01,now,0,25)
 const altered=f.candles.map((b,i)=>i>25?f.candle(f.slots[i],100,200,-100,150):b)
 assert.deepEqual(chartStructureDisplay(altered,f.instrument,.01,now,0,25),first)
 assert(first.points.every(p=>p.x<=23))
 const older=chartStructureDisplay(f.candles,f.instrument,.01,now,0,20)
 assert(older.points.length>0,'older labels must not disappear because later pivots are outside the viewport')
})
test('a smooth observed advance is labelled without inventing confirmed swing pivots or trade trend lines',()=>{
 const {chartStructureDisplay}=require('../src/analysis/chartStructureDisplay.ts'),f=trendFixture()
 const bars=f.slots.map((t,i)=>f.candle(t,i,i+1,i-.5,i+.8,0))
 const display=chartStructureDisplay(bars,f.instrument,.01,now,0,54)
 assert.equal(display.movement,'RISING');assert.equal(display.points.length,0);assert.equal(display.structureLines.length,0);assert(display.lines.some(l=>l.name.startsWith('Recent price trend')))
 assert.match(display.lineStatus,/two confirmed swing/)
})
test('recent price guides are present for smooth rising and falling prices across all seven markets',()=>{
 const {chartStructureDisplay}=require('../src/analysis/chartStructureDisplay.ts')
 for(const row of markets)for(const d of[1,-1]){
  const f=fixture(row,d,'FIVE_MINUTE',now)
  const bars=f.slots.map((t,i)=>f.candle(t,i,i+1,i-.5,i+.8,0))
  const display=chartStructureDisplay(bars,f.instrument,row[3]?1:.01,now,0,54)
  const guide=display.lines.find(l=>l.name.startsWith('Recent price trend'))
  assert(guide,`${f.instrument}: recent trend must be visible even with no pivot line`)
  assert.equal(guide.validated,false);assert.equal(guide.data.length,12)
  assert.equal(display.recentTrend.direction,d===1?'UP':'DOWN')
  assert.equal(display.structureLines.length,0,'a recent guide is not a validated support/resistance line')
  assert(display.pendingPoints.some(p=>p.label.text===(d===1?'H?':'L?')))
 }
})
test('the next five-minute close automatically advances guides while forming/future bars stay excluded',()=>{
 const {chartStructureDisplay}=require('../src/analysis/chartStructureDisplay.ts')
 for(const row of[markets[1],markets[4]]){
  const f=fixture(row,1,'FIVE_MINUTE',now)
  const future=f.candle(now,100,999,-100,300,0),bars=[...f.candles,future]
  const before=chartStructureDisplay(bars,f.instrument,.01,now-1,0,55)
  const closed=chartStructureDisplay(bars,f.instrument,.01,now,0,55)
  assert.equal(before.latest.asOf,f.candles[50][0]);assert.equal(closed.latest.asOf,f.candles[51][0])
  assert.equal(before.lines.filter(l=>l.name.startsWith('Recent price trend')).at(-1).data.at(-1).x,50)
  assert.equal(closed.lines.filter(l=>l.name.startsWith('Recent price trend')).at(-1).data.at(-1).x,51)
  assert.equal(closed.latestIndex,51);assert(closed.points.every(p=>p.x<=49))
  assert.deepEqual(chartStructureDisplay(f.candles,f.instrument,.01,now,0,55),closed)
 }
})
test('recent swing candidates confirm after two right-hand closes, or disappear when invalidated',()=>{
 const {chartStructureDisplay}=require('../src/analysis/chartStructureDisplay.ts'),f=fixture(markets[1],1,'FIVE_MINUTE',now)
 const bars=f.slots.map(t=>f.candle(t,10,11,9,10,0))
 bars[49]=f.candle(f.slots[49],12,15,11,13,0);bars[50]=f.candle(f.slots[50],12,14,11,12,0);bars[51]=f.candle(f.slots[51],11.5,13,10,12,0)
 const pending=chartStructureDisplay(bars,f.instrument,.01,now-step,0,54)
 assert(pending.pendingPoints.some(p=>p.x===49&&p.label.text==='H?'));assert(!pending.points.some(p=>p.x===49))
 const confirmed=chartStructureDisplay(bars,f.instrument,.01,now,0,54)
 assert(confirmed.points.some(p=>p.x===49&&p.label.text==='H'));assert(!confirmed.pendingPoints.some(p=>p.x===49))
 const invalid=bars.map(b=>[...b]);invalid[51][2]=f.base+16*f.scale
 const changed=chartStructureDisplay(invalid,f.instrument,.01,now,0,54)
 assert(!changed.points.some(p=>p.x===49));assert(!changed.pendingPoints.some(p=>p.x===49))
 assert(changed.pendingPoints.some(p=>p.x===51&&p.label.text==='H?'))
})
test('broker corrections refresh the completed guide; guides and pending swings never bridge missing bars',()=>{
 const {chartStructureDisplay}=require('../src/analysis/chartStructureDisplay.ts'),f=trendFixture()
 const original=chartStructureDisplay(f.candles,f.instrument,.01,now,0,54)
 const corrected=f.candles.map((b,i)=>i===51?f.candle(f.slots[51],20,23,19,22,0):b)
 const changed=chartStructureDisplay(corrected,f.instrument,.01,now,0,54)
 assert.notDeepEqual(changed.lines.filter(l=>l.name.startsWith('Recent price trend')),original.lines.filter(l=>l.name.startsWith('Recent price trend')))
 const missing=f.candles.filter((_,i)=>i!==50),display=chartStructureDisplay(missing,f.instrument,.01,now,0,54)
 assert.equal(display.latest.bars,1);assert.equal(display.recentTrend.bars,1)
 assert.equal(display.pendingPoints.length,0);assert(display.lines.every(l=>l.data.at(-1).x<50))
})
