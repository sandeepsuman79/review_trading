const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {analyzeSwingTrajectory}=require('../src/analysis/swingTrajectory.ts')
const {analyzeDirectionalAlignment}=require('../src/analysis/directionalAlignment.ts')
const start=Date.parse('2026-10-20T10:00:00+05:30'),duration=300000
const values=[10,15,11,16,12,17,14,13,10]
const points=values=>values.map((value,i)=>({at:start+i*duration,value}))
test('confirmed HH/HL breakdown and mirrored LH/LL breakout occur on their actual crossing candle',()=>{
 const down=analyzeSwingTrajectory(points(values),duration,.05)
 assert.equal(down.trend,'UPTREND');assert.equal(down.pattern,'HH / HL');assert.equal(down.breakDirection,'DOWN');assert(down.newBreak)
 const up=analyzeSwingTrajectory(points(values.map(v=>30-v)),duration,.05)
 assert.equal(up.pattern,'LH / LL');assert.equal(up.breakDirection,'UP');assert(up.newBreak)
 const before=analyzeSwingTrajectory(points(values.slice(0,-1)),duration,.05)
 assert.equal(before.breakDirection,undefined)
 const held=analyzeSwingTrajectory(points([...values,9]),duration,.05)
 assert.equal(held.breakDirection,'DOWN');assert.equal(held.newBreak,false)
})
test('unfinished swings, tiny noise, missing values and missing candles cannot create a swing reversal',()=>{
 assert.equal(analyzeSwingTrajectory(points([1,2,3,4,5,6,7]),duration,.05).trend,'WARMING_UP')
 assert.equal(analyzeSwingTrajectory(points(values.map(v=>100+v*.001)),duration,.05).newBreak,false)
 const missing=points(values);missing[6].value=undefined
 assert.equal(analyzeSwingTrajectory(missing,duration,.05).newBreak,false)
 const gap=points(values);gap[7].at+=1000
 assert.equal(analyzeSwingTrajectory(gap,duration,.05).newBreak,false)
 const nextDay=points(values);nextDay[nextDay.length-1].at+=86400000
 assert.equal(analyzeSwingTrajectory(nextDay,duration,.05).newBreak,false)
})
function fixture(d=-1) {
 const candles=values.map((v,i)=>{const close=i===values.length-1?9:v;return[new Date(start+i*duration).toISOString(),close+1,close+1.5,close-.5,close,100]})
 const averages=values.map(v=>({ema20:v,ema50:20})),indicators=values.map(v=>({rsi14:2*v+30,atr14:2,supertrend10:5,supertrendDirection:'UP'}))
 if(d===1) return {candles:candles.map(c=>[c[0],30-c[1],30-c[3],30-c[2],30-c[4],c[5]]),averages:averages.map(a=>({ema20:30-a.ema20,ema50:30-a.ema50})),indicators:indicators.map(p=>({...p,rsi14:100-p.rsi14,supertrend10:25,supertrendDirection:'DOWN'}))}
 return {candles,averages,indicators}
}
test('EMA plus RSI structure breaks support both routes only with completed price and momentum confirmation',()=>{
 for(const d of [-1,1]) {
  const f=fixture(d),route=()=>analyzeDirectionalAlignment(f.candles,f.averages,f.indicators,'FIVE_MINUTE').routes.filter(r=>r.name.startsWith('Indicator swing reversal'))
  const result=route();assert.equal(result.length,1);assert.equal(result[0].side,d===1?'CALL':'PUT');assert.match(result[0].name,/EMA20.*RSI/)
  f.indicators=f.indicators.map(p=>({...p,rsi14:50}));assert.equal(route().length,0)
 }
 const f=fixture();f.candles.at(-1)[4]=f.candles.at(-2)[3]+.01
 assert.equal(analyzeDirectionalAlignment(f.candles,f.averages,f.indicators,'FIVE_MINUTE').routes.filter(r=>r.name.startsWith('Indicator swing reversal')).length,0)
})
