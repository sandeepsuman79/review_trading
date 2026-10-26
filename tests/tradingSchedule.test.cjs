const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, f)
const { inTradingEntryWindow, squareOffTime } = require('../src/analysis/tradingSession.ts')
const { buildGapOutlook, readGapOutlook, gapOutlookKey } = require('../src/analysis/gapOutlook.ts')
const { createPredictionRecord, syncPredictionRecord, registerConfirmedPrediction, readPredictionHistory, writePredictionHistory } = require('../src/analysis/predictionHistory.ts')
const { predictionEvents } = require('../src/analysis/predictionEvents.ts')
const at = (time, date = '2026-10-15') => Date.parse(`${date}T${time}+05:30`)
const cutoff = at('15:15:00')
function active(instrument, side) {
  const plan = { id: `schedule-${instrument}-${side}`, strategyVersion: 'technical-v2', instrument, side, stage: 'CONFIRMED', interval: 'ONE_MINUTE', generatedAt: cutoff - 180000, expiresAt: cutoff + 180000,
    signalCandleTime: new Date(cutoff - 240000).toISOString(), entry: 100, stopLoss: side === 'CALL' ? 90 : 110, target: side === 'CALL' ? 120 : 80, riskReward: 2, bullishScore: 70, bearishScore: 10, contextMode: 'TECHNICAL_ONLY', newsEvidence: [], technicalEvidence: [], newsSummary: 'Fixture', coverage: [], reason: 'Schedule fixture', targetBasis: 'Observed fixture level' }
  return { ...createPredictionRecord(plan), status: 'ACTIVE', entryAt: cutoff - 120000, entryPrice: 100, observedThrough: cutoff - 1000, latestPrice: 100, latestPriceAt: cutoff - 1000, latestPriceSource: 'LIVE' }
}
const tick = (timestamp, ltp) => ({ timestamp, ltp })

test('entry schedule is Mon–Fri 09:15 inclusive to 15:15 exclusive in IST', () => {
  for (const [time, allowed] of [['09:14:59', false], ['09:15:00', true], ['15:00:00', true], ['15:14:59', true], ['15:15:00', false], ['15:30:00', false]]) assert.equal(inTradingEntryWindow(at(time)), allowed, time)
  for (const day of ['2026-10-17', '2026-10-18']) assert.equal(inTradingEntryWindow(at('12:00:00', day)), false)
  assert.equal(inTradingEntryWindow(NaN), false);assert.equal(squareOffTime(at('12:00:00')), cutoff)
})

test('all indices and both sides square off at the first observed cutoff quote and preserve booked P/L', () => {
  for (const instrument of ['Nifty 50', 'Sensex', 'Bank Nifty']) for (const side of ['CALL', 'PUT']) {
    const record = active(instrument, side), closed = syncPredictionRecord(record, [], tick(cutoff, 103), cutoff, false, undefined, null)
    assert.equal(closed.status, 'EARLY_EXIT');assert.equal(closed.earlyExitSource, 'SESSION_SQUARE_OFF');assert.equal(closed.exitAt, cutoff)
    assert.equal(closed.exitPrice, 103);assert.equal(closed.points, side === 'CALL' ? 3 : -3)
    assert(predictionEvents([record], [closed])[0].reason.includes('square-off'))
    assert.deepEqual(syncPredictionRecord(closed, [], tick(cutoff + 1000, 99), cutoff + 1000), closed)
    const memory = new Map(), storage = { getItem: k => memory.get(k) ?? null, setItem: (k,v) => memory.set(k,v) }
    writePredictionHistory(storage, [closed]);assert.deepEqual(readPredictionHistory(storage), [closed])
  }
})

test('pending entries expire at cutoff and no same-index replacement is registered after square-off', () => {
  const record = active('Nifty 50', 'CALL'), pending = { ...createPredictionRecord(record), observedThrough: cutoff - 1000 }
  assert.equal(syncPredictionRecord(pending, [], tick(cutoff, 100), cutoff, true).status, 'EXPIRED')
  const closed = syncPredictionRecord(record, [], tick(cutoff, 103), cutoff, false)
  assert.deepEqual(registerConfirmedPrediction([closed], { ...record, id: 'late-put', side: 'PUT' }, cutoff), [closed])
})

test('missing cutoff quotes remain disclosed and later/overnight prices are never backdated to 15:15', () => {
  const record = active('Nifty 50', 'CALL')
  const waiting = syncPredictionRecord(record, [], undefined, cutoff, false, undefined, null)
  assert.equal(waiting.status, 'ACTIVE');assert.equal(waiting.exitPrice, undefined);assert.match(waiting.outcomeNote, /Waiting/)
  const delayed = syncPredictionRecord(waiting, [], tick(cutoff + 5000, 102), cutoff + 5000, false)
  assert.equal(delayed.exitAt, cutoff + 5000);assert.equal(delayed.exitPrice, 102)
  const overnight = syncPredictionRecord(record, [], tick(at('09:15:00','2026-10-16'), 150), at('09:15:00','2026-10-16'), false)
  assert.equal(overnight.status, 'UNVERIFIED');assert.equal(overnight.points, undefined)
})

