const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, f)
const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
const { buildEarlyPrediction } = require('../src/analysis/earlyPrediction.ts')
const { createPredictionRecord, registerConfirmedPrediction, syncPredictionRecord, observePredictionTick, readPredictionHistory, writePredictionHistory } = require('../src/analysis/predictionHistory.ts')
const { mcxSession, validCommodityContract, tradeDirection } = require('../src/analysis/commodities.ts')
const { withinEntryWindow } = require('../src/analysis/tradeDecision.ts')
const { diagnoseTradeEntry } = require('../src/analysis/tradeEntry.ts')
const { globalMarketRows, buildMarketDashboard, openingRange } = require('../src/analysis/marketDashboard.ts')
const configs = require('../src/data/commodityMarkets.json')
const at = (time, date = '2026-10-15') => Date.parse(`${date}T${time}+05:30`)
const instruments = [['Natural Gas', 'NATURALGAS', 300, .2, .1], ['Crude Oil', 'CRUDEOIL', 6000, 2, 1], ['Silver', 'SILVER', 90000, 10, 1], ['Gold', 'GOLD', 110000, 10, 1]]
const contract = (name = 'Natural Gas', root = 'NATURALGAS', tickSize = .1, date = '2026-11-20') => ({ name, root, token: String(1000 + instruments.findIndex(x => x[0] === name)), symbol: `${root}20NOV26FUT`, exchange: 'MCX', exchangeType: 5, expiry: date, expiresAt: mcxSession(at('12:00:00', date)).close, lotSize: 100, tickSize })
function assess(row = instruments[0], d = 1, end = at('18:00:00')) {
 const [instrument, root, base, scale, tickSize] = row
 const candles = Array.from({ length: 52 }, (_, i) => { const open = base + d * (i * .3 + Math.sin(i / 4) * 6) * scale, close = open + d * 2 * scale; return [new Date(end - (52 - i) * 300000).toISOString(), open, Math.max(open, close) + .7 * scale, Math.min(open, close) - .7 * scale, close, 100] })
 const analysis = analyzePriceAction(candles, 'FIVE_MINUTE', end, instrument)
 const evidence = analyzeTradingEvidence({ analysis, candles, instrument, interval: 'FIVE_MINUTE', now: end })
 const selected = contract(instrument, root, tickSize)
 return { instrument, candles, analysis, evidence, now: end, contract: selected, prediction: buildEarlyPrediction(analysis, instrument, 'FIVE_MINUTE', end, undefined, undefined, evidence, selected) }
}
const quote = (record, time, ltp) => ({ token: record.contract.token, exchangeType: 5, mode: 2, timestamp: time, ltp })
function active(plan, time = plan.generatedAt) { return { ...createPredictionRecord(plan), status: 'ACTIVE', entryAt: time, entryPrice: plan.entry, observedThrough: time, latestPrice: plan.entry, latestPriceAt: time, latestPriceSource: 'LIVE' } }

test('all four commodities support symmetric LONG and SHORT confirmation on real five-minute OHLC after index close', () => {
 for (const row of instruments) for (const d of [1,-1]) {
  const x = assess(row,d)
  assert.equal(x.evidence.canConfirm,true, `${row[0]} ${d}: ${x.evidence.reason}`)
  assert.equal(x.prediction.plan?.stage,'CONFIRMED',JSON.stringify(x.prediction))
  assert.equal(x.prediction.side,d===1?'CALL':'PUT');assert.equal(tradeDirection(x.instrument,x.prediction.side),d===1?'LONG':'SHORT')
  assert(x.evidence.coverage >= 70);assert.equal(x.evidence.indiaVix,undefined);assert(x.evidence.vwap>0)
  assert.equal(x.prediction.plan.contract.token,x.contract.token);assert(x.prediction.plan.riskReward>=1.5)
  for(const level of [x.prediction.plan.entry,x.prediction.plan.stopLoss,x.prediction.plan.target]) assert(Math.abs(level/x.contract.tickSize-Math.round(level/x.contract.tickSize))<1e-6)
 }
})

test('commodity entries respect own hours, weekends and contract expiry rather than the index cutoff', () => {
 for (const [date, close] of [['2026-10-15','23:30:00'],['2026-11-02','23:55:00']]) for(const [instrument] of instruments) {
  for(const time of ['09:00:00','15:16:00','18:00:00']) assert(withinEntryWindow(at(time,date),instrument))
  for(const time of ['08:59:59',close]) assert(!withinEntryWindow(at(time,date),instrument))
 }
 assert(!withinEntryWindow(at('18:00:00','2026-10-17'),'Gold'));assert(!withinEntryWindow(at('18:00:00'),'Nifty 50'))
 const x=assess(),expired={...x.contract,expiry:'2026-10-14',expiresAt:at('23:30:00','2026-10-14')}
 assert.equal(buildEarlyPrediction(x.analysis,x.instrument,'FIVE_MINUTE',x.now,null,undefined,x.evidence).side,'WAIT')
 assert.equal(buildEarlyPrediction(x.analysis,x.instrument,'FIVE_MINUTE',x.now,null,undefined,x.evidence,expired).side,'WAIT')
 assert.equal(registerConfirmedPrediction([],{...x.prediction.plan,contract:expired},x.now).length,0)
})

