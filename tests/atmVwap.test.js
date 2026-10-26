import {test} from 'node:test'
import assert from 'node:assert/strict'
import {candleVwap,createAtmVwapService} from '../server/atmVwap.js'
const start=Date.parse('2026-10-16T09:15:00+05:30'),now=start+180000
const bars=()=>[0,1,2].map((i)=>[new Date(start+i*60000).toISOString(),100+i,102+i,99+i,101+i,100*(i+1)])
test('ATM candle VWAP uses traded option volumes and excludes forming, invalid and other-session bars',()=>{
 const data=candleVwap([...bars(),['bad',1,2,1,1,1],[new Date(now).toISOString(),1,1000,1,1000,99999]],start,now)
 assert.equal(data.coverage,'FULL_SESSION');assert.equal(data.volume,600);assert.equal(data.close,103);assert(Math.abs(data.vwap-102)<1e-8)
 assert.equal(candleVwap(bars().slice(1),start,now).coverage,'PARTIAL_SESSION')
 assert.equal(candleVwap(bars().map(c=>[...c.slice(0,5),0]),start,now).vwap,null)
})
test('nearest-expiry ATM CE/PE candles use broker tokens, share concurrent requests, and isolate sessions',async()=>{
 const calls=[],expiryAt=Date.parse('2026-10-20T15:30:00+05:30')
 const service=createAtmVwapService({now:()=>now,loadOptions:async()=>({'Nifty 50':{expiryAt,contracts:['ce','pe'].flatMap((side,i)=>[22000,22050].map(strike=>({side,strike,exchange:'NFO',token:String(strike+i),symbol:`NIFTY-${strike}-${side}`})))}}),history:async(headers,input)=>{calls.push({auth:headers.Authorization,input});return{status:200,body:{status:true,data:bars()}}}})
 const [first,second]=await Promise.all([service.get({index:'Nifty 50',price:22023},{Authorization:'Bearer A'}),service.get({index:'Nifty 50',price:22023},{Authorization:'Bearer A'})])
 assert.deepEqual(first,second);assert.equal(calls.length,2);assert.equal(first.strike,22000);assert.equal(first.ce.token,'22000');assert.equal(first.pe.token,'22001');assert(calls.every(c=>c.input.interval==='ONE_MINUTE'&&c.input.fromdate==='2026-10-16 09:15'))
 await service.get({index:'Nifty 50',price:22023},{Authorization:'Bearer B'});assert.equal(calls.length,4)
 await assert.rejects(service.get({index:'Gold',price:100},{Authorization:'Bearer A'}),e=>e.status===400)
})
test('ATM VWAP preserves broker auth failures and does not fabricate absent expiry contracts',async()=>{
 const service=createAtmVwapService({now:()=>now,loadOptions:async()=>({'Sensex':{expiryAt:now+86400000,contracts:[{side:'ce',strike:74000,token:'1',symbol:'CE',exchange:'BFO'},{side:'pe',strike:74000,token:'2',symbol:'PE',exchange:'BFO'}]}}),history:async()=>({status:401,body:{status:false,errorcode:'AG8001',message:'Session expired'}})})
 await assert.rejects(service.get({index:'Sensex',price:74000},{Authorization:'Bearer A'}),e=>e.status===401&&e.errorcode==='AG8001')
 await assert.rejects(service.get({index:'Sensex',price:75000},{Authorization:'Bearer A'}),/ATM CE\/PE contracts are unavailable/)
})

test('ATM VWAP overlaps only the saved last minute after initial session sync',async()=>{
 let clock=now;const calls=[]
 const contracts=['ce','pe'].map((side,i)=>({side,strike:22000,exchange:'NFO',token:String(i+1),symbol:side}))
 const service=createAtmVwapService({now:()=>clock,loadOptions:async()=>({'Nifty 50':{expiryAt:now+86400000,contracts}}),history:async(_headers,input)=>{calls.push(input);const data=Array.from({length:(clock-start)/60000},(_,i)=>[new Date(start+i*60000).toISOString(),100,102,99,101,100]).filter(row=>Date.parse(row[0])>=Date.parse(input.fromdate.replace(' ','T')+':00+05:30'));return{status:200,body:{status:true,data}}}})
 await service.get({index:'Nifty 50',price:22000},{Authorization:'Bearer A'});clock+=60000
 const snapshot=await service.get({index:'Nifty 50',price:22000},{Authorization:'Bearer A'})
 assert.equal(calls.length,4);assert(calls.slice(2).every(input=>input.fromdate==='2026-10-16 09:17'));assert.equal(snapshot.ce.coverage,'FULL_SESSION');assert.equal(snapshot.ce.volume,400)
})


