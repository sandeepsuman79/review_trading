const atmVwapFixture = require('./helpers/atmVwap.cjs')
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, f)
const { LiveCandleBook } = require('../src/analysis/liveCandleBook.ts')
const { completedCandles } = require('../src/analysis/candleData.ts')
const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
const { buildEarlyPrediction } = require('../src/analysis/earlyPrediction.ts')
const { createPredictionRecord, observeConfirmedAgentReversal, syncPredictionRecord, registerConfirmedPrediction, readPredictionHistory, writePredictionHistory } = require('../src/analysis/predictionHistory.ts')
const { prioritizeHistoryJobs, historySyncRange } = require('../src/analysis/historySync.ts')
const { findMomentumSetups } = require('../src/analysis/momentumSetups.ts')
const start = Date.parse('2026-10-15T09:15:00+05:30')
const bar = (time, open, close, wick = .7) => [new Date(time).toISOString(), open, Math.max(open, close) + wick, Math.min(open, close) - wick, close, 0]
const tick = (time, ltp) => ({ token: '99926000', timestamp: time, ltp, mode: 1, exchangeType: 1 })
const scenarioTime = i => i < 50 ? start - 86400000 + i * 300000 : start + (i - 50) * 300000
const fixture = d => Array.from({ length: 52 }, (_, i) => { const open = 22000 + d * (i * .3 + Math.sin(i / 4) * 6); return bar(start + i * 300000, open, open + d * 2) })
function assess(candles) {
  const now = Date.parse(candles.at(-1)[0]) + 300000, analysis = analyzePriceAction(candles, 'FIVE_MINUTE', now)
  const evidence = analyzeTradingEvidence({ analysis, candles, instrument: 'Nifty 50', interval: 'FIVE_MINUTE', now, atmVwap: atmVwapFixture('Nifty 50', analysis.currentPrice, now, Math.sign(candles.at(-1)[4] - candles.at(-1)[1])) })
  return { now, analysis, evidence, prediction: buildEarlyPrediction(analysis, 'Nifty 50', 'FIVE_MINUTE', now, undefined, undefined, evidence) }
}

test('only 5/15/60 candles are maintained with a 5-minute default while tick extremes remain intact', () => {
  const { chartIntervals, historyIntervals, agentInterval } = require('../src/analysis/timeframes.ts')
  assert.deepEqual(chartIntervals, ['FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR']); assert.equal(agentInterval, 'FIVE_MINUTE')
  const book = new LiveCandleBook(() => [])
  for (const [offset, price] of [[1000,100],[2000,110],[3000,90],[61000,105],[65000,108]]) book.accept(tick(start + offset, price), start + offset)
  const five = book.get('99926000', 'FIVE_MINUTE')
  assert.deepEqual(five[0].slice(1, 5), [100,110,90,108]); assert.equal(completedCandles(five, 'FIVE_MINUTE', start + 299999).length, 0)
  assert.equal(completedCandles(five, 'FIVE_MINUTE', start + 300000).length, 1)
  const writes=[];book.flush((_token, interval)=>writes.push(interval));assert.deepEqual(writes, historyIntervals)
  assert.equal(book.get('99926000', 'ONE_MINUTE').length, 0)
})

test('real five-minute CALL and PUT candidates independently reach full confirmation', () => {
  for (const d of [1,-1]) {
    const { analysis, evidence, prediction } = assess(fixture(d))
    assert.equal(analysis.side, d === 1 ? 'CALL' : 'PUT'); assert.equal(evidence.canConfirm, true)
    assert(evidence.checks.every(check => check.passed)); assert.equal(prediction.plan.interval, 'FIVE_MINUTE'); assert.equal(prediction.plan.stage, 'CONFIRMED')
    assert(prediction.plan.riskReward >= 1.5); assert.equal(evidence.vwap, undefined)
    assert.equal(evidence.decisions.find(item => item.side === analysis.side).state, 'CONFIRMED')
  }
})

test('a direct one-minute request cannot produce a new setup from otherwise qualifying evidence', () => {
  const { analysis, evidence, now } = assess(fixture(1))
  const prediction = buildEarlyPrediction(analysis, 'Nifty 50', 'ONE_MINUTE', now, undefined, undefined, { ...evidence, interval: 'ONE_MINUTE' })
  assert.equal(prediction.side, 'WAIT'); assert.equal(prediction.plan, undefined)
  assert.match(prediction.reason, /One-minute strategy analysis is disabled/)
})

