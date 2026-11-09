const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
const compile=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f)
require.extensions['.ts']=compile;require.extensions['.tsx']=compile
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server')
test('CE and PE preserve the underlying candles and show a plain directional price-action view',()=>{
 const chartPath=require.resolve('../src/components/CandleChart.tsx'),prior=require.cache[chartPath],oldState=React.useState
 let captured,view='INDEX'
 require.cache[chartPath]={id:chartPath,filename:chartPath,loaded:true,exports:{__esModule:true,default:props=>{captured=props;return React.createElement('div',null,props.chartControls)}}}
 React.useState=()=>[view,value=>{view=value}]
 try{
  const Chart=require('../src/components/IndexOptionChart.tsx').default
  const candles=[['2026-11-04T10:00:00+05:30',23000,23010,22990,23005,0]],tick={ltp:23006}
  const props={candles,tick,name:'Nifty 50',spotIndex:true,interval:'FIVE_MINUTE',intervalLabel:'5 minutes',savedCandleCount:1,now:Date.parse('2026-11-04T10:05:00+05:30'),isLive:true,marketHeartbeat:'Live'}
  for(const side of['INDEX','CE','PE']){
   view=side;const html=renderToStaticMarkup(React.createElement(Chart,props))
   assert.equal(captured.candles,candles);assert.equal(captured.tick,tick);assert.equal(captured.name,'Nifty 50')
   assert.equal(captured.priceActionOnly,side!=='INDEX');assert(!html.includes('ATM contract'))
   if(side!=='INDEX')assert(html.includes(side==='CE'?'CALL / CE':'PUT / PE'))
  }
  assert(captured.onViewChange);captured.onViewChange('CE');assert.equal(view,'CE')
 }finally{React.useState=oldState;if(prior)require.cache[chartPath]=prior;else delete require.cache[chartPath]}
})
test('the candle card renders current TSL and pattern decisions without indicator score requirements',()=>{
 const Card=require('../src/components/CandleAgentCard.tsx').default,{analyzeCandleAgent}=require('../src/analysis/candleAgent.ts')
 const {fixture,markets}=require('./helpers/confirmation.cjs'),{createPredictionRecord,observePredictionTick}=require('../src/analysis/predictionHistory.ts')
 const now=Date.parse('2026-11-04T14:00:00+05:30'),f=fixture(markets[0],1,'FIVE_MINUTE',now),assessment=analyzeCandleAgent({candles:f.candles,instrument:f.instrument,now})
 let active=observePredictionTick(createPredictionRecord(assessment.plan),assessment.plan.entry,now+1)
 active=observePredictionTick(active,active.entryPrice+2*(active.entryPrice-active.stopLoss),now+1000)
 const html=renderToStaticMarkup(React.createElement(Card,{assessment,active,records:[active],candles:f.candles,tick:{ltp:active.latestPrice,timestamp:now+1000},connected:true,now:now+1000}))
 assert(html.includes('Current TSL'));assert(html.includes('HOLD CALL'));assert(html.includes('ACCEPTED RANGE BREAK'))
 assert(html.includes('no minimum ratio'));assert(!html.includes('1.20:1 required'))
 assert(!html.includes('70%'));assert(!html.includes('RSI'));assert(!html.includes('ADX'))
 const sideways={...assessment,plan:undefined,signal:undefined,state:'SIDEWAYS',reason:'Overlapping candles'}
 const flat=renderToStaticMarkup(React.createElement(Card,{assessment:sideways,records:[],candles:f.candles,connected:true,now}))
 assert(flat.includes('SIDEWAYS'))
})
test('the rendered five-minute chart passes trend lines, zones and swing annotations to the plot',()=>{
 const apexPath=require.resolve('react-apexcharts'),prior=require.cache[apexPath],oldLayout=React.useLayoutEffect
 let plotted
 require.cache[apexPath]={id:apexPath,filename:apexPath,loaded:true,exports:{__esModule:true,default:props=>{plotted=props;return React.createElement('div',null,'Plot')}}}
 React.useLayoutEffect=React.useEffect
 try{
  const Chart=require('../src/components/CandleChart.tsx').default,{fixture,markets}=require('./helpers/confirmation.cjs')
  const now=Date.parse('2026-11-04T14:00:00+05:30'),f=fixture(markets[0],1,'FIVE_MINUTE',now)
  f.candles=f.slots.map((t,i)=>{const v=10+i*.1+[2,1,0,1,2,3][i%6];return f.candle(t,v+.7,v+2,v,v+1,0)})
  const props={candles:f.candles,name:f.instrument,interval:'FIVE_MINUTE',intervalLabel:'5 minutes',savedCandleCount:52,now,isLive:false,marketHeartbeat:'Historical',priceActionOnly:true}
  const html=renderToStaticMarkup(React.createElement(Chart,props))
  assert(html.includes('Automatic chart structure'));assert(html.includes('UPTREND'))
  assert(plotted.height>=420);assert.equal(plotted.options.grid.padding.top,0);assert(plotted.options.grid.padding.bottom<=4)
  assert(html.includes(`height:${plotted.height}px`),'vertical scrollbar must match the taller plot')
  assert(plotted.series.some(s=>s.name.startsWith('Rising support')&&s.data.length>2))
  assert(!plotted.series.some(s=>/EMA|VWAP|Supertrend/.test(s.name)))
  assert(plotted.options.annotations.points.some(p=>p.label.text==='HH'))
  assert(plotted.options.annotations.yaxis.some(z=>z.id?.startsWith('price-zone-')))
  const inView=plotted.series[0].data.filter(p=>p.x>=plotted.options.xaxis.min&&p.x<=plotted.options.xaxis.max)
  const plottedLows=inView.map(p=>p.y[2]),plottedHighs=inView.map(p=>p.y[1])
  assert(plotted.options.yaxis.min<Math.min(...plottedLows));assert(plotted.options.yaxis.max>Math.max(...plottedHighs),'extreme wick labels need headroom')
  const higher=renderToStaticMarkup(React.createElement(Chart,{...props,interval:'FIFTEEN_MINUTE'}))
  assert(higher.includes('Select the 5-minute chart'))
  assert(!plotted.series.some(s=>s.name.startsWith('Rising support')),'five-minute structure is never drawn against another time scale')
  for(const row of markets.slice(0,3)){
   const g=fixture(row,1,'FIVE_MINUTE',now,'ACCEPTED_BREAK',200)
   g.candles=g.slots.map((t,i)=>{const v=i<180?5000:i-180;return g.candle(t,v,v+1,v-.5,v+.8,0)})
   renderToStaticMarkup(React.createElement(Chart,{...props,name:g.instrument,candles:g.candles,spotIndex:true,priceActionOnly:false,
    trade:{entry:g.base+5,stopLoss:g.base-2000,target:g.base+50000}}))
   const view=plotted.series[0].data.filter(p=>p.x>=plotted.options.xaxis.min&&p.x<=plotted.options.xaxis.max)
   const lo=Math.min(...view.map(p=>p.y[2])),hi=Math.max(...view.map(p=>p.y[1])),axis=plotted.options.yaxis
   assert(axis.min<lo&&axis.max>hi,`${g.instrument}: retain every visible wick`)
   assert(axis.max-axis.min<(hi-lo)*1.15,`${g.instrument}: far indicators and trade targets must not flatten candles`)
   assert(plotted.series.some(s=>s.name==='EMA(50)'&&s.data.some(p=>p.y>axis.max)),'indicator series stays available while the plot clips distant values')
   assert.equal(axis.forceNiceScale,false)
   const live=g.base+100
   renderToStaticMarkup(React.createElement(Chart,{...props,name:g.instrument,candles:g.candles,spotIndex:true,isLive:true,tick:{ltp:live}}))
   assert(plotted.options.yaxis.max>live,'a genuine current quote remains part of the price fit')
  }

  const spikeStart=Date.parse('2026-11-05T10:25:00+05:30')
  const spike=Array.from({length:60},(_,i)=>{const o=78650+i*12;return[new Date(spikeStart+i*300000).toISOString(),o,o+45,o-25,o+18,0]})
  spike[57][2]=79630;spike[57][3]=77500
  const focusedHtml=renderToStaticMarkup(React.createElement(Chart,{...props,name:'Sensex',spotIndex:true,candles:spike,now:Date.parse('2026-11-05T15:30:00+05:30')}))
  assert(plotted.options.yaxis.min>78500,'the screenshot-shaped long wick must not flatten the candle bodies')
  assert(plotted.series[0].data.some(p=>p.y[2]===77500),'the original low must remain in the candle series')
  assert(plotted.options.annotations.points.some(p=>p.label.text.includes('77,500')),'mark the exact off-screen wick extreme')
  assert(focusedHtml.includes('Show full wicks'));assert(focusedHtml.includes('Original OHLC is unchanged'))

 }finally{React.useLayoutEffect=oldLayout;if(prior)require.cache[apexPath]=prior;else delete require.cache[apexPath]}
})