test('a delayed latest broker minute remains full coverage while internal gaps stay partial', () => {
 const lagged = candleVwap(bars().slice(0, 2), start, now)
 assert.equal(lagged.coverage, 'FULL_SESSION')
 assert.equal(lagged.asOf, new Date(start + 120000).toISOString())
 assert.equal(candleVwap([bars()[0], bars()[2]], start, now).coverage, 'PARTIAL_SESSION')
})

test('all three indices load the latest session before open, after close and over weekends', async () => {
 for (const [index, strike, exchange] of [['Nifty 50',22000,'NFO'],['Sensex',74000,'BFO'],['Bank Nifty',48000,'NFO']]) {
  for (const current of ['2026-10-16T17:00:00+05:30', '2026-10-17T12:00:00+05:30', '2026-10-19T09:15:00+05:30']) {
   const calls = []
   const service = createAtmVwapService({now:()=>Date.parse(current),loadOptions:async()=>({[index]:{expiryAt:Date.parse('2026-10-20T15:30:00+05:30'),contracts:['ce','pe'].map((side,i)=>({side,strike,exchange,token:String(i+1),symbol:side}))}}),history:async(_headers,input)=>{calls.push(input);return {status:200,body:{status:true,data:bars()}}}})
   const result = await service.get({index,price:strike+20},{Authorization:'Bearer A'})
   assert.equal(result.index,index);assert.equal(result.strike,strike)
   assert(result.ce.vwap > 0 && result.pe.vwap > 0)
   assert(calls.every(input=>input.exchange===exchange && input.fromdate==='2026-10-16 09:15' && input.todate==='2026-10-16 15:30'))
  }
 }
})

test('a delayed minute is backfilled on the next incremental request without losing session volume', async () => {
 let clock = now
 const calls = []
 const service = createAtmVwapService({now:()=>clock,loadOptions:async()=>({'Nifty 50':{expiryAt:now+86400000,contracts:['ce','pe'].map((side,i)=>({side,strike:22000,exchange:'NFO',token:String(i),symbol:side}))}}),history:async(_headers,input)=>{calls.push(input);return {status:200,body:{status:true,data:clock===now?bars().slice(0,2):bars()}}}})
 const first = await service.get({index:'Nifty 50',price:22000},{Authorization:'Bearer A'})
 assert.equal(first.ce.coverage,'FULL_SESSION');assert.equal(first.ce.volume,300)
 clock += 60000
 const second = await service.get({index:'Nifty 50',price:22000},{Authorization:'Bearer A'})
 assert.equal(second.ce.volume,600)
 assert(calls.slice(2).every(input=>input.fromdate==='2026-10-16 09:16'))
})