test('rising-then-falling and falling-then-rising OHLC produce opposite five-minute confirmations with explicit rejection reasons beforehand', () => {
  for (const d of [1,-1]) {
    const candles=[]; let price=22000, confirmed=false, waiting=false
    for(let i=0;i<110;i++) {
      const change=d*(i<80 ? 1.2+Math.sin(i/3)*.7 : -1.8+Math.sin(i/2)*.6)
      candles.push(bar(scenarioTime(i),price,price+change,.4));price+=change
      if(i<80)continue
      const { evidence }=assess(candles), side=d===1?'PUT':'CALL', decision=evidence.decisions.find(item=>item.side===side)
      if(decision.state!=='CONFIRMED'){waiting=true;assert(decision.reasons.length>0)}
      if(evidence.canConfirm && evidence.selectedAnalysis.side===side){confirmed=true;assert(decision.supportScore>0&&decision.supportScore>=1.5*decision.opposingScore);break}
    }
    assert(waiting,'a first reverse candle does not manufacture confirmation');assert(confirmed,'opposite direction must be eligible after technical confirmation')
  }
})

test('intraday tops at different prices and times can independently develop confirmed PUTs for all indices', () => {
  for(const [instrument,topBar,top,scale] of [['Nifty 50',82,22170,1],['Sensex',92,74830,3],['Bank Nifty',88,50820,2]]) {
    const changes=Array.from({length:topBar},(_,i)=>scale*(1.2+Math.sin(i/3)*.7))
    let price=top-changes.reduce((sum,value)=>sum+value,0);const candles=[];let confirmed=false
    for(let i=0;i<topBar+40;i++){
      const change=i<topBar?changes[i]:scale*(-1.8+Math.sin(i/2)*.6)
      candles.push(bar(scenarioTime(i),price,price+change,.4*scale));price+=change
      if(i===topBar-1)assert(Math.abs(price-top)<.00001)
      if(i<topBar)continue
      const now=scenarioTime(i)+300000,analysis=analyzePriceAction(candles,'FIVE_MINUTE',now)
      const evidence=analyzeTradingEvidence({analysis,candles,instrument,interval:'FIVE_MINUTE',now,atmVwap:atmVwapFixture(instrument,analysis.currentPrice,now,-1)})
      if(evidence.canConfirm && evidence.selectedAnalysis.side==='PUT'){confirmed=true;assert(evidence.bearishScore>0&&evidence.bearishScore>=1.5*evidence.bullishScore);assert(evidence.checks.every(check=>check.passed));break}
    }
    assert(confirmed,instrument+' must support PUT confirmation after a qualified completed reversal')
  }
})

test('an unfinished five-minute reversal candle cannot change the completed assessment', () => {
  const candles=fixture(1), { now, analysis }=assess(candles)
  assert.deepEqual(analyzePriceAction([...candles,bar(now,22000,18000,2000)],'FIVE_MINUTE',now+299999),analysis)
})

test('five-minute opening range requires all three opening bars and mirrors CALL/PUT', () => {
  for(const d of [1,-1]) {
    let candles=Array.from({length:50},(_,i)=>bar(start-86400000+i*300000,100,100,1))
      .concat(Array.from({length:21},(_,i)=>[new Date(start+i*300000).toISOString(),100,103,99,101,0]))
    candles[candles.length-1]=[candles.at(-1)[0],101.5,104,101,103.8,0]
    let averages=candles.map(()=>({ema20:101,ema50:99})), indicators=candles.map(()=>({atr14:2,adx14:30,plusDi14:30,minusDi14:10,rsi14:60,supertrendDirection:'UP'}))
    averages.at(-1).ema20=101.2
    if(d===-1){candles=candles.map(c=>[c[0],200-c[1],200-c[3],200-c[2],200-c[4],0]);averages=averages.map(p=>({ema20:200-p.ema20,ema50:200-p.ema50}));indicators=indicators.map(p=>({...p,rsi14:40,plusDi14:10,minusDi14:30,supertrendDirection:'DOWN'}))}
    assert(findMomentumSetups(candles,averages,indicators,'FIVE_MINUTE').some(item=>item.pattern==='OPENING_RANGE_BREAKOUT'&&item.side===(d===1?'CALL':'PUT')))
    const missing=51
    assert(!findMomentumSetups(candles.filter((_,i)=>i!==missing),averages.filter((_,i)=>i!==missing),indicators.filter((_,i)=>i!==missing),'FIVE_MINUTE').some(item=>item.pattern==='OPENING_RANGE_BREAKOUT'))
  }
})

