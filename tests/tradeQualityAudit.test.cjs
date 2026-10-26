const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {auditTradeQuality}=require('../src/analysis/tradeQualityAudit.ts')
const {fixture,markets}=require('./helpers/confirmation.cjs')
const now=Date.parse('2026-10-26T14:00:00+05:30'),bars=fixture(markets[0],1,'FIVE_MINUTE',now)
const frames={FIVE_MINUTE:bars.candles,FIFTEEN_MINUTE:fixture(markets[0],1,'FIFTEEN_MINUTE',now).candles,ONE_HOUR:fixture(markets[0],1,'ONE_HOUR',now).candles}
function record(change={}){return{id:'audit',instrument:'Nifty 50',side:'CALL',stage:'CONFIRMED',strategyVersion:'technical-v2',status:'EARLY_EXIT',earlyExitSource:'AGENT_PROTECTION',interval:'FIVE_MINUTE',generatedAt:now,entryAt:now+1,entryPrice:22008,entry:22008,stopLoss:22000,target:22024,signalCandleTime:bars.candles.at(-1)[0],exitAt:now+2000,exitPrice:22012,points:4,...change}}
const audit=(records,changes={})=>auditTradeQuality({instrument:'Nifty 50',records,candlesByInterval:frames,now:now+3600000,...changes})
test('audit counts only actual entered trades and booked outcomes in the current IST session',()=>{
 const result=audit([record(),record({id:'loss',points:-8,exitPrice:22000}),record({id:'open',status:'ACTIVE',points:undefined,exitAt:undefined,exitPrice:undefined}),record({id:'uncertain',status:'UNVERIFIED',points:undefined,exitAt:undefined}),record({id:'early',stage:'EARLY'}),record({id:'other',instrument:'Sensex'}),record({id:'yesterday',entryAt:now-86400000}),record({id:'future',entryAt:now+7200000})])
 assert.equal(result.summary.entries,4);assert.equal(result.summary.settled,2);assert.equal(result.summary.wins,1);assert.equal(result.summary.losses,1);assert.equal(result.summary.points,-4);assert.equal(result.summary.unresolved,2);assert.equal(result.summary.meanR,-.25)
 assert.equal(result.rows[0].priceAssessment,'PASS');assert.match(result.scope,/retrospective price filters only/)
})
test('missing signal or higher candles are unavailable, not hypothetical avoided losses',()=>{
 const missing=audit([record()],{candlesByInterval:{FIVE_MINUTE:bars.candles.slice(0,-1)}})
 assert.equal(missing.rows[0].priceAssessment,'UNAVAILABLE');assert.equal(missing.summary.priceBlocked,0)
 const higher=audit([record()],{candlesByInterval:{...frames,FIFTEEN_MINUTE:[]}})
 assert.equal(higher.rows[0].priceAssessment,'UNAVAILABLE');assert.equal(higher.summary.unavailable,1)
})
test('a conflicting trend is a retrospective blocker while the actual recorded loss remains a loss',()=>{
 const result=audit([record({points:-8,exitPrice:22000})],{candlesByInterval:{...frames,FIFTEEN_MINUTE:fixture(markets[0],-1,'FIFTEEN_MINUTE',now).candles}})
 assert.equal(result.rows[0].priceAssessment,'BLOCK');assert.equal(result.summary.points,-8);assert.equal(result.summary.losses,1)
 assert(result.rows[0].blockers.some(text=>/Higher timeframe/.test(text)))
})
test('future higher candles and later price moves never revise the signal-time assessment',()=>{
 const input=[record()],before=JSON.stringify(input),expected=audit(input)
 const later=bars.candle(now,0,100,-100,50),extended=audit(input,{candlesByInterval:{...frames,FIVE_MINUTE:[...frames.FIVE_MINUTE,later],FIFTEEN_MINUTE:[...frames.FIFTEEN_MINUTE,later]}})
 assert.deepEqual(extended.rows[0].assessment,expected.rows[0].assessment);assert.equal(JSON.stringify(input),before)
 const notExited=audit([record({exitAt:now+7200000})]);assert.equal(notExited.summary.settled,0)
})
test('empty browser history produces an honest empty report without invented market losses',()=>{
 const report=audit([]);assert.equal(report.summary.entries,0);assert.equal(report.summary.meanR,null);assert.deepEqual(report.rows,[])
})
test('MCX audit requires the exact saved contract and never applies front-contract candles to another expiry',()=>{
 const contract={token:'123',symbol:'GOLD20NOV26FUT',expiry:'2026-11-20',exchange:'MCX'}
 const candlesByInterval=Object.fromEntries(['FIVE_MINUTE','FIFTEEN_MINUTE','ONE_HOUR'].map(interval=>[interval,fixture(markets[5],1,interval,now).candles]))
 const saved=record({instrument:'Gold',contract,signalCandleTime:candlesByInterval.FIVE_MINUTE.at(-1)[0]})
 const run=current=>auditTradeQuality({instrument:'Gold',records:[saved],candlesByInterval,contract:current,now:now+3600000})
 assert.equal(run(contract).rows[0].priceAssessment,'PASS')
 for(const other of[undefined,{...contract,token:'456'},{...contract,symbol:'GOLD21DEC26FUT'}]){
  const result=run(other);assert.equal(result.rows[0].priceAssessment,'UNAVAILABLE');assert.match(result.rows[0].blockers[0],/exact MCX contract/)
  assert.equal(result.summary.points,4,'actual booked outcome remains visible even when historical diagnosis is unavailable')
 }
})