test('open futures ignore other tokens, persist contract identity, and close before opposite entries', () => {
 const x=assess(),short=assess(instruments[0],-1),plan=x.prediction.plan,record=active({...plan,entry:short.prediction.plan.entry+1,stopLoss:short.prediction.plan.entry-10,target:short.prediction.plan.entry+20},x.now-600000)
 record.observedThrough=x.now-1000
 const price=short.prediction.plan.entry
 const wrong=syncPredictionRecord(record,[],{...quote(record,x.now,price),token:'different'},x.now,false,undefined,short.prediction.plan)
 assert.equal(wrong.status,'ACTIVE');assert.equal(wrong.latestPrice,record.latestPrice)
 assert.equal(registerConfirmedPrediction([record],short.prediction.plan,x.now).length,1)
 const closed=syncPredictionRecord(record,[],quote(record,x.now,price),x.now,false,undefined,short.prediction.plan)
 assert.equal(closed.status,'EARLY_EXIT');assert.equal(closed.earlyExitSource,'AGENT_REVERSAL');assert.equal(closed.points,-1)
 const records=registerConfirmedPrediction([closed],short.prediction.plan,x.now)
 assert.equal(records.length,2)
 const entered=syncPredictionRecord(records[1],[],quote(records[1],x.now+1,price),x.now+1,true,short.prediction.plan,null)
 assert.equal(entered.status,'ACTIVE');assert.equal(entered.side,'PUT')
 const memory=new Map(),storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)}
 writePredictionHistory(storage,[closed,entered]);assert.deepEqual(readPredictionHistory(storage),JSON.parse(JSON.stringify([closed,entered])))
 assert(!validCommodityContract({...x.contract,name:'Gold'},x.instrument))
 assert.throws(()=>readPredictionHistory({getItem:()=>JSON.stringify([{...entered,contract:{...entered.contract,token:'invalid'}}])}))
})

test('a new front-month contract cannot reverse or enter a position belonging to the previous expiry', () => {
 const x=assess(), record=active(x.prediction.plan,x.now-600000), changed={...x.prediction.plan,id:'next-contract',side:'PUT',contract:{...x.contract,token:'2000',symbol:'NATURALGAS20DEC26FUT'}}
 record.observedThrough=x.now-1000
 assert.equal(syncPredictionRecord(record,[],quote(record,x.now,record.entryPrice),x.now,false,undefined,changed).status,'ACTIVE')
 assert.equal(diagnoseTradeEntry(changed,quote(record,x.now,changed.entry),true,x.now,false).checks.find(c=>c.code==='QUOTE_STALE').status,'FAIL')
 assert.equal(registerConfirmedPrediction([record],changed,x.now).length,1)
})

test('MCX square-off waits for observed same-session quotes at DST-specific close; index cutoff does not close futures', () => {
 for(const [date,close] of [['2026-10-15','23:30:00'],['2026-11-02','23:55:00']]) {
  const x=assess(instruments[0],1,at('18:00:00',date)),record=active(x.prediction.plan),cutoff=at(close,date)
  const before=observePredictionTick(record,record.entryPrice,cutoff-1000,false);assert.equal(before.status,'ACTIVE')
  const waiting=syncPredictionRecord(before,[],undefined,cutoff,false,undefined,null);assert.equal(waiting.status,'ACTIVE');assert.equal(waiting.exitPrice,undefined)
  const closed=syncPredictionRecord(waiting,[],quote(record,cutoff,record.entryPrice+.1),cutoff,false,undefined,null)
  assert.equal(closed.status,'EARLY_EXIT');assert.equal(closed.earlyExitSource,'SESSION_SQUARE_OFF');assert.equal(closed.exitAt,cutoff);assert.equal(closed.points,.1)
 }
})

test('MCX opening range starts at 09:00, requires three completed five-minute bars, and is displayed in the shared dashboard', () => {
 const candles=[0,5,10].map(minute=>[new Date(at('09:00:00')+minute*60000).toISOString(),300,302,299,301,100])
 assert.deepEqual(openingRange(candles,'2026-10-15',at('09:15:00'),'Natural Gas'),{low:299,high:302})
 assert.equal(openingRange(candles.slice(1),'2026-10-15',at('09:15:00'),'Natural Gas'),undefined)
 assert.equal(openingRange(candles,'2026-10-15',at('09:15:00'),'Nifty 50'),undefined)
})

