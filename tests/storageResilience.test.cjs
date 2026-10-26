const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f)
const {createPredictionHistoryStore}=require('../src/storage/predictionHistoryStore.ts')
const {predictionHistoryKey,readPredictionHistory}=require('../src/analysis/predictionHistory.ts')
const {writeChartCache}=require('../src/storage/chartCache.ts')
const start=Date.parse('2026-10-21T10:00:00+05:30')
function trade(id='saved') {return{id,instrument:'Nifty 50',interval:'FIVE_MINUTE',side:'CALL',stage:'CONFIRMED',strategyVersion:'technical-v2',signalCandleTime:new Date(start-300000).toISOString(),generatedAt:start,expiresAt:start+300000,entry:100,stopLoss:90,target:120,riskReward:2,targetBasis:'Fixture',reason:'Fixture',contextMode:'TECHNICAL_ONLY',bullishScore:60,bearishScore:20,technicalEvidence:[],newsSummary:'',newsEvidence:[],coverage:[],status:'ACTIVE',entryAt:start,entryPrice:100,entrySource:'LIVE',observedThrough:start+1000,outcomeNote:'Entry observed'}}
const encode=records=>JSON.stringify({version:1,records})
function storage(initial=[],limit=Infinity) {
 const values=new Map(initial);let writes=0
 return {get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>{writes++;const size=[...values].reduce((n,[k,v])=>n+(k===key?0:v.length),value.length);if(size>limit)throw new DOMException('Storage full','QuotaExceededError');values.set(key,value)},removeItem:key=>values.delete(key),values,get writes(){return writes}}
}
function backend(raw) {
 let value=raw,tail=Promise.resolve(),fail=false,calls=0
 return {get value(){return value},set fail(v){fail=v},get calls(){return calls},read:async()=>{if(fail)throw new Error('Disk unavailable');return value},transact:update=>{const task=tail.then(()=>{calls++;if(fail)throw new Error('Disk unavailable');const next=update(value);value=next;return next});tail=task.catch(()=>{});return task}}
}
test('full localStorage ledger migrates losslessly before its legacy key is removed',async()=>{
 const old=[trade()],local=storage([[predictionHistoryKey,encode(old)],['angelone_jwt_token','secret']],1),db=backend()
 const store=createPredictionHistoryStore({backend:db,storage:local})
 assert.deepEqual(await store.load(),old)
 assert.equal(local.getItem(predictionHistoryKey),null);assert.equal(local.getItem('angelone_jwt_token'),'secret')
 const result=await store.update(records=>records.map(r=>({...r,latestPrice:105,observedThrough:start+2000})))
 assert(result.durable);assert.equal(result.records[0].latestPrice,105);assert.equal(local.writes,0)
 assert.equal(JSON.parse(db.value).records.length,1)
})
test('disk failures keep live updates in memory without losing the last saved ledger or retrying on every quote',async()=>{
 let now=0;const local=storage([[predictionHistoryKey,encode([trade()])]],1),db=backend();db.fail=true
 const store=createPredictionHistoryStore({backend:db,storage:local,now:()=>now})
 await store.load();const original=local.getItem(predictionHistoryKey)
 const first=await store.update(records=>records.map(r=>({...r,observedThrough:start+2000,latestPrice:105})))
 assert.equal(first.durable,false);assert.match(first.error,/download a backup/);assert.equal(local.getItem(predictionHistoryKey),original)
 const calls=db.calls,writes=local.writes
 const second=await store.update(records=>records.map(r=>({...r,observedThrough:start+3000,latestPrice:106})))
 assert.equal(second.records[0].latestPrice,106);assert.equal(db.calls,calls);assert.equal(local.writes,writes)
 now=16000;db.fail=false
 const recovered=await store.update(records=>records)
 assert(recovered.durable);assert.equal(JSON.parse(db.value).records[0].latestPrice,106)
 assert.deepEqual((await store.load())[0],recovered.records[0]);assert.equal(local.getItem(predictionHistoryKey),null)
})
test('a successful local fallback cannot roll back newer updates or reopen a settled trade on reload',async()=>{
 let now=0;const local=storage([[predictionHistoryKey,encode([trade()])]]),db=backend();db.fail=true
 const store=createPredictionHistoryStore({backend:db,storage:local,now:()=>now});await store.load()
 const result=await store.update(records=>records.map(r=>({...r,status:'TARGET_HIT',exitAt:start+60000,exitPrice:120,points:20,observedThrough:start+60000})))
 assert(result.durable);assert.equal(result.records[0].status,'TARGET_HIT')
 db.fail=false;now=16000
 const reload=createPredictionHistoryStore({backend:db,storage:local,now:()=>now})
 assert.equal((await reload.load())[0].status,'TARGET_HIT')
 const stale=storage([[predictionHistoryKey,encode([trade()])]])
 const reopened=createPredictionHistoryStore({backend:db,storage:stale})
 assert.equal((await reopened.load())[0].status,'TARGET_HIT')
})
test('concurrent writers update one durable ledger atomically and invalid saved data is never replaced',async()=>{
 const db=backend(encode([trade()])),local=storage(),a=createPredictionHistoryStore({backend:db,storage:local}),b=createPredictionHistoryStore({backend:db,storage:local})
 await Promise.all([a.load(),b.load()])
 await Promise.all([a.update(records=>[...records,trade('second')]),b.update(records=>[...records,trade('third')])])
 assert.deepEqual(JSON.parse(db.value).records.map(r=>r.id).sort(),['saved','second','third'])
 const broken=backend('invalid json'),preserved=storage([[predictionHistoryKey,encode([trade()])]])
 await assert.rejects(createPredictionHistoryStore({backend:broken,storage:preserved}).load(),/preserved/)
 assert.equal(broken.value,'invalid json');assert(preserved.getItem(predictionHistoryKey))
})
test('bounded chart caches evict only refetchable candles and preserve the full in-memory history',()=>{
 const local=storage([['angelone_jwt_token','keep'],[predictionHistoryKey,encode([trade()])],['angelone_chart_v1_other_FIVE_MINUTE','x'.repeat(2000)]],3000)
 const candles=Array.from({length:2000},(_,i)=>[new Date(start+i*300000).toISOString(),100,102,99,101,100])
 const result=writeChartCache(local,'angelone_chart_v1_selected_FIVE_MINUTE',candles,'selected')
 assert.equal(result,false);assert.equal(local.getItem('angelone_jwt_token'),'keep');assert.equal(readPredictionHistory(local)[0].id,'saved');assert.equal(candles.length,2000)
 const enough=storage();assert(writeChartCache(enough,'angelone_chart_v1_selected_FIVE_MINUTE',candles,'selected'));assert(JSON.parse(enough.getItem('angelone_chart_v1_selected_FIVE_MINUTE')).length<=1200)
})

