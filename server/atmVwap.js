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
  const complete = candles.length > 0 && Date.parse(candles[0][0]) === start && candles.every((row,i) => i === 0 || Date.parse(row[0]) - Date.parse(candles[i - 1][0]) === minute)
  return { close: last?.[4] ?? null, vwap: volume > 0 ? vwap : null, volume, asOf: last ? new Date(Date.parse(last[0]) + minute).toISOString() : null, coverage: complete ? 'FULL_SESSION' : 'PARTIAL_SESSION' }
}
export function createAtmVwapService({ loadOptions, history, quotes, now = Date.now }) {
  const cache = new Map(), pending = new Map(), sessions = new Map(), historySnapshots = new Map(), historyJobs = new Map()
  return { async get(input, headers) {
    if (!input || !Object.hasOwn(optionIndices,input.index) || typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price <= 0) throw Object.assign(new Error('A supported index and positive index price are required.'),{status:400})
    const time = now()
    // Keep the most recent session visible before open, after close and on weekends.
    // Signal eligibility remains a separate client freshness check.
    let start = Math.floor((time + 330 * minute) / day) * day - 330 * minute + 555 * minute
    if (time < start + minute) start -= day
    while ([0, 6].includes(new Date(start + 330 * minute).getUTCDay())) start -= day
    const end = Math.min(Math.floor(time / minute) * minute, start + 375 * minute)
    const options = (await loadOptions(input.index))[input.index], nominal = Math.round(input.price / optionIndices[input.index].step) * optionIndices[input.index].step
    if (!options || options.expiryAt <= time) throw Object.assign(new Error('Current option expiry unavailable.'),{status:503})
    const strike = nominal
    if (!['ce', 'pe'].every(side => options.contracts.some(c => c.strike === strike && c.side === side))) throw Object.assign(new Error('ATM CE/PE contracts are unavailable.'),{status:503})
    const identity = [headers.Authorization,input.index,strike,options.expiryAt]
    const key = createHash('sha256').update(JSON.stringify([...identity, quotes ? Math.floor(time / 10_000) : end])).digest('hex')
    const pendingKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    if(cache.has(key)) return cache.get(key)
    if(pending.has(pendingKey)) return pending.get(pendingKey)
    if(pending.size>=12) throw Object.assign(new Error('ATM quote requests are busy; retrying shortly.'),{status:429})
    const task=(async()=>{
      const result={index:input.index,strike,expiry:new Date(options.expiryAt).toISOString().slice(0,10),fetchedAt:new Date(time).toISOString(),method:'SESSION_HLC3_VOLUME',referenceIndexPrice:input.price}
      // A broker's session average and cumulative volume need no historical queue.
      // Never reconstruct session VWAP by counting polling heartbeats as trades.
      let live
      if (quotes) {
        try {
          const snapshot = await quotes({ index: input.index, strikes: [strike] }, headers)
          const row = snapshot.index === input.index && snapshot.expiry === result.expiry ? snapshot.rows?.find(row => row.strike === strike) : undefined
          live = row && ['ce', 'pe'].every(side => {
            const contract = options.contracts.find(c => c.strike === strike && c.side === side), leg = row[side]
            return leg?.token === contract.token && leg.symbol === contract.symbol && leg.exchange === contract.exchange
              && Number.isFinite(leg.ltp) && leg.ltp > 0
          }) ? row : undefined
          if (live && ['ce', 'pe'].every(side => Number.isFinite(live[side].averagePrice) && live[side].averagePrice > 0 && Number.isFinite(live[side].volume) && live[side].volume > 0)) {
            result.method = 'BROKER_AVERAGE_PRICE'
            for (const side of ['ce', 'pe']) {
              const contract = options.contracts.find(c => c.strike === strike && c.side === side), leg = live[side]
              result[side] = { symbol: contract.symbol, token: contract.token, exchange: contract.exchange, close: leg.ltp, vwap: leg.averagePrice, volume: leg.volume,
                asOf: leg.asOf ?? null, coverage: 'FULL_SESSION' }
            }
            result.fetchedAt = snapshot.fetchedAt
            cache.set(key, result); while (cache.size > 48) cache.delete(cache.keys().next().value)
            return result
          }
        } catch (error) {
          // Retrying authentication/rate failures through the history queue makes an outage worse.
          if ([401, 403, 429].includes(error.status) || /AG800[123]/i.test(error.errorcode ?? '')) throw error
        }
      }
      const historyKey = createHash('sha256').update(JSON.stringify([...identity, date(start)])).digest('hex')
      const previous = historyJobs.get(historyKey)
      let job = previous
      if (!job?.pending && job?.end !== end && [...historyJobs.values()].filter(job => job.pending).length < 12) {
        job = { end, pending: true }
        historyJobs.set(historyKey, job)
        const currentJob = job
        job.task = (async () => {
          const historical = { ...result }
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
            historical[side]={symbol:contract.symbol,token:contract.token,exchange:contract.exchange,...data}
          }
          historical.fetchedAt = new Date(now()).toISOString()
          historySnapshots.set(historyKey, historical)
          while (historySnapshots.size > 48) historySnapshots.delete(historySnapshots.keys().next().value)
          return historical
        })().catch(error => { currentJob.error = error; throw error }).finally(() => {
          currentJob.pending = false
          // Keep pending work deduplicated while bounding completed jobs.
          for (const [id, entry] of historyJobs) if (historyJobs.size > 48 && !entry.pending) historyJobs.delete(id)
        })
        // Quote heartbeats must not wait on the shared historical queue.
        job.task.catch(() => {})
      }
      if (!quotes) {
        if (job?.pending) return job.task
        if (job?.error) throw job.error
        return historySnapshots.get(historyKey)
      }
      const saved = historySnapshots.get(historyKey)
      const fallback = saved ? { ...saved } : { ...result, message: job?.error?.message || 'Loading option candle VWAP; refreshing live CE/PE quotes.' }
      for (const side of ['ce', 'pe']) {
        const contract = options.contracts.find(c => c.strike === strike && c.side === side)
        fallback[side] = { ...(saved?.[side] ?? { ...contract, close: null, vwap: null, volume: 0, asOf: null, coverage: 'PARTIAL_SESSION' }),
          ...(live ? { close: live[side].ltp, priceAsOf: live[side].asOf ?? null } : {}) }
      }
      cache.set(key, fallback); while (cache.size > 48) cache.delete(cache.keys().next().value)
      return fallback
    })().finally(()=>pending.delete(pendingKey))
    pending.set(pendingKey,task);return task
  } }
}
