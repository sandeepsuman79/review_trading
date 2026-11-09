const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
const compile=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f)
require.extensions['.ts']=compile;require.extensions['.tsx']=compile
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server')
const Legend=require('../src/components/ChartIndicatorLegend.tsx').default
const names=['Supertrend (10,3)','VWAP','EMA 20','EMA 50','SMA 20'],colors=['#16A34A','#A855F7','#0EA5E9','#F59E0B','#64748B']
const visibility={supertrend:true,vwap:true,ema20:true,ema50:true,sma20:false}
test('all seven market legends include every plotted indicator name and its matching color',()=>{
 for(const name of['Nifty 50','Sensex','Bank Nifty','Crude Oil','Gold','Silver','Natural Gas']){
  const spotIndex=['Nifty 50','Sensex','Bank Nifty'].includes(name)
  const html=renderToStaticMarkup(React.createElement(Legend,{visibility,onToggle:()=>{},hasVwap:!spotIndex,spotIndex,onShowAtm:()=>{},trade:{entry:100,target:120,stopLoss:90,trailingStop:105}}))
  for(let i=0;i<names.length;i++){assert(html.includes(names[i]));assert(html.includes(colors[i]))}
  assert(html.includes('Target · Exit or extend'));assert(html.includes('Initial stop-loss'));assert(html.includes('TSL 105'))
  assert.equal(html.includes('VWAP <small>ATM</small>'),spotIndex)
 }
})
test('CE/PE price-action views retain named color keys without claiming active overlays',()=>{
 const html=renderToStaticMarkup(React.createElement(Legend,{visibility,onToggle:()=>{},hasVwap:false,spotIndex:true,priceActionOnly:true}))
 assert.equal((html.match(/disabled=""/g)||[]).length,5)
 assert.equal((html.match(/aria-pressed="true"/g)||[]).length,0)
 for(const label of names)assert(html.includes(label))
})
test('the chart renders its legend outside collapsed indicator values, including commodity and empty views',()=>{
 const apexPath=require.resolve('react-apexcharts'),saved=require.cache[apexPath],oldLayout=React.useLayoutEffect
 require.cache[apexPath]={id:apexPath,filename:apexPath,loaded:true,exports:{__esModule:true,default:()=>React.createElement('div',null,'Plot')}}
 React.useLayoutEffect=React.useEffect
 try{
  const Chart=require('../src/components/CandleChart.tsx').default
  const {fixture,markets}=require('./helpers/confirmation.cjs'),now=Date.parse('2026-11-05T14:00:00+05:30')
  for(const row of markets)for(const empty of[false,true]){
   const f=fixture(row,1,'FIVE_MINUTE',now),html=renderToStaticMarkup(React.createElement(Chart,{name:row[0],now,candles:empty?[]:f.candles,spotIndex:!row[3],interval:'FIVE_MINUTE',intervalLabel:'5 minutes',savedCandleCount:52,isLive:false,marketHeartbeat:'Fixture'}))
   for(const label of names)assert(html.includes(label),row[0])
   assert.equal((html.match(/aria-label="Chart indicator visibility"/g)||[]).length,1)
   if(!empty)assert(html.indexOf('chart-indicator-legend')<html.indexOf('chart-indicator-disclosure'))
  }
 }finally{React.useLayoutEffect=oldLayout;if(saved)require.cache[apexPath]=saved;else delete require.cache[apexPath]}
})