test('a storage outage cannot turn an observed stop into a later winning trade',async()=>{
 const {syncPredictionRecord}=require('../src/analysis/predictionHistory.ts')
 let clock=0;const local=storage([[predictionHistoryKey,encode([trade()])]],1),db=backend();db.fail=true
 const store=createPredictionHistoryStore({backend:db,storage:local,now:()=>clock});await store.load()
 const stop=await store.update(records=>records.map(r=>syncPredictionRecord(r,[],{timestamp:start+2000,ltp:89},start+2000)))
 assert.equal(stop.records[0].status,'STOP_LOSS_HIT');assert.equal(stop.records[0].points,-11);assert.equal(stop.durable,false)
 const rebound=await store.update(records=>records.map(r=>syncPredictionRecord(r,[],{timestamp:start+3000,ltp:130},start+3000)))
 assert.equal(rebound.records[0].status,'STOP_LOSS_HIT');assert.equal(rebound.records[0].points,-11)
 clock=16000;db.fail=false;await store.update(records=>records)
 assert.equal(JSON.parse(db.value).records[0].status,'STOP_LOSS_HIT')
})

test('recovery keeps an earlier observed stop over a later rebound outcome from a different tab',async()=>{
 const stop={...trade(),status:'STOP_LOSS_HIT',exitAt:start+60000,exitPrice:90,points:-10,observedThrough:start+60000}
 const rebound={...trade(),status:'TARGET_HIT',exitAt:start+120000,exitPrice:120,points:20,observedThrough:start+120000}
 const db=backend(encode([stop])),local=storage([[predictionHistoryKey,encode([rebound])]])
 const recovered=await createPredictionHistoryStore({backend:db,storage:local}).load()
 assert.equal(recovered[0].status,'STOP_LOSS_HIT');assert.equal(recovered[0].exitAt,start+60000)
})

test('a recorded TSL or stop exit wins over newer uncertainty snapshots in either storage direction',async()=>{
 for(const status of ['EARLY_EXIT','STOP_LOSS_HIT'])for(const uncertainStatus of ['UNVERIFIED','AMBIGUOUS','ACTIVE'])for(const closedInDatabase of [true,false]){
  const closed={...trade(),status,earlyExitSource:status==='EARLY_EXIT'?'AGENT_PROTECTION':undefined,exitAt:start+60000,exitPrice:status==='EARLY_EXIT'?125:89,points:status==='EARLY_EXIT'?25:-11,observedThrough:start+60000}
  const uncertain={...trade(),status:uncertainStatus,observedThrough:start+120000,latestPriceAt:start+120000}
  const db=backend(encode([closedInDatabase?closed:uncertain])),local=storage([[predictionHistoryKey,encode([closedInDatabase?uncertain:closed])]])
  const store=createPredictionHistoryStore({backend:db,storage:local})
  assert.deepEqual((await store.load())[0],JSON.parse(JSON.stringify(closed)))
  const reload=createPredictionHistoryStore({backend:db,storage:local})
  assert.deepEqual((await reload.load())[0],JSON.parse(JSON.stringify(closed)))
 }
})

