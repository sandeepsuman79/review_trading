const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
for(const ext of ['.ts','.tsx']) require.extensions[ext]=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f)
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),Panel=require('../src/components/MultiTimeframePanel.tsx').default
const {scoreTrajectory}=require('../src/analysis/scoreTrajectory.ts')
const now=Date.parse('2026-10-20T12:15:00+05:30')
test('each timeframe renders its own scores and trajectory inside the collapsible scrolling panel',()=>{
 const intervals=['FIVE_MINUTE','FIFTEEN_MINUTE','ONE_HOUR'],durations=[300000,900000,3600000]
 const changes=[[-5,5],[4,-4],[0,0]]
 const trajectories=Object.fromEntries(intervals.map((interval,i)=>[interval,scoreTrajectory([0,1,2].map(j=>({at:now-(2-j)*durations[i],bullish:50+j*changes[i][0],bearish:20+j*changes[i][1]})),durations[i])]))
 for(let i=0;i<3;i++) trajectories[intervals[i]].indicators=[{name:'EMA20',value:100+i,previous:99+i,change:1,low:99+i,high:100+i,movement:'RISING',risk:false},{name:'Supertrend',value:95+i,previous:94+i,change:1,low:94+i,high:95+i,movement:'RISING',risk:false,direction:'UP'}]
 const assessment={instrument:'Bank Nifty',reviews:intervals.map((interval,i)=>({interval,current:true,reviewedAt:now,status:'WAIT',evidence:{bias:'NEUTRAL',bullishScore:40+i,bearishScore:30+i,coverage:85},analysis:{setup:'No confirmed setup'},reason:'Waiting',closedAt:now})),conflicts:false}
 const html=renderToStaticMarkup(React.createElement(Panel,{assessment,trajectories,now}))
 assert(html.startsWith('<details open=""'));assert(html.includes('Scroll timeframe assessments horizontally'))
 const articles=[...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(m=>m[1])
 assert.equal(articles.length,3)
 for(let i=0;i<3;i++){assert(articles[i].includes(`Bullish ${40+i}/100`));assert(articles[i].includes(`Bearish ${30+i}/100`));assert(articles[i].includes('timeframe-trajectory'));assert(articles[i].includes(`${100+i}.00`));assert(articles[i].includes('EMA 20'));assert(articles[i].includes('Supertrend'));assert(articles[i].includes('vs previous candle'))}
 assert(articles[0].includes('↓ Bearish pressure'));assert(articles[0].includes('-10.0'));assert(!articles[0].includes('+8.0'))
 assert(articles[1].includes('↑ Bullish pressure'));assert(articles[1].includes('+8.0'));assert(!articles[1].includes('-10.0'))
 assert(articles[2].includes('↔ Mixed'));assert(articles[2].includes('+0.0'))
 assert(!html.includes('ATM OPTION VWAP'))
})
