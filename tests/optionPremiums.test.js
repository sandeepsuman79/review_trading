import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOptionPremiumService, nearestIndexOptions, validateOptionRequest } from '../server/optionPremiums.js'
const now = Date.parse('2026-10-14T10:30:00+05:30')
function master() {
  return ['NIFTY','BANKNIFTY','SENSEX'].flatMap((name,i)=>[22000,22100].flatMap((strike,j)=>['CE','PE'].map((side,k)=>({name,exch_seg:name==='SENSEX'?'BFO':'NFO',instrumenttype:'OPTIDX',expiry:'15OCT2026',strike:String(strike*100),symbol:`${name}15OCT26${strike}${side}`,token:String(i*100+j*10+k+1)}))))
}
const headers={Authorization:'Bearer fixture', 'X-PrivateKey':'fixture'}
const response=body=>({ok:true,status:200,json:async()=>body})
function quotes(options, request) {
  const contracts=Object.values(options).flatMap(group=>group.contracts)
  return {status:true,data:{fetched:Object.entries(JSON.parse(request.body).exchangeTokens).flatMap(([exchange,tokens])=>tokens.map(token=>({exchange,symbolToken:token,tradingSymbol:contracts.find(c=>c.exchange===exchange && c.token===token).symbol,ltp:101.25}))),unfetched:[]}}
}

test('instrument master resolves nearest unexpired NFO/BFO index contracts and paise strikes',()=>{
  const rows=master(), option=rows[0]
  rows.push({...option,expiry:'13OCT2026',token:'900'}, {...option,expiry:'22OCT2026',token:'901'}, {...option,instrumenttype:'FUTIDX',token:'902'}, {...option,name:'NIFTYIT',token:'903'}, {...option,expiry:'32OCT2026',token:'904'})
  const result=nearestIndexOptions(rows,now)
  for(const name of ['Nifty 50','Bank Nifty','Sensex']) {
    assert.equal(result[name].contracts.length,4)
    assert.deepEqual([...new Set(result[name].contracts.map(c=>c.strike))],[22000,22100])
    assert(result[name].contracts.every(c=>c.exchange===(name==='Sensex'?'BFO':'NFO')))
  }
  const after=nearestIndexOptions(rows,Date.parse('2026-10-15T15:30:00+05:30'))
  assert.equal(after['Nifty 50'].contracts[0].token,'901');assert.equal(after.Sensex.contracts.length,0)
})

test('request validation keeps exact index steps, unique strikes and the 50-contract limit',()=>{
  assert.deepEqual(validateOptionRequest({index:'Nifty 50',strikes:[22050,22000]}).strikes,[22000,22050])
  for(const input of [{index:'Sensex',strikes:[22050]},{index:'Bank Nifty',strikes:[22050]},{index:'Nifty 50',strikes:[22000,22000]},{index:'Other',strikes:[22000]},{index:'Nifty 50',strikes:[NaN]},{index:'Nifty 50',strikes:Array.from({length:26},(_,i)=>22000+i*50)}]) assert.throws(()=>validateOptionRequest(input),error=>error.status===400)
})

test('batch quotes preserve rupee LTP, expiry and CE/PE matching with scoped cache/inflight deduplication',async()=>{
  const options=nearestIndexOptions(master(),now);let calls=0,time=now
  const service=createOptionPremiumService({loadOptions:async()=>options,now:()=>time,spacing:0,fetcher:async(_url,request)=>{calls++;const body=quotes(options,request);assert.equal(JSON.parse(request.body).mode,'LTP');return response(body)}})
  const input={index:'Nifty 50',strikes:[22000,22100]}
  const [first,second]=await Promise.all([service.get(input,headers),service.get(input,headers)])
  assert.deepEqual(first,second);assert.equal(calls,1);assert.equal(first.expiry,'2026-10-15');assert.equal(first.rows[0].ce.ltp,101.25);assert.equal(first.rows[0].pe.ltp,101.25)
  await service.get(input,headers);assert.equal(calls,1)
  await service.get(input,{...headers,Authorization:'Bearer other-fixture'});assert.equal(calls,2)
  time+=10001;await service.get(input,headers);assert.equal(calls,3)
})

test('wrong exchange/symbol quotes and unfetched legs stay unavailable rather than receiving another premium',async()=>{
  const options=nearestIndexOptions(master(),now), contract=options['Nifty 50'].contracts[0]
  const service=createOptionPremiumService({loadOptions:async()=>options,now:()=>now,spacing:0,fetcher:async()=>response({status:true,data:{fetched:[{exchange:'BFO',symbolToken:contract.token,ltp:999},{exchange:'NFO',symbolToken:contract.token,tradingSymbol:'OTHER',ltp:888}],unfetched:[{exchange:'NFO',symbolToken:'2',message:'No quote'}]}})})
  const result=await service.get({index:'Nifty 50',strikes:[22000,22050]},headers)
  assert.equal(result.rows[0].ce.ltp,null);assert.equal(result.rows[0].pe.ltp,null);assert.equal(result.rows[0].pe.message,'No quote');assert.match(result.rows[1].ce.message,/Contract unavailable/)
})