const context = instrument => ({instrument,marketType:'COMMODITY',revision:'fixture',retrievedAt:new Date(at('18:00:00')).toISOString(),feeds:[],articles:[],inputs:{ global:configs[instrument].benchmarks.map(spec=>({name:spec.name,status:'AVAILABLE',fetchedAt:new Date(at('18:00:00')).toISOString(),sourceUrl:'https://source.example',message:null,data:{symbol:spec.symbol,price:100,changePercent:1,asOf:new Date(at('18:00:00')).toISOString()}})) }})
test('commodity global references use direct benchmark and FX cues, with no inverse equity vote or forced yield vote', () => {
 for(const [instrument]of instruments){const rows=globalMarketRows(context(instrument),at('18:00:00'));assert.deepEqual(rows.votes,[1,1]);assert.equal(rows.count,2);assert.equal(rows.details['US 10Y Yield'].vote,undefined);assert.match(rows.details['USD/INR'].caption,/Bullish commodity/)}
})
test('commodity assessment rejects index context/VIX/flows but accepts matching commodity global sentiment',()=>{
 const x=assess(), ctx=context(x.instrument), flow={status:'AVAILABLE',fetchedAt:ctx.retrievedAt,data:{asOf:ctx.retrievedAt,unit:'INR_CRORE',fiiCash:10000,diiCash:10000,netFlow:20000}}
 ctx.inputs.institutional=flow;ctx.inputs.openInterest={...flow,data:{...flow.data,pcr:2,expiry:'20-Nov-2026'}}
 const options={analysis:x.analysis,candles:x.candles,instrument:x.instrument,interval:'FIVE_MINUTE',now:x.now,indiaVix:{...flow,data:{...flow.data,symbol:'^INDIAVIX',price:99,changePercent:50}}}
 const equity=analyzeTradingEvidence({...options,context:{...ctx,marketType:undefined}})
 const mcx=analyzeTradingEvidence({...options,context:ctx})
 assert.equal(equity.bullishScore,x.evidence.bullishScore);assert.equal(mcx.bullishScore,x.evidence.bullishScore);assert.equal(mcx.indiaVix,undefined)
 assert.equal(mcx.layers.find(l=>l.key==='oi').coverage,0);assert.equal(mcx.sentiment.layers.find(l=>l.key==='flows').coverage,0)
 assert(mcx.sentiment.bullishScore>equity.sentiment.bullishScore)
})

test('commodity reversals develop symmetrically from completed trajectories rather than fixed time/price labels',()=>{
 for(const row of instruments)for(const d of [1,-1]){
  const [instrument,,base,scale]=row, candles=[];let price=base,found=false
  for(let i=0;i<115;i++){
   const change=scale*d*(i<80?1.2+Math.sin(i/3)*.7:-1.8+Math.sin(i/2)*.6)
   candles.push([new Date(at('10:00:00')+i*300000).toISOString(),price,Math.max(price,price+change)+.4*scale,Math.min(price,price+change)-.4*scale,price+change,100]);price+=change
   if(i<80)continue
   const now=at('10:00:00')+(i+1)*300000, analysis=analyzePriceAction(candles,'FIVE_MINUTE',now,instrument)
   const evidence=analyzeTradingEvidence({analysis,candles,instrument,interval:'FIVE_MINUTE',now})
   if(evidence.canConfirm&&evidence.selectedAnalysis.side===(d===1?'PUT':'CALL')){found=true;break}
  }
  assert(found,`${instrument} must support ${d===1?'SHORT':'LONG'} after a confirmed reversal`)
 }
})
test('shared commodity dashboard keeps all six tiles and never imports equity-only scores',()=>{
 const x=assess(),ctx=context(x.instrument), injected={status:'AVAILABLE',fetchedAt:ctx.retrievedAt,sourceUrl:'https://source.example',message:null,data:{asOf:ctx.retrievedAt,pcr:2,netFlow:10000,fiiCash:9000,diiCash:1000}}
 ctx.inputs.institutional=injected;ctx.inputs.openInterest=injected
 const dashboard=buildMarketDashboard({analysis:x.analysis,candles:x.candles,openingCandles:[],context:ctx,chartCurrent:true,now:x.now})
 assert.deepEqual(dashboard.tiles.map(tile=>tile.key),['chart','indicators','oi','flows','news','global'])
 for(const key of ['oi','flows']){assert.equal(dashboard.tiles.find(tile=>tile.key===key).score,undefined);assert.equal(dashboard.tiles.find(tile=>tile.key===key).coverage,0)}
 assert.equal(dashboard.tiles.find(tile=>tile.key==='global').rows.length,4)
})

test('commodity dashboard retains its own benchmark labels during a feed outage',()=>{const rows=globalMarketRows(null,at('18:00:00'),'Gold');assert.deepEqual(rows.rows.map(row=>row[0]),['Gold · US futures','USD/INR','US Dollar Index','US 10Y Yield']);assert.equal(rows.votes.length,0)})