test('cutoff replay preserves pre-cutoff stops and excludes later candle profits', () => {
  const record = { ...active('Nifty 50', 'CALL'), observedThrough: cutoff - 120000 }
  const bar = (offset, low = 99, high = 101) => [new Date(cutoff + offset).toISOString(),100,high,low,100,0]
  const stopped = syncPredictionRecord(record,[bar(-120000),bar(-60000,89)],tick(cutoff+60000,105),cutoff+60000,false)
  assert.equal(stopped.status,'STOP_LOSS_HIT');assert.equal(stopped.points,-10)
  const delayed = syncPredictionRecord(record,[bar(-120000),bar(-60000),bar(0,99,130)],tick(cutoff+60000,105),cutoff+60000,false)
  assert.equal(delayed.status,'EARLY_EXIT');assert.equal(delayed.earlyExitSource,'SESSION_SQUARE_OFF');assert.equal(delayed.exitAt,cutoff+60000);assert.equal(delayed.points,5)
  const gap = syncPredictionRecord(record,[],tick(cutoff+60000,105),cutoff+60000,false)
  assert.equal(gap.status,'ACTIVE');assert.equal(gap.points,undefined);assert.match(gap.outcomeNote,/Recovering/)
})

function outlookFixture(d = 1, instrument = 'Nifty 50', date = '2026-10-15') {
  const now = at('15:00:00', date), candles = Array.from({ length: 60 }, (_, i) => [new Date(now - (60-i)*300000).toISOString(), 22000 + d*i, 22100 + i, 21900 - i, 22000 + d*(i+1), 0])
  const analysis = { latestCandleTime: candles.at(-1)[0], structure: 'Fixture structure', setup: 'Fixture setup' }
  const evidence = { instrument, interval: 'FIVE_MINUTE', asOf: analysis.latestCandleTime, bullishScore: d === 1 ? 70 : 10, bearishScore: d === -1 ? 70 : 10, coverage: 85,
    checks: [{ label: 'Indicator warmup', passed: true }], missing: ['Spot-index VWAP unavailable'], sentiment: { bias: d === 1 ? 'BULLISH' : 'BEARISH', bullishScore: d === 1 ? 65 : 10, bearishScore: d === -1 ? 65 : 10, coverage: 80, missing: [] } }
  return { now, candles, analysis, evidence, instrument }
}
const build = x => buildGapOutlook(x.instrument, x.evidence, x.now)
test('external gap outlook supports all indices without a completed index chart', () => {
 for (const instrument of ['Nifty 50','Sensex','Bank Nifty']) for (const d of [1,-1]) {
  const input=outlookFixture(d,instrument)
  const result=build({...input,candles:[],analysis:{},evidence:{...input.evidence,interval:'ONE_HOUR',coverage:0,asOf:undefined,checks:[]}})
  assert.equal(result.bias,d===1?'GAP_UP_BIAS':'GAP_DOWN_BIAS');assert.equal(result.evidenceScore,55*d)
  assert.equal(result.referencePrice,undefined);assert.equal(result.technicalLead,0);assert.equal(result.probability,undefined)
  assert.deepEqual(readGapOutlook({getItem:()=>JSON.stringify(result)},instrument),result)
 }
})
test('late login, evening and overnight updates use current external evidence', () => {
 const input=outlookFixture()
 for (const clock of ['15:00:00','15:01:00','16:00:00','22:00:00']) {
  const result=build({...input,candles:[],analysis:{},now:at(clock)})
  assert(result);assert.equal(result.generatedAt,at(clock));assert.equal(Date.parse(result.asOf),at(clock))
 }
 const down=build({...input,now:at('22:00:00'),evidence:{...input.evidence,sentiment:{...input.evidence.sentiment,bias:'BEARISH',bullishScore:10,bearishScore:65}}})
 assert.equal(down.bias,'GAP_DOWN_BIAS');assert.equal(down.evidenceScore,-55)
 const overnight=build({...input,now:at('08:00:00','2026-10-16')})
 assert(overnight);assert.equal(overnight.session,'2026-10-15');assert.equal(overnight.expiresAt,at('09:15:00','2026-10-16'))
 assert.equal(build({...input,now:at('14:59:59')}),undefined)
 assert.equal(build({...input,now:at('09:15:00','2026-10-16')}),undefined)
 assert.equal(build({...input,now:at('10:00:00','2026-10-16')}),undefined)
})
test('Friday outlook updates through the weekend and exposes global, GIFT, flow and news evidence', () => {
 const input=outlookFixture(1,'Nifty 50','2026-10-16')
 input.evidence.sentiment.layers=[{name:'Global / GIFT Nifty',bullish:20,bearish:0,coverage:.8,details:['GIFT Nifty observed now']},{name:'FII / DII',bullish:10,bearish:0,coverage:1,details:['Latest published flows']},{name:'News',bullish:20,bearish:0,coverage:1,details:['New event assessed']}]
 const result=build({...input,now:at('20:00:00','2026-10-18')})
 assert(result);assert.equal(result.expiresAt,at('09:15:00','2026-10-19'))
 for (const text of ['GIFT Nifty observed now','Latest published flows','New event assessed']) assert(result.reasons.some(r=>r.includes(text)))
 assert.equal(build({...input,now:at('09:15:00','2026-10-19')}),undefined)
 assert.throws(()=>readGapOutlook({getItem:()=>JSON.stringify({...result,expiresAt:result.expiresAt+60000})},input.instrument))
})
test('missing external evidence cannot be replaced by bullish index technicals', () => {
 const input=outlookFixture()
 const result=build({...input,evidence:{...input.evidence,bullishScore:100,bearishScore:0,sentiment:{...input.evidence.sentiment,bias:'UNAVAILABLE',coverage:0,bullishScore:0,bearishScore:0,missing:['Unavailable news and global inputs']}}})
 assert.equal(result.bias,'MIXED');assert.equal(result.coverage,0);assert.equal(result.evidenceScore,0);assert(result.missing.includes('Unavailable news and global inputs'))
 assert.equal(build({...input,evidence:{...input.evidence,sentiment:{...input.evidence.sentiment,bullishScore:NaN}}}),undefined)
 for (const raw of ['bad json',JSON.stringify({...result,referencePrice:-1}),JSON.stringify({...result,generatedAt:result.generatedAt-60000})]) assert.throws(()=>readGapOutlook({getItem:()=>raw},input.instrument))
})
test('legacy one- and five-minute pre-close snapshots remain readable', () => {
 const input=outlookFixture()
 for (const duration of [60000,300000]) {
  const legacy={version:1,instrument:input.instrument,session:'2026-10-15',generatedAt:input.now,asOf:new Date(input.now-duration).toISOString(),bias:'GAP_UP_BIAS',evidenceScore:58,coverage:83,referencePrice:22000,technicalLead:60,sentimentLead:55,reasons:[],missing:[]}
  assert.deepEqual(readGapOutlook({getItem:()=>JSON.stringify(legacy)},input.instrument),legacy)
 }
})