test('default 5-minute history is prioritized independently of the viewed chart and respects request limits', () => {
  const { chartIntervals } = require('../src/analysis/timeframes.ts')
  const jobs=chartIntervals.flatMap(interval=>['nifty','sensex','bank'].map(token=>({token,interval})))
  const sorted=prioritizeHistoryJobs(jobs,'sensex','FIFTEEN_MINUTE')
  assert.deepEqual(sorted[0],{token:'sensex',interval:'FIVE_MINUTE'});assert.equal(sorted[1].interval,'FIFTEEN_MINUTE')
  assert(jobs.every(job=>job.interval!=='ONE_MINUTE'));assert.equal(jobs.length,9)
  const cold=historySyncRange([],'FIVE_MINUTE',start+3*60000);assert.equal(cold.to-cold.from,14*86400000+300000)
  const old=Array.from({length:60},(_,i)=>bar(start-200*86400000+i*300000,100,101))
  const range=historySyncRange(old,'FIVE_MINUTE',start);assert(range.to-range.from<100*86400000)
})

function reversalFixture() {
  const { now,prediction }=assess(fixture(-1)),plan=prediction.plan,price=plan.entry
  const oldPlan={...plan,id:'legacy-call',side:'CALL',interval:'ONE_MINUTE',entry:price+10,stopLoss:price-100,target:price+200,generatedAt:now-600000,expiresAt:now+300000}
  const record={...createPredictionRecord(oldPlan),status:'ACTIVE',entryPrice:price+10,entryAt:now-600000,observedThrough:now-1000,latestPrice:price,latestPriceAt:now,latestPriceSource:'LIVE'}
  return {now,plan,price,record}
}

test('confirmed five-minute PUT closes a legacy CALL first, books its loss, then permits a separate PUT entry', () => {
  const {now,plan,price,record}=reversalFixture()
  assert.equal(registerConfirmedPrediction([record],plan,now).length,1,'an active CALL blocks any overlapping PUT')
  const closed=syncPredictionRecord(record,[],tick(now,price),now,false,undefined,plan)
  assert.equal(closed.status,'EARLY_EXIT');assert.equal(closed.earlyExitSource,'AGENT_REVERSAL');assert.equal(closed.points,-10)
  const records=registerConfirmedPrediction([closed],plan,now);assert.equal(records.length,2);assert.equal(records[1].status,'PENDING')
  const entered=syncPredictionRecord(records[1],[],tick(now+1,price),now+1,true,plan,null)
  assert.equal(entered.status,'ACTIVE');assert.equal(entered.side,'PUT');assert.equal([closed,entered].filter(item=>item.status==='ACTIVE').length,1)
  const memory=new Map(),storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)}
  writePredictionHistory(storage,[closed,entered]);assert.deepEqual(readPredictionHistory(storage),JSON.parse(JSON.stringify([closed,entered])))
})

test('developing, stale, forming, wrong-index or pre-entry reversals cannot close an active trade', () => {
  const {now,plan,record}=reversalFixture()
  for(const altered of [{...plan,stage:'EARLY'},{...plan,stage:'RISKY'},{...plan,side:'CALL'},{...plan,instrument:'Sensex'},{...plan,generatedAt:now-31000},{...plan,expiresAt:now},{...plan,signalCandleTime:new Date(now).toISOString()},{...plan,signalCandleTime:new Date(record.entryAt-60000).toISOString()}]) assert.equal(observeConfirmedAgentReversal(record,altered,now).status,'ACTIVE')
  assert.equal(observeConfirmedAgentReversal({...record,latestPriceAt:now-31000},plan,now).status,'ACTIVE')
  assert.equal(syncPredictionRecord(record,[],tick(now,record.latestPrice),now,false,undefined,null).status,'ACTIVE')
})

test('observed stops still take precedence over a confirmed reversal', () => {
  const {now,plan,record}=reversalFixture()
  assert.equal(syncPredictionRecord(record,[],tick(now,record.stopLoss-1),now,false,undefined,plan).status,'STOP_LOSS_HIT')
})
