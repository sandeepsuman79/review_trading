const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
for (const extension of ['.ts','.tsx']) require.extensions[extension] = (m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f)
const React = require('react'), {renderToStaticMarkup}=require('react-dom/server')
const {buildGapOutlook,gapEvidenceComparison,readGapOutlook}=require('../src/analysis/gapOutlook.ts')
const Card=require('../src/components/GapOutlookCard.tsx').default
const now=Date.parse('2026-10-19T20:00:00+05:30')
function outlook(bullish=60,bearish=20,coverage=80) {
 return buildGapOutlook('Nifty 50',{instrument:'Nifty 50',sentiment:{bullishScore:bullish,bearishScore:bearish,coverage,bias:'BULLISH',missing:[],layers:[{name:'PCR reference',bullish:0,bearish:0,coverage:0,details:['Long background explanation must stay hidden']},{name:'FII / DII',bullish:20,bearish:0,coverage:1,details:[]},{name:'News',bullish:20,bearish:10,coverage:1,details:[]},{name:'Global markets / GIFT Nifty',bullish:20,bearish:10,coverage:1,details:[]}]}},now)
}
test('compact card shows colored input rows, evidence percentages and explicit thresholds without background detail',()=>{
 const data=outlook(),html=renderToStaticMarkup(React.createElement(Card,{instrument:'Nifty 50',outlook:data,error:'',now}))
 assert.deepEqual(gapEvidenceComparison(data),{up:75,down:25})
 for(const text of ['Prediction: Nifty 50','75.0%','25.0%','FII / DII','News','GIFT Nifty','Up lead ≥ +15','Down lead ≤ −15','availability ≥ 60%','Bias threshold met','not the probability']) assert(html.includes(text),text)
 assert(!html.includes('PCR reference'))
 assert(html.includes('gap-bullish'));assert(html.includes('gap-bearish'))
 assert(!html.includes('Long background explanation must stay hidden'))
 assert(!data.reasons.some(r=>r.includes('PCR reference')))
 assert.deepEqual(readGapOutlook({getItem:()=>JSON.stringify(data)},'Nifty 50'),data)
})
test('PCR has no gap score, availability or display contribution for any index, including saved rows',()=>{
 for(const instrument of ['Nifty 50','Sensex','Bank Nifty'])for(const d of [1,-1]){
  const data=buildGapOutlook(instrument,{instrument,sentiment:{bullishScore:30+(d===1?10:0),bearishScore:20+(d===-1?10:0),coverage:70,bias:'BULLISH',missing:['Current PCR reference'],layers:[{key:'pcr',name:'PCR reference',weight:10,bullish:d===1?10:0,bearish:d===-1?10:0,coverage:1,details:[]},{key:'flows',name:'FII / DII',weight:30,bullish:20,bearish:0,coverage:1,details:[]},{key:'news',name:'News',weight:30,bullish:10,bearish:20,coverage:1,details:[]}]}},now)
  assert.equal(data.bullishScore,30);assert.equal(data.bearishScore,20);assert.equal(data.evidenceScore,10);assert.equal(data.coverage,60);assert.equal(data.bias,'MIXED')
  assert(!JSON.stringify(data).includes('PCR reference'))
  const saved={...data,inputs:[...data.inputs,{name:'PCR reference',bullish:10,bearish:0,coverage:100}]}
  const html=renderToStaticMarkup(React.createElement(Card,{instrument,outlook:saved,error:'',now}))
  assert(!html.includes('PCR reference'));assert(html.includes('News'))
 }
})
test('zero evidence has no invented percentage, and directional confirmation needs both lead and coverage',()=>{
 assert.equal(gapEvidenceComparison(outlook(0,0,0)),undefined)
 assert.equal(outlook(30,15,60).bias,'GAP_UP_BIAS')
 assert.equal(outlook(15,30,60).bias,'GAP_DOWN_BIAS')
 assert.equal(outlook(30,15,59).bias,'MIXED')
 assert.equal(outlook(29.9,15,60).bias,'MIXED')
 const html=renderToStaticMarkup(React.createElement(Card,{instrument:'Nifty 50',outlook:outlook(),error:'',now:now+180000}))
 assert(!html.includes('✓ Bias threshold met'));assert(html.includes('Saved reading'))
})
test('malformed stored summary values are rejected',()=>{
 const data=outlook()
 assert.throws(()=>readGapOutlook({getItem:()=>JSON.stringify({...data,inputs:[{name:'News',bullish:-1,bearish:0,coverage:100}]})},'Nifty 50'))
})