test('after-close sentiment pipeline assesses fresh flows, news and global/GIFT quotes with no chart bars', () => {
 const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
 const markets = require('../src/data/globalMarkets.json')
 const now=at('22:00:00'), stamp=new Date(now).toISOString()
 const snap=data=>({status:'AVAILABLE',fetchedAt:stamp,data})
 const articles=[{id:'event',title:'New overnight market event',publishedAt:stamp,publisher:'Fixture',url:'https://example.com/event',category:'india',matchedCompanies:[]}]
 function assess(d) {
  const context={instrument:'Nifty 50',revision:'late-event',retrievedAt:stamp,articles,feeds:[{category:'india',status:'AVAILABLE'}],constituents:{status:'AVAILABLE'},inputs:{
   institutional:snap({asOf:stamp,unit:'INR_CRORE',fiiCash:d*2000,diiCash:d*1000,netFlow:d*3000}),
   global:markets.filter(m=>m.provider!=='nse').map(m=>({...snap({symbol:m.symbol,price:100,changePercent:d*m.indiaSign,asOf:stamp}),name:m.name})),
   giftNifty:snap({symbol:'GIFT_NIFTY',price:22000,changePercent:d,asOf:stamp})}}
  const outlook={contextRevision:context.revision,articleSentiments:[{articleId:'event',sentiment:d===1?'POSITIVE':'NEGATIVE',impactScore:d*2}],evidenceIds:['event']}
  const analysis={side:'WAIT',pattern:'NO_CONFIRMED_PATTERN',bullishEvidence:[],bearishEvidence:[],analyzedCandles:0}
  const evidence=analyzeTradingEvidence({analysis,candles:[],interval:'FIVE_MINUTE',instrument:'Nifty 50',now,context,outlook})
  return buildGapOutlook('Nifty 50',evidence,now)
 }
 assert.equal(assess(1).bias,'GAP_UP_BIAS');assert.equal(assess(-1).bias,'GAP_DOWN_BIAS')
 assert(assess(1).reasons.some(r=>r.includes('GIFT Nifty')))
 const result=assess(1)
 assert.equal(result.coverage,92,'missing futures positions and multi-session flows leave eight of the 40 FII/DII points unavailable')
 assert.equal(result.inputs.find(input=>input.name==='GIFT Nifty').bullish,30)
 assert.equal(result.inputs.find(input=>input.name==='Global markets').bullish,15)
 assert.equal(result.inputs.length,4)
})
