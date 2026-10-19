const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (m,f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8').replace(/import\.meta\.env\.VITE_ANGELONE_API_KEY/g,'"fixture"'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f)
const { commoditySpecs, resolveCommodityContracts, mcxSession } = require('../src/analysis/commodities.ts')
const { angelOneExchange } = require('../src/api/angelOneExchange.ts')
const { LiveCandleBook } = require('../src/analysis/liveCandleBook.ts')
const { candleBucketTime } = require('../src/analysis/candleData.ts')
const { historySyncRange, prioritizeHistoryJobs } = require('../src/analysis/historySync.ts')
const { getAngelOneLtp, connectAngelOneStream } = require('../src/api/angelOne.ts')
const at = (time,date='2026-10-15') => Date.parse(`${date}T${time}+05:30`)
const master = () => commoditySpecs.flatMap((spec,i)=>['15OCT2026','20NOV2026'].map((expiry,j)=>({token:String(1000+i*10+j),name:spec.root,symbol:`${spec.root}${expiry}FUT`,exch_seg:'MCX',instrumenttype:'FUTCOM',expiry,lotsize:'100'})))

test('each commodity resolves a standard nearest-expiry MCX future and rolls after its own session close',()=>{
 const rows=master(), contracts=resolveCommodityContracts(rows,at('15:16:00'))
 assert.deepEqual(contracts.map(x=>x.name),['Natural Gas','Crude Oil','Silver','Gold'])
 assert(contracts.every(x=>x.exchange==='MCX' && x.exchangeType===5 && x.expiry==='2026-10-15' && x.lotSize===100))
 assert.equal(resolveCommodityContracts(rows,at('23:29:59'))[0].token,'1000')
 assert.equal(resolveCommodityContracts(rows,at('23:30:00'))[0].token,'1001')
 assert.equal(resolveCommodityContracts(rows,at('23:30:00'))[0].expiry,'2026-11-20')
})

test('options, minis, other exchanges, unsafe tokens and invalid or expired dates cannot become commodity futures',()=>{
 const first=master()[0]
 const invalid=[{...first,instrumenttype:'OPTFUT',symbol:'NATURALGAS20OCT2026300CE'}, {...first,name:'NATGASMINI'}, {...first,exch_seg:'NFO'}, {...first,token:'wrong'}, {...first,expiry:'31FEB2027'}, {...first,expiry:'14OCT2026'}, {...first,symbol:'NATURALGAS-EQ'}]
 assert.deepEqual(resolveCommodityContracts(invalid,at('16:00:00')),[])
 assert.deepEqual(resolveCommodityContracts([],at('16:00:00')),[])
})

test('regular MCX hours include the evening, follow US DST and differ from index square-off',()=>{
 for(const [date,close] of [['2026-03-06','23:55'],['2026-03-09','23:30'],['2026-10-15','23:30'],['2026-11-02','23:55']]){
  const session=mcxSession(at('18:00:00',date));assert.equal(session.closeLabel,close);assert.equal(session.regularSession,true)
  assert.equal(mcxSession(at('08:59:59',date)).regularSession,false)
  assert.equal(mcxSession(at('09:00:00',date)).regularSession,true)
  assert.equal(mcxSession(at(close+':00',date)).regularSession,false)
 }
 assert.equal(mcxSession(at('18:00:00','2026-10-17')).regularSession,false)
})

test('REST exchange routing preserves MCX and existing NSE/BSE segments',()=>{
 for(const [segment,exchange] of [['MCX','MCX'],['mcx_fo','MCX'],['NSE','NSE'],['nse_cm','NSE'],['BSE','BSE'],['bse_cm','BSE'],['NFO','NFO']])assert.equal(angelOneExchange(segment),exchange)
 assert.throws(()=>angelOneExchange('unknown'))
})

test('commodity REST LTP posts MCX and preserves HTTP-200 broker auth errors for shared recovery',async()=>{
 const previous=globalThis.fetch;let body
 try {
  globalThis.fetch=async(_url,request)=>{body=JSON.parse(request.body);return new Response(JSON.stringify({status:true,data:{ltp:'310.25',symboltoken:'1000'}}))}
  const result=await getAngelOneLtp('fixture',{exch_seg:'MCX',token:'1000',symbol:'NATURALGAS15OCT26FUT'})
  assert.equal(result.data.ltp,'310.25');assert.equal(body.exchange,'MCX');assert.equal(body.symboltoken,'1000')
  globalThis.fetch=async()=>new Response(JSON.stringify({status:false,errorCode:'AG8001',message:'Authorization rejected'}))
  await assert.rejects(getAngelOneLtp('fixture',{exch_seg:'MCX',token:'1000',symbol:'NATURALGAS15OCT26FUT'}),error=>error.status===401&&error.errorcode==='AG8001')
 } finally {globalThis.fetch=previous}
})

test('one existing socket subscribes to index LTP and MCX quotes and decodes MCX prices/volume',()=>{
 const previous={window:globalThis.window,localStorage:globalThis.localStorage,WebSocket:globalThis.WebSocket},messages=[],ticks=[];let cleared=false
 try {
  globalThis.window={setInterval:()=>1,clearInterval:()=>{cleared=true}}
  globalThis.localStorage={getItem:()=> 'fixture'}
  globalThis.WebSocket=class{static OPEN=1;readyState=1;send(value){messages.push(JSON.parse(value))}}
  const socket=connectAngelOneStream(tick=>ticks.push(tick),()=>{},[{mode:1,tokenList:[{exchangeType:1,tokens:['99926000']}]},{mode:2,tokenList:[{exchangeType:5,tokens:['1000']}]}])
  socket.onopen();assert.equal(messages.length,2);assert.deepEqual(messages[1].params,{mode:2,tokenList:[{exchangeType:5,tokens:['1000']}]})
  const packet=new ArrayBuffer(123),view=new DataView(packet)
  view.setUint8(0,2);view.setUint8(1,5);new Uint8Array(packet,2,25).set(new TextEncoder().encode('1000'))
  view.setBigInt64(27,1n,true);view.setBigInt64(35,BigInt(at('18:00:00')),true);view.setBigInt64(43,31025n,true);view.setBigInt64(67,12345n,true)
  socket.onmessage({data:packet});assert.equal(ticks[0].ltp,310.25);assert.equal(ticks[0].volume,12345);assert.equal(ticks[0].exchangeType,5)
  socket.onclose();assert(cleared)
 } finally {for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value}}
})

