const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f)
const {candlePriceBounds}=require('../src/analysis/candlePriceDomain.ts')
function sensex(){
 const start=Date.parse('2026-11-05T10:45:00+05:30')
 const bars=Array.from({length:60},(_,i)=>{const o=78650+i*12;return[new Date(start+i*300000).toISOString(),o,o+45,o-25,o+18,0]})
 bars[57][2]=79630;bars[57][3]=77500
 return bars
}
test('the screenshot-shaped Sensex wick no longer stretches focused view; full mode restores it unchanged',()=>{
 const bars=sensex(),original=JSON.stringify(bars),focused=candlePriceBounds(bars,.01,true),full=candlePriceBounds(bars,.01,false)
 assert(focused.low>78500);assert.equal(focused.high,79630);assert.equal(full.low,77500)
 assert.deepEqual(focused.extremes,[{index:57,side:'LOW',value:77500}])
 assert(full.high-full.low>1.9*(focused.high-focused.low))
 assert.equal(JSON.stringify(bars),original)
})
test('mirrored isolated upper wicks focus safely for all three index price scales',()=>{
 for(const base of[24500,79500,57700]){
  const bars=sensex().map(([t,o,h,l,c,v])=>[t,base-(o-79000),base-(l-79000),base-(h-79000),base-(c-79000),v])
  const fit=candlePriceBounds(bars,.01,true)
  assert.equal(fit.extremes.length,1);assert.equal(fit.extremes[0].side,'HIGH')
  assert(bars.every(b=>b[1]>=fit.low&&b[1]<=fit.high&&b[4]>=fit.low&&b[4]<=fit.high))
 }
})
test('large actual body moves and genuine current quotes remain in the focused domain',()=>{
 const bars=sensex(),live=candlePriceBounds(bars,.01,true,77400)
 assert.equal(live.low,77400);assert.equal(live.extremes.length,0)
 bars[58][1]=77500;bars[58][3]=77490
 const moved=candlePriceBounds(bars,.01,true)
 assert(moved.low<=77490);assert(moved.high>=79630)
})
test('short history and recurring long wicks retain the complete observed range',()=>{
 const bars=sensex().slice(-10)
 assert.equal(candlePriceBounds(bars,.01,true).low,77500)
 const repeated=sensex()
 for(let i=30;i<40;i++)repeated[i][3]=77500
 const fit=candlePriceBounds(repeated,.01,true)
 assert.equal(fit.low,77500);assert.equal(fit.extremes.length,0)
})
test('ordinary candles and full mode include every wick and preserve flat, single and empty histories',()=>{
 const normal=sensex().slice(0,40),fit=candlePriceBounds(normal,.01,true)
 assert.equal(fit.extremes.length,0);assert.equal(fit.low,Math.min(...normal.map(b=>b[3])));assert.equal(fit.high,Math.max(...normal.map(b=>b[2])))
 assert(candlePriceBounds([normal[0]],.01,true).high>0)
 const flat=normal.map(b=>[b[0],100,100,100,100,0]);assert.deepEqual(candlePriceBounds(flat,.01,true),{low:100,high:100,extremes:[]})
 assert(candlePriceBounds([],.01,true).high>0)
})