test('quote requests across indices are sequential and at least one second apart',async()=>{
  const options=nearestIndexOptions(master(),now), times=[];let time=now,active=0
  const service=createOptionPremiumService({loadOptions:async()=>options,now:()=>time,sleep:async ms=>{time+=ms},fetcher:async(_url,request)=>{active++;assert.equal(active,1);times.push(time);active--;return response(quotes(options,request))}})
  await Promise.all([service.get({index:'Nifty 50',strikes:[22000]},headers),service.get({index:'Sensex',strikes:[22000]},headers)])
  assert.equal(times[1]-times[0],1000)
})

test('HTTP-200 broker failures are not cached and rate limits pause subsequent quote requests',async()=>{
  const options=nearestIndexOptions(master(),now);let calls=0,time=now
  const service=createOptionPremiumService({loadOptions:async()=>options,now:()=>time,spacing:0,fetcher:async(_url,request)=>{calls++;return calls===1?response({status:false,message:'Rate limit reached',errorcode:'AB1004',data:null}):response(quotes(options,request))}})
  const input={index:'Nifty 50',strikes:[22000]}
  await assert.rejects(service.get(input,headers),error=>error.status===429)
  await assert.rejects(service.get(input,headers),error=>error.status===429);assert.equal(calls,1)
  time+=15001;assert.equal((await service.get(input,headers)).rows[0].ce.ltp,101.25);assert.equal(calls,2)
})

test('expired or missing contracts never trigger a market quote fetch',async()=>{
  let calls=0
  const service=createOptionPremiumService({loadOptions:async()=>nearestIndexOptions(master(),now+2*86400000),now:()=>now+2*86400000,fetcher:async()=>{calls++;throw Error('Unexpected request')}})
  await assert.rejects(service.get({index:'Sensex',strikes:[22000]},headers),error=>error.status===503)
  assert.equal(calls,0)
})

test('HTTP-200 session errors preserve either error-code spelling, return 401 and never cache failures', async () => {
  for (const [field, code] of [['errorcode','AG8001'], ['errorCode','AG8002'], ['errorCode','AG8003']]) {
    let calls = 0
    const options = nearestIndexOptions(master(), now)
    const service = createOptionPremiumService({ loadOptions: async () => options, now: () => now, spacing: 0, fetcher: async () => { calls++; return response({ success: false, [field]: code, message: 'Authentication rejected' }) } })
    for (let retry = 0; retry < 2; retry++) await assert.rejects(service.get({ index: 'Nifty 50', strikes: [22000] }, headers), error => error.status === 401 && error.errorcode === code)
    assert.equal(calls, 2)
  }
})

test('invalid instrument tokens stay per-contract errors and cannot trigger session refresh', async () => {
  const options = nearestIndexOptions(master(), now), contract = options['Nifty 50'].contracts[0]
  const service = createOptionPremiumService({ loadOptions: async () => options, now: () => now, fetcher: async () => response({ success: true, data: { fetched: [], unfetched: [{ exchange: 'NFO', symbolToken: contract.token, message: 'Invalid symbol token', errorCode: 'AB4018' }] } }) })
  const data = await service.get({ index: 'Nifty 50', strikes: [22000] }, headers)
  assert.equal(data.rows[0].ce.ltp, null); assert.equal(data.rows[0].ce.message, 'Invalid symbol token')
})

test('AB1004 is a broker failure, not a documented rate-limit code', async () => {
  const options = nearestIndexOptions(master(), now)
  const service = createOptionPremiumService({ loadOptions: async () => options, now: () => now, fetcher: async () => response({ status: false, errorcode: 'AB1004', message: 'Something Went Wrong, Please Try After Sometime' }) })
  await assert.rejects(service.get({ index: 'Nifty 50', strikes: [22000] }, headers), error => error.status === 502 && error.errorcode === 'AB1004')
})

test('FULL quotes preserve broker average, cumulative volume and IST trade timestamps without poll-derived volume', async () => {
 const {optionQuoteTime}=await import('../server/optionPremiums.js')
 const options=nearestIndexOptions(master(),now);let calls=0,time=now
 const service=createOptionPremiumService({loadOptions:async()=>options,now:()=>time,spacing:0,fetcher:async(_url,request)=>{
  calls++;const body=quotes(options,request)
  for(const quote of body.data.fetched)Object.assign(quote,{avgPrice:'99.75',tradeVolume:'12345',exchTradeTime:'14-Oct-2026 10:29:58',exchFeedTime:'14-Oct-2026 10:30:00'})
  return response(body)
 }})
 const input={index:'Nifty 50',strikes:[22000]}
 const ltp=await service.get(input,headers)
 assert.equal(ltp.rows[0].ce.averagePrice,undefined)
 const full=await service.get({...input,mode:'FULL'},headers)
 assert.equal(calls,2,'LTP cache must not mask FULL fields')
 assert.equal(full.rows[0].ce.averagePrice,99.75);assert.equal(full.rows[0].ce.volume,12345)
 assert.equal(full.rows[0].ce.asOf,'2026-10-14T04:59:58.000Z')
 time+=10001
 assert.equal((await service.get({...input,mode:'FULL'},headers)).rows[0].ce.volume,12345)
 assert.equal(optionQuoteTime('2026-10-14T10:29:58'),'2026-10-14T04:59:58.000Z')
 assert.equal(optionQuoteTime('2026-10-14T04:59:58Z'),'2026-10-14T04:59:58.000Z')
 assert.equal(optionQuoteTime('invalid'),null);assert.equal(optionQuoteTime(null),null)
})