test('critical exit is checkpointed before the database commits and survives an abrupt tab close',async()=>{
 const {predictionCheckpointKey}=require('../src/storage/predictionHistoryStore.ts')
 const local=storage(),initial=encode([trade()]);let value=initial,hold=false,release,callbackDone
 const called=new Promise(resolve=>{callbackDone=resolve})
 const db={read:async()=>value,transact:async update=>{const next=update(value);if(hold){callbackDone();await new Promise(resolve=>{release=resolve})}value=next;return value}}
 const store=createPredictionHistoryStore({backend:db,storage:local});await store.load();hold=true
 const pending=store.update(records=>records.map(r=>({...r,status:'EARLY_EXIT',earlyExitSource:'AGENT_PROTECTION',exitAt:start+60000,exitPrice:125,points:25,observedThrough:start+60000})))
 await called
 assert.equal(JSON.parse(local.getItem(predictionCheckpointKey)).records[0].status,'EARLY_EXIT')
 assert.equal(JSON.parse(value).records[0].status,'ACTIVE','database is still on the old snapshot')
 const recoveredBackend=backend(value),reopened=createPredictionHistoryStore({backend:recoveredBackend,storage:local})
 const restored=(await reopened.load())[0]
 assert.equal(restored.status,'EARLY_EXIT');assert.equal(restored.exitPrice,125);assert.equal(restored.points,25)
 assert.equal(local.getItem(predictionCheckpointKey),null,'checkpoint clears only after a successful recovery commit')
 hold=false;release();await pending
})

test('critical entry and TSL checkpoints persist through database unavailability on reload',async()=>{
 const {predictionCheckpointKey}=require('../src/storage/predictionHistoryStore.ts')
 const record={...trade(),protection:{version:1,peakPrice:140,peakAt:start+30000,stop:125,armed:true,atr:10,risk:10},observedThrough:start+30000}
 const local=storage([[predictionCheckpointKey,encode([record])]]),db=backend();db.fail=true
 const store=createPredictionHistoryStore({backend:db,storage:local})
 assert.deepEqual((await store.load())[0],record)
 assert.equal(store.checkpoint(),true)
 const fresh=createPredictionHistoryStore({backend:db,storage:local})
 assert.equal((await fresh.load())[0].protection.stop,125)
})

test('a valid empty local ledger can persist new trades when IndexedDB is unavailable',async()=>{
 const local=storage([[predictionHistoryKey,encode([])]]),db=backend();db.fail=true
 const store=createPredictionHistoryStore({backend:db,storage:local})
 assert.deepEqual(await store.load(),[])
 const result=await store.update(()=>[trade()]);assert(result.durable)
 const reopened=createPredictionHistoryStore({backend:db,storage:local})
 assert.equal((await reopened.load())[0].entryPrice,100)
})

test('an unreadable database without any backup cannot be replaced by a new empty ledger',async()=>{
 const local=storage(),db=backend(encode([trade()]));db.fail=true
 await assert.rejects(createPredictionHistoryStore({backend:db,storage:local}).load(),/Disk unavailable/)
 assert.equal(local.getItem(predictionHistoryKey),null)
})

test('corrupt checkpoint data is preserved and cannot overwrite the trade ledger',async()=>{
 const {predictionCheckpointKey}=require('../src/storage/predictionHistoryStore.ts')
 const local=storage([[predictionCheckpointKey,'invalid JSON']]),db=backend(encode([trade()]))
 await assert.rejects(createPredictionHistoryStore({backend:db,storage:local}).load(),/preserved/)
 assert.equal(local.getItem(predictionCheckpointKey),'invalid JSON');assert.equal(JSON.parse(db.value).records[0].entryPrice,100)
})

test('a newer protection checkpoint is not deleted when an older database transaction completes',async()=>{
 const {predictionCheckpointKey}=require('../src/storage/predictionHistoryStore.ts')
 const local=storage();let value=encode([trade()]),hold=false,release,callbackDone
 const called=new Promise(resolve=>{callbackDone=resolve})
 const db={read:async()=>value,transact:async update=>{const next=update(value);if(hold){callbackDone();await new Promise(resolve=>{release=resolve})}value=next;return value}}
 const store=createPredictionHistoryStore({backend:db,storage:local});await store.load();hold=true
 const pending=store.update(records=>records.map(r=>({...r,observedThrough:start+2000,protection:{version:1,peakPrice:115,peakAt:start+2000,stop:100,armed:true,atr:10,risk:10}})))
 await called
 const newer={...JSON.parse(local.getItem(predictionCheckpointKey)).records[0],observedThrough:start+3000,protection:{version:1,peakPrice:140,peakAt:start+3000,stop:125,armed:true,atr:10,risk:10}}
 local.setItem(predictionCheckpointKey,encode([newer]))
 hold=false;release();await pending
 assert.equal(JSON.parse(local.getItem(predictionCheckpointKey)).records[0].protection.stop,125)
 const reopened=createPredictionHistoryStore({backend:backend(value),storage:local})
 assert.equal((await reopened.load())[0].protection.stop,125)
})
