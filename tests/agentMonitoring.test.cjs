const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m,f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const { signalFreshness, recordTradeTransitions, readTradeTransitions, trackedPerformance, contractExpiryNotice } = require('../src/analysis/agentMonitoring.ts')
const closed = Date.parse('2026-10-16T10:00:00+05:30')
const plan = { id:'monitor', instrument:'Nifty 50', strategyVersion:'technical-v2', stage:'CONFIRMED', interval:'FIVE_MINUTE', signalCandleTime:new Date(closed-300000).toISOString(), generatedAt:closed, expiresAt:closed+900000, entry:100, stopLoss:90, target:120, bullishScore:70, bearishScore:10 }
test('freshness uses the anchored deadline, fades with age and never changes evidence scores or extends on a late issue', () => {
  const before = JSON.stringify(plan)
  assert.equal(signalFreshness(plan,closed+60000).remainingPercent,80)
  assert.equal(signalFreshness(plan,closed+300000).remainingPercent,0)
  assert.equal(signalFreshness(plan,closed-1),undefined)
  assert.equal(signalFreshness(plan,closed+1000,closed+2000),undefined)
  assert(signalFreshness({...plan,generatedAt:closed+290000},closed+290000).remainingPercent<4)
  assert.equal(JSON.stringify(plan),before)
})
test('decision trail captures reservation, pauses, revalidation, invalidation and closure without quote-only spam', () => {
  const pending = {...plan,status:'PENDING',outcomeNote:'Waiting for entry'}
  recordTradeTransitions([], [pending], closed)
  const paused = {...pending,latestPrice:99,outcomeNote:'Entry paused while current evidence is checked'}
  recordTradeTransitions([pending],[paused],closed+1000)
  recordTradeTransitions([paused],[{...paused,latestPrice:99.1}],closed+2000)
  const levels = {...paused,entry:101}
  recordTradeTransitions([paused],[levels],closed+3000)
  const expired = {...levels,status:'EXPIRED',outcomeNote:'Target already reached; no late entry'}
  recordTradeTransitions([levels],[expired],closed+4000)
  const events = readTradeTransitions('Nifty 50')
  assert.equal(events.length,4);assert.deepEqual(events.map(e=>e.to),['PENDING','PENDING','PENDING','EXPIRED'])
  assert.match(events[2].reason,/revalidated/);assert.match(events[3].reason,/no late entry/)
  events[0].reason='tampered';assert.notEqual(readTradeTransitions('Nifty 50')[0].reason,'tampered')
  for(let i=0;i<450;i++)recordTradeTransitions([], [{...pending,id:`bounded-${i}`}],closed+i)
  assert.equal(readTradeTransitions('Nifty 50').length,400)
})
function settled(i,r=1,instrument='Nifty 50') {
 const exitAt = closed - i*86400000
 return {...plan,interval:'FIVE_MINUTE',id:`closed-${i}`,instrument,status:r>0?'TARGET_HIT':'STOP_LOSS_HIT',entryPrice:100,entryAt:exitAt-60000,exitAt,points:10*r}
}
test('performance compares non-overlapping R windows per instrument, excludes unknown outcomes and requires multi-session history', () => {
 const history = Array.from({length:20},(_,i)=>settled(i,i<10?-1:1))
 const result = trackedPerformance([...history,settled(0,999,'Gold'),{...settled(22,999),status:'AMBIGUOUS'}], 'Nifty 50',closed)
 assert.equal(result.state,'REVIEW');assert.equal(result.recentR,-1);assert.equal(result.baselineR,1);assert.equal(result.lossStreak,10);assert.equal(result.excluded,1)
 assert.equal(trackedPerformance(history.slice(0,10),'Nifty 50',closed).state,'INSUFFICIENT_HISTORY')
 const sameSession = history.map((item,i)=>({...item,entryAt:closed-100000,exitAt:closed-i*1000}))
 assert.equal(trackedPerformance(sameSession,'Nifty 50',closed).state,'INSUFFICIENT_HISTORY')
 assert.equal(trackedPerformance(Array.from({length:20},(_,i)=>settled(i,1)), 'Nifty 50',closed).state,'OBSERVING')
 assert.equal(trackedPerformance([{...settled(0),strategyVersion:'early-v1'},{...settled(0),exitAt:closed+1}], 'Nifty 50',closed).samples,0)
})
test('performance keeps 5, 15 and 60-minute results in independent cohorts', () => {
 const fifteen = Array.from({length:20},(_,i)=>({...settled(i,1),interval:'FIFTEEN_MINUTE'}))
 const five = fifteen.map(item=>({...item,id:`five-${item.id}`,interval:'FIVE_MINUTE',points:-20}))
 const hourly = fifteen.map(item=>({...item,id:`hour-${item.id}`,interval:'ONE_HOUR',points:30}))
 const all = [...fifteen,...five,...hourly,{...settled(0,999),interval:'ONE_MINUTE'}]
 for(const [interval,expected] of [['FIVE_MINUTE',-2],['FIFTEEN_MINUTE',1],['ONE_HOUR',3]]) {
  const result = trackedPerformance(all,'Nifty 50',closed,interval)
  assert.equal(result.samples,20);assert.equal(result.recentR,expected);assert.equal(result.baselineR,expected)
 }
 assert.equal(trackedPerformance(all,'Nifty 50',closed).recentR,-2)
})
test('expiry reminders use resolved contract dates and never migrate or mix the held contract', () => {
 const contract = {name:'Gold',symbol:'GOLD20OCT26FUT',token:'1',expiry:'2026-10-20',expiresAt:Date.parse('2026-10-20T23:30:00+05:30')}
 const copy = JSON.stringify(contract)
 assert.equal(contractExpiryNotice(contract,closed),undefined)
 assert.match(contractExpiryNotice(contract,closed+86400000),/3 calendar days/)
 assert.match(contractExpiryNotice(contract,contract.expiresAt-1000),/today/)
 assert.match(contractExpiryNotice(contract,contract.expiresAt),/has expired/)
 assert.match(contractExpiryNotice(contract,closed,{...contract,token:'2',symbol:'GOLD20NOV26FUT'}),/open trade remains on GOLD20OCT26FUT/)
 assert.equal(JSON.stringify(contract),copy)
})
test('state audit preserves contract and live-versus-candle provenance across rollover', () => {
 for(const [token,symbol,source] of [['1','GOLD20OCT26FUT','CANDLE'],['2','GOLD20NOV26FUT','LIVE']]){
  recordTradeTransitions([], [{...plan,id:`audit-${token}`,instrument:'Gold',contract:{token,symbol},status:'ACTIVE',outcomeNote:'Entry recorded',latestPrice:100,latestPriceAt:closed,latestPriceSource:source}],closed)
 }
 const events=readTradeTransitions('Gold');assert.deepEqual(events.map(e=>[e.contract,e.quoteSource]),[['GOLD20OCT26FUT','CANDLE'],['GOLD20NOV26FUT','LIVE']])
})
