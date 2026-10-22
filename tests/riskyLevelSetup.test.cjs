const atmVwapFixture = require('./helpers/atmVwap.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename)
const { findRiskyLevelSetup } = require('../src/analysis/riskyLevelSetup.ts')
const { buildEarlyPrediction } = require('../src/analysis/earlyPrediction.ts')
const { registerConfirmedPrediction, canEnterConfirmedPrediction, createPredictionRecord } = require('../src/analysis/predictionHistory.ts')
const { analyzePriceAction } = require('../src/analysis/priceAction.ts')
const { analyzeTradingEvidence } = require('../src/analysis/tradingEvidence.ts')
const start = Date.parse('2026-10-14T09:15:00+05:30'), interval = 'FIVE_MINUTE'
function fixture(d = 1) {
  const mirror = value => d === 1 ? value : 200 - value
  const candles = Array.from({length:50},(_,i)=>[new Date(start+i*300000).toISOString(),mirror(101),mirror(d===1?102:100),mirror(d===1?100:102),mirror(101),0])
  const checks = ['Recent completed candles','Confirmed price pattern','Indicator warmup','ATR risk','Technical coverage','Directional agreement','Reward versus risk'].map((label,i)=>({label,passed:[0,2,3,4].includes(i)}))
  const analysis={side:'WAIT',analyzedCandles:50,latestCandleTime:candles.at(-1)[0],currentPrice:mirror(101),support:mirror(d===1?100:109),resistance:mirror(d===1?109:100),atr14:2,exponentialMovingAverage20:mirror(100.8),exponentialMovingAverage50:mirror(99.5),rsi14:d===1?54:46,rsi14Momentum:d,supertrendDirection:d===1?'UP':'DOWN',adx14:23,plusDi14:d===1?30:20,minusDi14:d===1?20:30,earlyBias:d===1?'BULLISH':'BEARISH',bullishScore:d===1?45:25,bearishScore:d===1?25:45}
  analysis.alignment={at:candles.at(-1)[0],routes:[{family:'EMA',side:d===1?'CALL':'PUT',name:`EMA20/50 trajectory ${d===1?'up':'down'}`}]}
  return {analysis,candles,checks,bullishScore:analysis.bullishScore,bearishScore:analysis.bearishScore,interval,now:start+50*300000}
}

test('four checks plus level reaction and indicators produce explicit CALL/PUT risky conditional setups',()=>{
  for(const d of [1,-1]){
    const input=fixture(d),risk=findRiskyLevelSetup(input)
    assert(risk);assert.equal(risk.side,d===1?'CALL':'PUT');assert.equal(risk.passedChecks,4);assert(risk.riskReward>=1.5)
    assert.equal(risk.levelType,d===1?'SUPPORT':'RESISTANCE');assert(Math.abs(risk.entry-risk.stopLoss)>=2)
    const evidence={instrument:'Nifty 50',interval,asOf:input.analysis.latestCandleTime,canConfirm:false,reason:'Waiting for price pattern',riskySetup:risk,version:'technical-v2',bullishScore:input.bullishScore,bearishScore:input.bearishScore,coverage:75,layers:[],sentiment:{},bullishEvidence:[],bearishEvidence:[]}
    const prediction=buildEarlyPrediction(input.analysis,'Nifty 50',interval,input.now,undefined,undefined,evidence)
    assert.equal(prediction.plan.stage,'RISKY');assert.match(prediction.reason,/4\/7/);assert(prediction.plan.risk.unmetChecks.includes('Confirmed price pattern'))
    assert.deepEqual(registerConfirmedPrediction([],prediction.plan,input.now),[],'risky ideas never become confirmed ledger records')
    assert.equal(canEnterConfirmedPrediction(createPredictionRecord(prediction.plan),prediction.plan,input.now,input.now),false)
  }
})

test('any four arbitrary checks cannot bypass stale data, warmup, ATR or indicator agreement',()=>{
  const input=fixture()
  assert.equal(findRiskyLevelSetup({...input,checks:input.checks.map((c,i)=>({...c,passed:i<3}))}),undefined)
  assert.equal(findRiskyLevelSetup({...input,now:input.now+300000}),undefined)
  assert.equal(findRiskyLevelSetup({...input,candles:input.candles.slice(-25)}),undefined)
  assert.equal(findRiskyLevelSetup({...input,analysis:{...input.analysis,atr14:0}}),undefined)
  assert.equal(findRiskyLevelSetup({...input,analysis:{...input.analysis,alignment:{at:input.analysis.latestCandleTime,routes:[]}}}),undefined)
  assert.equal(findRiskyLevelSetup({...input,bullishScore:35,bearishScore:30}),undefined)
})

test('nearby target caps, missing or distant levels and invalid chronology reject risky ideas',()=>{
  const input=fixture()
  assert.equal(findRiskyLevelSetup({...input,analysis:{...input.analysis,resistance:103}}),undefined)
  assert.equal(findRiskyLevelSetup({...input,analysis:{...input.analysis,support:90}}),undefined)
  assert.equal(findRiskyLevelSetup({...input,analysis:{...input.analysis,support:undefined,resistance:undefined}}),undefined)
  const candles=input.candles.map((c,i)=>i===48?[new Date(Date.parse(c[0])-300000).toISOString(),...c.slice(1)]:c)
  assert.equal(findRiskyLevelSetup({...input,candles}),undefined)
})

test('absent opposite target uses a clearly labelled projection, and no setup is offered after session close',()=>{
  const input=fixture(),risk=findRiskyLevelSetup({...input,analysis:{...input.analysis,resistance:undefined}})
  assert(risk);assert.match(risk.targetBasis,/projection.*not an observed level/)
  assert.equal(findRiskyLevelSetup({...input,now:Date.parse('2026-10-14T15:30:00+05:30')}),undefined)
})

test('full chart and indicator confirmation retains CONFIRMED stage',()=>{
  const candles=Array.from({length:52},(_,i)=>{const open=22000+i*.3+Math.sin(i/4)*6,close=open+2;return[new Date(start+i*300000).toISOString(),open,close+.7,open-.7,close,0]})
  const now=start+52*300000,analysis=analyzePriceAction(candles,interval,now),evidence=analyzeTradingEvidence({analysis,candles,instrument:'Nifty 50',interval,now,atmVwap:atmVwapFixture('Nifty 50',analysis.currentPrice,now,1)})
  assert(evidence.canConfirm);assert.equal(evidence.riskySetup,undefined)
  assert.equal(buildEarlyPrediction(analysis,'Nifty 50',interval,now,undefined,undefined,evidence).plan.stage,'CONFIRMED')
})

test('derived indicators and detected levels produce CALL/PUT risky setups from seeded OHLC data',()=>{
  let seed=1234567, candles
  const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296}
  for(let trial=0;trial<=90;trial++){
    let close=22000
    candles=Array.from({length:70},(_,i)=>{
      close+=.3+(random()-.5)*7
      const open=close-(random()-.5)*1.5, high=Math.max(close,open)+1+random()*3, low=Math.min(close,open)-1-random()*3
      return[new Date(start+i*300000).toISOString(),open,high,low,close,0]
    })
  }
  for(const d of [1,-1]){
    const data=d===1?candles:candles.map(c=>[c[0],44000-c[1],44000-c[3],44000-c[2],44000-c[4],0])
    const now=start+70*300000,analysis=analyzePriceAction(data,interval,now)
    const evidence=analyzeTradingEvidence({analysis,candles:data,instrument:'Nifty 50',interval,now,atmVwap:atmVwapFixture('Nifty 50',analysis.currentPrice,now,d)})
    assert.equal(evidence.checks.filter(c=>c.passed).length,4);assert.equal(evidence.canConfirm,false)
    assert(evidence.riskySetup);assert.equal(evidence.riskySetup.side,d===1?'CALL':'PUT')
    assert.equal(buildEarlyPrediction(analysis,'Nifty 50',interval,now,undefined,undefined,evidence).plan.stage,'RISKY')
  }
})


test('one EMA route can support a risky proposal with opposed Supertrend and DMI, but stale routes cannot',()=>{
  for(const d of [1,-1]){
    const input=fixture(d)
    input.analysis.supertrendDirection=d===1?'DOWN':'UP'
    input.analysis.adx14=10
    const risk=findRiskyLevelSetup(input)
    assert(risk);assert.equal(risk.side,d===1?'CALL':'PUT')
    assert.equal(risk.alignedIndicators.length,1);assert(risk.opposedIndicators.includes('Supertrend'))
    assert.equal(findRiskyLevelSetup({...input,analysis:{...input.analysis,alignment:{...input.analysis.alignment,at:input.candles.at(-2)[0]}}}),undefined)
  }
})