function liveFixture(index, strike, clock, overrides = {}) {
 const exchange = index === 'Sensex' ? 'BFO' : 'NFO'
 const contracts = ['ce','pe'].map((side,i)=>({side,strike,exchange,token:String(strike+i),symbol:`${index}-${strike}-${side}`}))
 const expiryAt = Date.parse('2026-10-20T15:30:00+05:30')
 const snapshot = () => ({index,expiry:'2026-10-20',fetchedAt:new Date(clock()).toISOString(),rows:[{strike,...Object.fromEntries(contracts.map(c=>[c.side,{...c,ltp:c.side==='ce'?110:90,averagePrice:100,volume:600,asOf:new Date(clock()).toISOString(),...overrides}]))}]})
 return {contracts,expiryAt,snapshot}
}
test('all indices use actual FULL quote average and volume, independent of the historical queue', async () => {
 for (const [index,strike,step] of [['Nifty 50',22000,50],['Sensex',74000,100],['Bank Nifty',48000,100]]) {
  let clock = now, calls = 0, historyCalls = 0
  const fixture = liveFixture(index,strike,()=>clock)
  const service = createAtmVwapService({now:()=>clock,loadOptions:async()=>({[index]:fixture}),quotes:async input=>{calls++;assert.deepEqual(input,{index,strikes:[strike]});return fixture.snapshot()},history:async()=>{historyCalls++;throw Error('History queue is blocked')}})
  const first = await service.get({index,price:strike+20},{Authorization:'A'})
  assert.equal(first.method,'BROKER_AVERAGE_PRICE');assert.equal(first.ce.close,110);assert.equal(first.pe.close,90);assert.equal(first.ce.vwap,100)
  for (let i=1;i<=8;i++) {
   clock += 10000
   const next = await service.get({index,price:strike+20},{Authorization:'A'})
   assert.equal(next.ce.volume,600,'heartbeats must never add volume')
   assert.equal(next.ce.asOf,new Date(clock).toISOString())
  }
  assert.equal(calls,9);assert.equal(historyCalls,0)
  await assert.rejects(service.get({index,price:strike+step},{Authorization:'A'}),/ATM CE\/PE contracts are unavailable/)
 }
})
test('pending ATM quotes are shared across many minute boundaries instead of filling the busy queue', async () => {
 let clock=now,calls=0,release
 const fixture=liveFixture('Nifty 50',22000,()=>clock)
 const service=createAtmVwapService({now:()=>clock,loadOptions:async()=>({'Nifty 50':fixture}),quotes:async()=>{calls++;await new Promise(resolve=>{release=resolve});return fixture.snapshot()},history:async()=>{throw Error('Unexpected history')}})
 const requests=[]
 for(let i=0;i<20;i++) {requests.push(service.get({index:'Nifty 50',price:22000},{Authorization:'A'}));await new Promise(resolve=>setImmediate(resolve));clock+=60000}
 assert.equal(calls,1);release()
 const results=await Promise.all(requests)
 assert(results.every(result=>result.method==='BROKER_AVERAGE_PRICE'))
})
test('a blocked candle fallback never blocks later live quotes or creates duplicate historical jobs', async () => {
 let clock=now,historyCalls=0,release,averages=false
 const fixture=liveFixture('Nifty 50',22000,()=>clock)
 const service=createAtmVwapService({now:()=>clock,loadOptions:async()=>({'Nifty 50':fixture}),quotes:async()=>{const data=fixture.snapshot();if(!averages)for(const side of ['ce','pe'])data.rows[0][side].averagePrice=null;return data},history:async()=>{historyCalls++;if(historyCalls===1)await new Promise(resolve=>{release=resolve});return {status:200,body:{status:true,data:bars()}}}})
 const first=await service.get({index:'Nifty 50',price:22000},{Authorization:'A'})
 assert.equal(first.ce.vwap,null);assert.equal(first.ce.close,110)
 for(let i=0;i<15;i++){clock+=10000;await service.get({index:'Nifty 50',price:22000},{Authorization:'A'})}
 assert.equal(historyCalls,1)
 averages=true;clock+=10000
 assert.equal((await service.get({index:'Nifty 50',price:22000},{Authorization:'A'})).method,'BROKER_AVERAGE_PRICE')
 release();await new Promise(resolve=>setImmediate(resolve));assert.equal(historyCalls,2)
})
test('candle fallback is cached by minute while live LTP and its timestamp update every ten seconds', async () => {
 let clock=now,historyCalls=0
 const fixture=liveFixture('Nifty 50',22000,()=>clock,{averagePrice:null})
 const service=createAtmVwapService({now:()=>clock,loadOptions:async()=>({'Nifty 50':fixture}),quotes:async()=>fixture.snapshot(),history:async()=>{historyCalls++;return{status:200,body:{status:true,data:bars()}}}})
 await service.get({index:'Nifty 50',price:22000},{Authorization:'A'});await new Promise(resolve=>setImmediate(resolve))
 clock+=10000
 const data=await service.get({index:'Nifty 50',price:22000},{Authorization:'A'})
 assert.equal(data.ce.vwap,102);assert.equal(data.ce.close,110);assert.equal(data.ce.priceAsOf,new Date(clock).toISOString());assert.equal(data.ce.volume,600)
 clock+=10000;await service.get({index:'Nifty 50',price:22000},{Authorization:'A'});assert.equal(historyCalls,2)
})
test('quote authentication and throttling errors never cascade into the historical queue', async () => {
 const fixture=liveFixture('Nifty 50',22000,()=>now)
 for(const status of [401,403,429]) {
  let historyCalls=0
  const service=createAtmVwapService({now:()=>now,loadOptions:async()=>({'Nifty 50':fixture}),quotes:async()=>{throw Object.assign(Error('broker failure'),{status})},history:async()=>{historyCalls++}})
  await assert.rejects(service.get({index:'Nifty 50',price:22000},{Authorization:'A'}),error=>error.status===status)
  assert.equal(historyCalls,0)
 }
})
