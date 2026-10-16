import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMarketContextService, contextForAi, commoditySources, supportsMarket } from '../server/marketContext.js'
import { createAiNewsService, headlineCacheKey } from '../server/aiNews.js'
const now=Date.parse('2026-10-15T12:30:00Z')
const article={id:'oil',title:'Crude oil supply disruptions push prices higher',url:'https://news.example/oil',category:'global',publishedAt:new Date(now-60000).toISOString(),publisher:'Fixture',matchedCompanies:[]}
const rss=title=>`<rss version="2.0"><channel><title>Fixture</title><item><title>${title}</title><link>https://news.example/${encodeURIComponent(title)}</link><pubDate>${new Date(now-60000).toUTCString()}</pubDate><source>Fixture</source></item></channel></rss>`
test('commodity market context loads scoped news and relevant benchmarks without equity FII/OI/membership calls',async()=>{
 const urls=[]
 const service=createMarketContextService({now:()=>now,fetchFn:async url=>{
  urls.push(url)
  if(url.includes('finance.yahoo.com')){const symbol=decodeURIComponent(new URL(url).pathname.split('/').at(-1));return new Response(JSON.stringify({chart:{result:[{meta:{symbol,regularMarketPrice:100,regularMarketChangePercent:1,regularMarketTime:now/1000}}]}}))}
  assert.equal(new URL(url).hostname,'news.google.com');return new Response(rss(new URL(url).searchParams.get('q')))
 }})
 for(const instrument of Object.keys(commoditySources)){
  const result=await service.getContext(instrument)
  assert(supportsMarket(instrument));assert.equal(result.marketType,'COMMODITY');assert.equal(result.feeds.length,2);assert.equal(result.articles.length,2)
  assert.equal(result.constituents.companies.length,0);assert.equal(result.inputs.institutional.data,null);assert.equal(result.inputs.openInterest.data,null)
  assert.equal(result.inputs.global.length,4);assert.equal(result.inputs.global[0].data.symbol,commoditySources[instrument].benchmarks[0].symbol)
  assert(contextForAi(result).limitations.some(x=>x.includes('not Indian equities')))
  const count=urls.length;await service.getContext(instrument);assert.equal(urls.length,count,'cached feeds and benchmarks must not refetch')
 }
 assert(!urls.some(url=>/option-chain|fiidii|IndexConstituent|ind_nifty|marketStatus/.test(url)))
})
test('commodity and equity headline assessments cannot share sentiment cache entries',()=>{
 assert.notEqual(headlineCacheKey(article,'Crude Oil'),headlineCacheKey(article,'Nifty 50'))
 assert.notEqual(headlineCacheKey(article,'Crude Oil'),headlineCacheKey(article,'Gold'))
 assert.equal(headlineCacheKey(article,'Nifty 50'),headlineCacheKey(article,'Sensex'))
})
test('optional AI news request scopes commodity impact and retains technical independence during quota errors',async()=>{
 let request
 const service=createAiNewsService({now:()=>now,cache:{entries:new Map(),save:async()=>{}},gemini:{status:()=>({state:'AVAILABLE'}),generate:async input=>{request=input;throw new Error('quota')}}})
 const context={instrument:'Crude Oil',marketType:'COMMODITY',revision:'mcx',retrievedAt:new Date(now).toISOString(),articles:[article],feeds:[{category:'global',status:'AVAILABLE',items:[article]}],constituents:{status:'UNAVAILABLE'}}
 const result=await service.getNews(context)
 assert.match(request.systemInstruction.parts[0].text,/Crude Oil MCX futures/)
 assert.equal(JSON.parse(request.contents[0].parts[0].text).articles[0].scope,'MCX_FUTURES:Crude Oil')
 assert.equal(result.marketOutlook.bias,'UNAVAILABLE');assert.equal(result.marketOutlook.assessmentStatus.assessed,0)
})

test('minute context refresh updates volatile quotes while sharing cached news publications',async()=>{
 let clock=now;const calls=[]
 const service=createMarketContextService({now:()=>clock,fetchFn:async url=>{
  calls.push(url)
  if(url.includes('finance.yahoo.com')){const symbol=decodeURIComponent(new URL(url).pathname.split('/').at(-1));return new Response(JSON.stringify({chart:{result:[{meta:{symbol,regularMarketPrice:100+(clock-now)/60000,regularMarketChangePercent:1,regularMarketTime:clock/1000}}]}}))}
  return new Response(rss(new URL(url).searchParams.get('q')))
 }})
 const first=await service.getContext('Gold'),newsCalls=calls.filter(url=>url.includes('news.google.com')).length
 const count=calls.length;clock+=59000;await service.getContext('Gold');assert.equal(calls.length,count)
 clock+=2000;const updated=await service.getContext('Gold')
 assert.equal(calls.filter(url=>url.includes('news.google.com')).length,newsCalls)
 assert.equal(calls.length,count+4);assert(updated.inputs.global[0].data.price>first.inputs.global[0].data.price)
 assert.notEqual(updated.revision,first.revision);assert.equal(updated.inputs.global[0].fetchedAt,new Date(clock).toISOString())
})
