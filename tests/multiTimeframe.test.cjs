const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, f)
const { analyzeMultiTimeframe, revalidateMultiTimeframeAssessment, selectReversalPlan } = require('../src/analysis/multiTimeframe.ts')
const { createPredictionRecord } = require('../src/analysis/predictionHistory.ts')
const { mcxSession } = require('../src/analysis/commodities.ts')
const { timeframeInfo } = require('../src/analysis/timeframes.ts')
const now = Date.parse('2026-10-16T13:45:00+05:30')
const markets = [['Nifty 50', 22000, 1], ['Sensex', 74000, 3], ['Bank Nifty', 50000, 2], ['Natural Gas', 300, .2, 'NATURALGAS'], ['Crude Oil', 6000, 2, 'CRUDEOIL'], ['Gold', 110000, 10, 'GOLD'], ['Silver', 90000, 10, 'SILVER']]
function contractFor(row) {
 const [name,,,root] = row
 return root ? { name, root, token: '12345', symbol: `${root}20NOV26FUT`, exchange: 'MCX', exchangeType: 5, expiry: '2026-11-20', expiresAt: mcxSession(Date.parse('2026-11-20T12:00:00+05:30')).close, tickSize: root === 'NATURALGAS' ? .1 : 1 } : undefined
}
function candlesFor(row, d, interval, end = now) {
 const [,base,scale,root] = row, duration = timeframeInfo[interval].milliseconds, timestamps = []
 // Actual weekday session slots: history warmup must not manufacture overnight bars.
 for (let day = 10; day >= 0; day--) {
  const date = new Date(now - day * 86400000), weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) continue
  const open = Date.parse(`${date.toISOString().slice(0,10)}T${root ? '09:00' : '09:15'}:00+05:30`)
  const close = root ? open + 14 * 3600000 : open + 6 * 3600000
  for (let time = open; time + duration <= Math.min(close, end); time += duration) timestamps.push(time)
 }
 return timestamps.slice(-52).map((time,i) => {
  const o = base + d * (i * .3 + Math.sin(i / 4) * 6) * scale, c = o + d * 2 * scale
  return [new Date(time).toISOString(), o, Math.max(o,c) + .7 * scale, Math.min(o,c) - .7 * scale, c, root ? 100 : 0]
 })
}
function input(row = markets[0], d = 1) {
 return { instrument: row[0], contract: contractFor(row), now, candlesByInterval: Object.fromEntries(['FIVE_MINUTE','FIFTEEN_MINUTE','ONE_HOUR'].map(interval => [interval, candlesFor(row,d,interval)])) }
}
test('all seven instruments independently evaluate both directions with actual completed indicator and score pipelines', () => {
 for (const row of markets) for (const d of [1,-1]) {
  const result = analyzeMultiTimeframe(input(row,d))
  assert.deepEqual(result.reviews.map(r=>r.interval), ['FIVE_MINUTE','FIFTEEN_MINUTE','ONE_HOUR'])
  for (const review of result.reviews) {
   assert.equal(review.analysis.analyzedCandles,52)
   assert(review.analysis.rsi14 !== undefined && review.analysis.atr14 > 0)
   assert.equal(review.evidence.interval,review.interval)
   assert.equal(review.evidence.bias,d===1?'BULLISH':'BEARISH')
   if (review.plan) { assert.equal(review.plan.side,d===1?'CALL':'PUT'); assert.equal(review.plan.stage,'CONFIRMED'); assert.equal(review.evidence.canConfirm,true); assert(review.plan.riskReward>=1.5) }
  }
  assert(result.selectedPlan,`${row[0]} ${d}: ${result.reviews.map(r=>r.reason).join(' / ')}`)
  assert.equal(result.selectedPlan.side,d===1?'CALL':'PUT')
 }
})
test('freshest eligible close wins, simultaneous closes prefer 5-minute, and an opposing timeframe is context rather than a veto', () => {
 const source=input(),base=analyzeMultiTimeframe(source)
 const five=base.reviews.find(r=>r.interval==='FIVE_MINUTE'), fifteen=base.reviews.find(r=>r.interval==='FIFTEEN_MINUTE')
 assert(five.plan && fifteen.plan)
 assert.equal(five.closedAt,fifteen.closedAt)
 assert.equal(base.selectedPlan.interval,'FIVE_MINUTE')
 const opposing=input(markets[0],-1)
 const conflict=analyzeMultiTimeframe({...source,candlesByInterval:{...source.candlesByInterval,FIVE_MINUTE:opposing.candlesByInterval.FIVE_MINUTE}})
 assert.equal(conflict.conflicts,true);assert.equal(conflict.selectedPlan.interval,'FIVE_MINUTE');assert.equal(conflict.selectedPlan.side,'PUT')
 const lateNow=now+5*60000
 const newerFive=candlesFor(markets[0],1,'FIVE_MINUTE',lateNow)
 const newer=analyzeMultiTimeframe({...source,now:lateNow,candlesByInterval:{...source.candlesByInterval,FIVE_MINUTE:newerFive}})
 assert(newer.reviews[0].plan);assert.equal(newer.selectedPlan.interval,'FIVE_MINUTE')
})
test('missing, gapped, stale and forming-only views cannot borrow warmup or confirmation from another timeframe', () => {
 const source=input(), stale=source.candlesByInterval.FIFTEEN_MINUTE.slice(0,-2)
 const result=analyzeMultiTimeframe({...source,candlesByInterval:{FIVE_MINUTE:source.candlesByInterval.FIVE_MINUTE,FIFTEEN_MINUTE:stale,ONE_HOUR:[]}})
 assert.equal(result.reviews[1].status,'STALE');assert.equal(result.reviews[1].plan,undefined);assert.equal(result.reviews[2].status,'WARMING_UP');assert.equal(result.reviews[2].plan,undefined)
 assert.equal(result.selectedPlan.interval,'FIVE_MINUTE')
 const gapped=source.candlesByInterval.FIVE_MINUTE.filter((_,i)=>i!==50)
 const gap=analyzeMultiTimeframe({...source,candlesByInterval:{FIVE_MINUTE:gapped}})
 assert.equal(gap.reviews[0].plan,undefined)
 const future=[new Date(now).toISOString(),22000,99999,1,99999,0]
 const before=analyzeMultiTimeframe(source),after=analyzeMultiTimeframe({...source,candlesByInterval:{...source.candlesByInterval,FIVE_MINUTE:[...source.candlesByInterval.FIVE_MINUTE,future]}})
 assert.deepEqual(after.reviews[0].analysis,before.reviews[0].analysis)
 assert(!after.reviews.some(r=>r.interval==='ONE_MINUTE'))
})
test('forming extrema and finished ledger signals retire entries, while the technical assessment remains available for existing-position reversal', () => {
 const source=input(),base=analyzeMultiTimeframe(source),plan=base.selectedPlan
 const record={...createPredictionRecord(plan),status:'TARGET_HIT',entryAt:now-10000,exitAt:now-1000,entryPrice:plan.entry,exitPrice:plan.target,points:plan.target-plan.entry}
 const refreshed=revalidateMultiTimeframeAssessment(base,{...source,records:[record],now:now+1000})
 const selected=refreshed.reviews.find(r=>r.interval===plan.interval)
 assert.equal(selected.plan,undefined);assert.equal(selected.status,'ENDED');assert(selected.assessedPlan)
 const active={...createPredictionRecord({...plan,id:'older-open',side:'PUT'}),status:'ACTIVE',entryAt:Date.parse(plan.signalCandleTime)-60000}
 assert.equal(selectReversalPlan(active,refreshed.reviews,now+1000)?.side,'CALL')
 const spent=revalidateMultiTimeframeAssessment(base,{...source,now:now+1000,candlesByInterval:Object.fromEntries(base.reviews.map(r=>[r.interval,[...source.candlesByInterval[r.interval],[new Date(now).toISOString(),r.plan?.entry??22000,(r.plan?.target??30000)+1,21999,r.plan?.entry??22000,0]]]))})
 assert.equal(spent.reviews.find(r=>r.interval===plan.interval).plan,undefined)
 assert.equal(spent.reviews.find(r=>r.interval===plan.interval).status,'ENDED')
 assert.equal(spent.reviews.find(r=>r.interval===plan.interval).assessedPlan?.side,'CALL')
 const expired=revalidateMultiTimeframeAssessment(base,{...source,now:now+3600000})
 assert.equal(expired.selectedPlan,undefined)
})
test('only a fresh complete post-entry opposite setup on the exact same contract can request a reversal', () => {
 const base=analyzeMultiTimeframe(input(markets[4],-1)),plan=base.selectedPlan
 const active={...createPredictionRecord({...plan,id:'open-long',side:'CALL'}),status:'ACTIVE',entryAt:Date.parse(plan.signalCandleTime)-60000}
 assert.equal(selectReversalPlan(active,base.reviews,now)?.side,'PUT')
 assert.equal(selectReversalPlan(active,base.reviews,now+30001),undefined)
 assert.equal(selectReversalPlan({...active,entryAt:now-1000},base.reviews,now),undefined)
 assert.equal(selectReversalPlan({...active,contract:{...active.contract,token:'other'}},base.reviews,now),undefined)
 assert.equal(selectReversalPlan({...active,contract:{...active.contract,symbol:'OTHERFUT'}},base.reviews,now),undefined)
 assert.equal(selectReversalPlan({...active,status:'PENDING'},base.reviews,now),undefined)
 assert.equal(selectReversalPlan({...active,side:'PUT'},base.reviews,now),undefined)
 const forgedMinute=base.reviews.map(r=>({...r,interval:'ONE_MINUTE',assessedPlan:r.assessedPlan?{...r.assessedPlan,interval:'ONE_MINUTE'}:undefined}))
 assert.equal(selectReversalPlan(active,forgedMinute,now),undefined)
})

