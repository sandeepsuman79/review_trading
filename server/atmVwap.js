import { createHash } from 'node:crypto'
import { optionIndices } from './optionPremiums.js'
const minute = 60_000, day = 86_400_000
const date = time => new Date(time + 330 * minute).toISOString().slice(0, 10)
const formatted = time => new Date(time + 330 * minute).toISOString().slice(0, 16).replace('T', ' ')
export function candleVwap(raw, start, end) {
  const rows = (Array.isArray(raw) ? raw : []).filter(row => Array.isArray(row) && row.length >= 6 && Number.isFinite(Date.parse(row[0])) && date(Date.parse(row[0])) === date(start)
    && Date.parse(row[0]) >= start && Date.parse(row[0]) + minute <= end
    && row.slice(1, 6).every(value => typeof value === 'number' && Number.isFinite(value)) && row[5] >= 0 && row[3] > 0 && row[2] >= Math.max(row[1], row[4]) && row[3] <= Math.min(row[1], row[4]))
  const candles = [...new Map(rows.map(row => [Date.parse(row[0]), row])).values()].sort((a,b) => Date.parse(a[0]) - Date.parse(b[0]))
  let volume = 0, vwap = 0
  for (const row of candles) if (row[5] > 0) { const total = volume + row[5]; vwap += ((row[2] / 3 + row[3] / 3 + row[4] / 3) - vwap) * row[5] / total; volume = total }
  const last = candles[candles.length - 1]
  const complete = candles.length > 0 && Date.parse(candles[0][0]) === start && Date.parse(last[0]) + minute === end && candles.every((row,i) => i === 0 || Date.parse(row[0]) - Date.parse(candles[i - 1][0]) === minute)
  return { close: last?.[4] ?? null, vwap: volume > 0 ? vwap : null, volume, asOf: last ? new Date(Date.parse(last[0]) + minute).toISOString() : null, coverage: complete ? 'FULL_SESSION' : 'PARTIAL_SESSION' }
}
export function createAtmVwapService({ loadOptions, history, now = Date.now }) {
  const cache = new Map(), pending = new Map(), sessions = new Map()
  return { async get(input, headers) {
    if (!input || !Object.hasOwn(optionIndices,input.index) || typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price <= 0) throw Object.assign(new Error('A supported index and positive index price are required.'),{status:400})
    const time = now(), end = Math.floor(time / minute) * minute, start = Math.floor((time + 330 * minute) / day) * day - 330 * minute + 555 * minute
    if (end <= start || end > start + 375 * minute || [0,6].includes(new Date(time + 330 * minute).getUTCDay())) throw Object.assign(new Error('ATM option VWAP is available during the regular index session.'),{status:400})
    const options = (await loadOptions())[input.index], nominal = Math.round(input.price / optionIndices[input.index].step) * optionIndices[input.index].step
    if (!options || options.expiryAt <= time) throw Object.assign(new Error('Current option expiry unavailable.'),{status:503})
    const strikes = [...new Set(options.contracts.map(c=>c.strike))].filter(strike=>['ce','pe'].every(side=>options.contracts.some(c=>c.strike===strike&&c.side===side))).sort((a,b)=>Math.abs(a-nominal)-Math.abs(b-nominal)||a-b)
    const strike = strikes[0]
    if (strike === undefined || Math.abs(strike-nominal)>optionIndices[input.index].step) throw Object.assign(new Error('ATM CE/PE contracts are unavailable.'),{status:503})
    const key = createHash('sha256').update(JSON.stringify([headers.Authorization,input.index,strike,options.expiryAt,end])).digest('hex')
    if(cache.has(key)) return cache.get(key)
    if(pending.has(key)) return pending.get(key)
    if(pending.size>=12) throw Object.assign(new Error('ATM VWAP is busy; retry next minute.'),{status:429})
    const task=(async()=>{
      const result={index:input.index,strike,expiry:new Date(options.expiryAt).toISOString().slice(0,10),fetchedAt:new Date(time).toISOString(),method:'SESSION_HLC3_VOLUME',referenceIndexPrice:input.price}
      for(const side of ['ce','pe']){
        const contract=options.contracts.find(c=>c.strike===strike&&c.side===side)
        const sessionKey = createHash('sha256').update(JSON.stringify([headers.Authorization,contract.exchange,contract.token,date(start)])).digest('hex')
        const saved = sessions.get(sessionKey)
        const from = saved?.length ? Math.max(start, Date.parse(saved[saved.length-1][0])) : start
        const response=await history(headers,{exchange:contract.exchange,symboltoken:contract.token,interval:'ONE_MINUTE',fromdate:formatted(from),todate:formatted(end)})
        if(response.status>=400||response.body.status!==true) throw Object.assign(new Error(response.body.message||'Option candle data unavailable.'),{status:response.status>=400?response.status:502,errorcode:response.body.errorcode||response.body.errorCode})
        const incoming = Array.isArray(response.body.data) ? response.body.data : []
        const merged = [...new Map([...(saved || []),...incoming].filter(row=>Array.isArray(row)&&Number.isFinite(Date.parse(row[0]))&&Date.parse(row[0])>=start&&Date.parse(row[0])<end).map(row=>[Date.parse(row[0]),row])).values()].sort((a,b)=>Date.parse(a[0])-Date.parse(b[0]))
        const data = candleVwap(merged,start,end)
        if(data.coverage==='FULL_SESSION'){ sessions.set(sessionKey,merged);while(sessions.size>96)sessions.delete(sessions.keys().next().value) }
        result[side]={symbol:contract.symbol,token:contract.token,exchange:contract.exchange,...data}
      }
      result.fetchedAt=new Date(now()).toISOString()
      if(result.ce.vwap!==null||result.pe.vwap!==null){cache.set(key,result);while(cache.size>48)cache.delete(cache.keys().next().value)}
      return result
    })().finally(()=>pending.delete(key))
    pending.set(key,task);return task
  } }
}
