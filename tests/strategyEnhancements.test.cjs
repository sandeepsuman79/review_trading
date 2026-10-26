const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, f)
const { scoreDominates, scoreTrajectory } = require('../src/analysis/scoreTrajectory.ts')
const { sessionReviewDue, buildSessionReview, learnTradeOutcomes } = require('../src/analysis/sessionReview.ts')
const { syncPredictionRecord, observePredictionCandles, readPredictionHistory, writePredictionHistory } = require('../src/analysis/predictionHistory.ts')
const time = clock => Date.parse(`2026-10-19T${clock}:00+05:30`)
test('1.5x replaces absolute floors, is symmetric and rejects zero ties and invalid scores', () => {
 assert(scoreDominates(15,10)); assert(scoreDominates(10,0)); assert(!scoreDominates(0,0)); assert(!scoreDominates(14.9,10)); assert(!scoreDominates(NaN,0)); assert(!scoreDominates(10,-1))
})
test('opposing score trajectories detect pressure before the dominant score changes; gaps do not produce pressure', () => {
 const samples = [0,1,2].map(i => ({at: time('10:00') + i*300000, bullish:80-i*5, bearish:i*5}))
 assert.equal(scoreTrajectory(samples).state,'BEARISH_PRESSURE')
 assert.equal(scoreTrajectory(samples.map(s=>({...s,bullish:s.bearish,bearish:s.bullish}))).state,'BULLISH_PRESSURE')
 assert.equal(scoreTrajectory([samples[0],samples[1],{...samples[2],at:time('11:00')}]).state,'WARMING_UP')
})
function trade(i, status='TARGET_HIT') {
 const entryAt = time('10:00') + i*60000
 return { id:`trade-${i}`, instrument:'Nifty 50', strategyVersion:'technical-v2', stage:'CONFIRMED', side:i%2?'PUT':'CALL', interval:'FIVE_MINUTE', signalCandleTime:new Date(entryAt-300000).toISOString(),generatedAt:entryAt,expiresAt:entryAt+300000,status,entry:100,entryPrice:100,entryAt,entrySource:'LIVE',stopLoss:90,target:120,riskReward:2,targetBasis:'test',reason:'test',contextMode:'TECHNICAL_ONLY',bullishScore:60,bearishScore:20,technicalEvidence:[],newsSummary:'',newsEvidence:[],coverage:[],evidenceSummary:{version:'technical-v2',coverage:85,layers:[40,45,15].map(weight=>({name:'Fixture',weight,coverage:.85,bullish:0,bearish:0}))},observedThrough:entryAt+1000,exitAt:entryAt+30000,exitPrice:i%2?90:120,points:i%2?-10:20,outcomeNote:'test' }
}
test('review runs after 15:15 IST on weekdays and does not close MCX early', () => {
 assert(!sessionReviewDue('Nifty 50',time('15:14')));assert(sessionReviewDue('Nifty 50',time('15:15')))
 assert(!sessionReviewDue('Gold',time('15:15')))
 assert(!sessionReviewDue('Nifty 50',Date.parse('2026-10-18T16:00:00+05:30')))
})
test('daily report counts confirmed signals separately from unresolved and verified outcomes', () => {
 const records=[trade(0),trade(1),trade(2,'UNVERIFIED'),{...trade(3,'PENDING'),entryAt:undefined,points:undefined,exitAt:undefined}]
 const report=buildSessionReview('Nifty 50',records,[],time('15:15'))
 assert.equal(report.confirmed,4);assert.equal(report.entered,3);assert.equal(report.settled,2);assert.equal(report.wins,1);assert.equal(report.losses,1);assert.equal(report.unresolved,2);assert.equal(report.winRate,.5);assert.equal(report.points,10)
 assert.equal(report.model.status,'INSUFFICIENT_HISTORY')
})
test('learned model uses chronological holdout and excludes unresolved outcomes', () => {
 const rows=Array.from({length:40},(_,i)=>trade(i))
 const model=learnTradeOutcomes([...rows,trade(41,'UNVERIFIED')])
 assert.equal(model.status,'TRAINED');assert.equal(model.samples,40);assert.equal(model.training,30);assert.equal(model.holdout,10);assert(model.accuracy>=0&&model.accuracy<=1);assert(model.weights.every(Number.isFinite))
 assert.equal(learnTradeOutcomes(rows.map(r=>({...r,exitAt:time('15:00')}))).status,'INSUFFICIENT_HISTORY')
})
test('refresh keeps the saved entry active while reconnect history is loading; a later quote cannot manufacture a win', () => {
 const active={...trade(0,'ACTIVE'),exitAt:undefined,exitPrice:undefined,points:undefined}
 let saved; const storage={setItem:(_k,v)=>{saved=v},getItem:()=>saved}
 writePredictionHistory(storage,[active]);const restored=readPredictionHistory(storage)[0]
 const recovered=syncPredictionRecord(restored,[],{timestamp:time('10:01'),ltp:130},time('10:01'))
 assert.equal(recovered.status,'ACTIVE');assert.equal(recovered.entryAt,active.entryAt);assert.equal(recovered.points,undefined);assert.match(recovered.outcomeNote,/Recovering/)
 const harmless=[new Date(time('10:00')).toISOString(),100,102,99,101,0]
 const replayed=observePredictionCandles(recovered,[harmless],time('10:05'))
 assert.equal(replayed.status,'ACTIVE');assert.equal(replayed.observedThrough,time('10:05'))
 const reference=observePredictionCandles(recovered,[[harmless[0],100,125,99,120,0]],time('10:05'))
 assert.equal(reference.status,'ACTIVE');assert.equal(reference.entryAt,active.entryAt);assert.equal(reference.protection.peakPrice,120)
 const touched=observePredictionCandles(recovered,[[harmless[0],100,125,89,120,0]],time('10:05'))
 assert.equal(touched.status,'ACTIVE');assert.equal(touched.entryAt,active.entryAt,'a possible missed stop keeps the saved position in recovery')
 assert.equal(touched.points,undefined);assert.match(touched.outcomeNote,/Recovering saved trade/)
})