test('closed-candle hook releases MCX hourly data at its own close without a 15-minute equity-session delay', () => {
 const React = require('react'), {renderToStaticMarkup} = require('react-dom/server')
 const {useCompletedCandles} = require('../src/hooks/useCompletedCandles.ts')
 const time = clock => Date.parse(`2026-10-16T${clock}:00+05:30`)
 const mcx = [['11:00',100],['12:00',101],['13:00',102]].map(([clock,price])=>[new Date(time(clock)).toISOString(),price,price+1,price-1,price,100])
 const equity = [['11:15',100],['12:15',101],['13:15',102]].map(([clock,price])=>[new Date(time(clock)).toISOString(),price,price+1,price-1,price,0])
 function read(candles,now,sessionOpenMinute) {
  let result
  function Harness() { result=useCompletedCandles(candles,'ONE_HOUR',now,sessionOpenMinute);return null }
  renderToStaticMarkup(React.createElement(Harness));return result
 }
 assert.equal(read(mcx,time('12:59'),540).length,1)
 assert.equal(read(mcx,time('13:00'),540).length,2)
 assert.equal(read(mcx,time('13:14'),540).length,2)
 assert.equal(read(equity,time('13:00'),555).length,1)
 assert.equal(read(equity,time('13:14'),555).length,1)
 assert.equal(read(equity,time('13:15'),555).length,2)
})