test('MCX hourly bars start at 09:00 IST and align with historical data, while indices retain 09:15',()=>{
 const now=at('09:12:00')
 assert.equal(candleBucketTime(now,'ONE_HOUR',540),at('09:00:00'))
 assert.equal(candleBucketTime(at('09:20:00'),'ONE_HOUR'),at('09:15:00'))
 const book=new LiveCandleBook(()=>[],()=>540)
 for(const [timestamp,ltp] of [[now,300],[at('09:59:59'),310],[at('10:00:00'),305]])book.accept({token:'1000',exchangeType:5,mode:1,timestamp,ltp},timestamp)
 assert.deepEqual(book.get('1000','ONE_HOUR').map(c=>[c[0],...c.slice(1,5)]),[[new Date(at('09:00:00')).toISOString(),300,310,300,310],[new Date(at('10:00:00')).toISOString(),305,305,305,305]])
})

test('commodity live volume counts only observed within-bar deltas, not the session cumulative total',()=>{
 const book=new LiveCandleBook(()=>[],()=>540,()=>true)
 const accept=(time,volume,ltp=300)=>book.accept({token:'1000',exchangeType:5,mode:2,timestamp:at(time),ltp,volume},at(time))
 accept('18:00:01',10000);assert.equal(book.get('1000','FIVE_MINUTE')[0][5],0)
 accept('18:00:02',10005);accept('18:00:03',10008,310)
 assert.equal(book.get('1000','FIVE_MINUTE')[0][5],8)
 assert.deepEqual(book.get('1000','FIVE_MINUTE')[0].slice(1,5),[300,310,300,310])
 accept('18:05:01',10020);assert.equal(book.get('1000','FIVE_MINUTE')[1][5],0,'unknown cross-boundary volume is not assigned to a candle')
 accept('18:05:02',10023);assert.equal(book.get('1000','FIVE_MINUTE')[1][5],3)
 accept('18:05:40',11000);assert.equal(book.get('1000','FIVE_MINUTE')[1][5],3,'reconnect gaps cannot fabricate volume')
 accept('18:05:41',100);assert.equal(book.get('1000','FIVE_MINUTE')[1][5],3,'counter resets do not subtract volume')
})

test('commodity history backfills from 09:00 and prioritizes the default or explicitly selected chart',()=>{
 const candles=Array.from({length:60},(_,i)=>[new Date(at('12:00:00')+i*300000).toISOString(),300,301,299,300,100])
 assert.equal(historySyncRange(candles,'FIVE_MINUTE',at('18:00:00'),540).from,at('09:00:00'))
 const jobs=['FIVE_MINUTE','FIFTEEN_MINUTE','ONE_HOUR'].flatMap(interval=>['nifty','gas'].map(token=>({token,interval})))
 assert.deepEqual(prioritizeHistoryJobs(jobs,'gas','ONE_HOUR',false)[0],{token:'gas',interval:'ONE_HOUR'})
 assert.deepEqual(prioritizeHistoryJobs(jobs,'nifty','ONE_HOUR')[0],{token:'nifty',interval:'FIVE_MINUTE'})
})

test('server commodity scope exposes only the four standard futures and keeps their broker metadata',async()=>{
 const { commodityInstruments } = await import('../server/commodityInstruments.js')
 const rows=master(), filtered=commodityInstruments([...rows,{...rows[0],instrumenttype:'OPTFUT'}, {...rows[0],name:'GOLDM'}, {...rows[0],exch_seg:'NSE'}])
 assert.equal(filtered.length,8);assert(filtered.every(x=>x.exch_seg==='MCX' && x.instrumenttype==='FUTCOM'))
 assert.equal(filtered[0].token,rows[0].token);assert.equal(filtered[0].expiry,rows[0].expiry)
})
