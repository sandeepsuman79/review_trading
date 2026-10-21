import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createInstrumentMasterService,fallbackIndices} from '../server/instrumentMaster.js'
const start=Date.parse('2026-10-21T11:00:00+05:30')
const master=()=>[...fallbackIndices,{name:'NIFTY',exch_seg:'NFO',instrumenttype:'OPTIDX',token:'101',symbol:'NIFTY27OCT2622000CE',expiry:'27OCT2026',strike:'2200000'},{name:'NIFTY',exch_seg:'NFO',instrumenttype:'OPTIDX',token:'102',symbol:'NIFTY27OCT2622000PE',expiry:'27OCT2026',strike:'2200000'},{name:'GOLD',exch_seg:'MCX',instrumenttype:'FUTCOM',token:'301',symbol:'GOLD20NOV26FUT',expiry:'20NOV2026',lotsize:'1',tick_size:'100'}]
test('indices, futures and option requests share one master download and use compact cached metadata',async()=>{
 let calls=0,saved
 const service=createInstrumentMasterService({now:()=>start,fetchImpl:async()=>{calls++;await new Promise(r=>setImmediate(r));return Response.json(master())},saveCache:async value=>{saved=value}})
 const [indices,futures,options]=await Promise.all([service.get('indices'),service.get('commodities'),service.getOptions('Nifty 50')])
 assert.equal(calls,1);assert.equal(indices.data.length,3);assert.equal(futures.data[0].name,'GOLD');assert.equal(options['Nifty 50'].contracts.length,2);assert(saved.indices)
 await service.get('indices');assert.equal(calls,1)
})
test('cold upstream failures keep built-in index quotes available and throttle all consumers',async()=>{
 let now=start,calls=0
 const service=createInstrumentMasterService({now:()=>now,fetchImpl:async()=>{calls++;throw new Error('timeout')}})
 const indices=await service.get('indices');assert.equal(indices.status,'FALLBACK');assert.equal(indices.data.length,3)
 for(let i=0;i<10;i++) {await service.get('indices');await assert.rejects(service.get('commodities'));await assert.rejects(service.getOptions('Nifty 50'))}
 assert.equal(calls,1);now+=16000;await service.get('indices');assert.equal(calls,2)
})
test('last-good metadata survives a server restart and refresh failure, while expired options are refused',async()=>{
 let now=start,saved
 const first=createInstrumentMasterService({now:()=>now,fetchImpl:async()=>Response.json(master()),saveCache:async value=>{saved=JSON.parse(JSON.stringify(value))}})
 await first.get('indices');now+=7*3600000
 let calls=0
 const restarted=createInstrumentMasterService({now:()=>now,readCache:async()=>saved,fetchImpl:async()=>{calls++;throw new Error('upstream down')}})
 assert.equal((await restarted.get('indices')).status,'CACHED');assert.equal((await restarted.get('commodities')).data[0].token,'301');assert.equal((await restarted.getOptions('Nifty 50'))['Nifty 50'].contracts.length,2);assert.equal(calls,1)
 now=Date.parse('2026-10-28T11:00:00+05:30');await assert.rejects(restarted.getOptions('Nifty 50'))
})
test('an invalid refresh never replaces a useful cached master and missing contracts cannot trigger a download storm',async()=>{
 let now=start,calls=0,bad=false
 const service=createInstrumentMasterService({now:()=>now,fetchImpl:async()=>{calls++;return Response.json(bad?'<html>bad</html>':master())}})
 await service.get('indices');await assert.rejects(service.getOptions('Sensex'));await assert.rejects(service.getOptions('Sensex'));assert.equal(calls,1)
 now+=7*3600000;bad=true;assert.equal((await service.get('indices')).status,'CACHED');assert.equal(calls,2)
})

test('legacy full-master requests still return the raw list and expired index expiry labels are removed',async()=>{
 let now=start,calls=0
 const service=createInstrumentMasterService({now:()=>now,fetchImpl:async()=>{calls++;return Response.json(master())}})
 assert.deepEqual((await service.get()).data,master());assert.deepEqual((await service.get()).data,master());assert.equal(calls,2)
 now=Date.parse('2026-10-27T16:00:00+05:30')
 const outage=createInstrumentMasterService({now:()=>now,readCache:async()=>({fetchedAt:start,indices:[{...fallbackIndices[0],optionExpiry:'2026-10-27'},...fallbackIndices.slice(1)],commodities:[],options:{}}),fetchImpl:async()=>{throw new Error('offline')}})
 assert.equal((await outage.get('indices')).data[0].optionExpiry,undefined)
})