test('indicator candle changes remain independent of score direction and include Supertrend and shared VIX risk',()=>{
 const {indicatorTrajectoryRows}=require('../src/analysis/scoreTrajectory.ts')
 const samples=[0,1,2].map(i=>({at:time('10:00')+i*300000,bullish:80,bearish:10,supertrendDirection:'UP',indicators:{EMA20:[100,103,102][i],EMA50:99+i,RSI:[60,55,58][i],Supertrend:95+i,ATR:2+i*.1,'India VIX':15+i}}))
 const rows=indicatorTrajectoryRows(samples), row=name=>rows.find(r=>r.name===name)
 assert.equal(row('EMA20').change,-1);assert.equal(row('EMA20').turn,'FROM_PEAK');assert.equal(row('EMA20').high,103)
 assert.equal(row('RSI').change,3);assert.equal(row('RSI').turn,'FROM_TROUGH')
 assert.equal(row('Supertrend').direction,'UP');assert.equal(row('Supertrend').change,1)
 assert.equal(row('India VIX').risk,true);assert.equal(row('India VIX').change,1)
 assert.equal(row('ATR').risk,true)
 const gap=indicatorTrajectoryRows([samples[0],{...samples[2],at:time('11:00')}])
 assert.equal(gap.find(r=>r.name==='EMA20').change,undefined)
 const missing=indicatorTrajectoryRows([...samples,{at:time('10:15'),bullish:80,bearish:10,indicators:{RSI:59}}])
 assert.equal(missing.find(r=>r.name==='India VIX').value,undefined)
 assert.equal(missing.find(r=>r.name==='India VIX').change,undefined)
})
