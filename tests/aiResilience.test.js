import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGeminiClient } from '../server/geminiClient.js'
import { createAiCache } from '../server/aiCache.js'
import { createAiNewsService } from '../server/aiNews.js'

const clock = Date.parse('2026-10-14T05:00:00Z')
const article = (id = 'shared', category = 'india') => ({ id, category, title: 'RBI reviews policy outlook', description: 'Fixture headline description', url: `https://publisher.example/${id}`, publisher: 'Fixture', publishedAt: new Date(clock - 1000).toISOString(), matchedCompanies: category === 'companies' ? ['Fixture Bank'] : [] })
const context = (instrument = 'Nifty 50', articles = [article()], revision = 'r1') => ({ instrument, articles, revision, retrievedAt: new Date(clock).toISOString(), feeds: ['india', 'companies', 'global', 'globalCompanies'].map(category => ({ category, status: 'AVAILABLE' })), constituents: { status: 'AVAILABLE' } })
const success = value => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] }))
const fakeNews = (_, request) => {
  const input = JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)
  return Promise.resolve(success({ articleSentiments: input.articles.map(item => ({ articleId: item.id, sentiment: 'POSITIVE', impactScore: 1, reason: 'Fixture potential impact' })) }))
}
const create = (fetchImpl = fakeNews, options = {}) => {
  const cache = options.cache || createAiCache(), gemini = createGeminiClient({ apiKey: 'fixture', model: 'fixture-model', fetchImpl, now: () => clock, sleep: async () => {}, random: () => 0, ...options })
  return { cache, gemini, news: createAiNewsService({ gemini, cache, now: () => clock, localClassify: options.localClassify }) }
}

test('concurrent three-index news requests assess a common headline only once', async () => {
  let calls = 0
  const { news } = create(async (...args) => { calls++; await new Promise(resolve => setTimeout(resolve, 15)); return fakeNews(...args) })
  const results = await Promise.all(['Nifty 50', 'Sensex', 'Bank Nifty'].map(name => news.getNews(context(name))))
  assert.equal(calls, 1)
  for (const result of results) { assert.equal(result.marketOutlook.articleSentiments[0].impactScore, 1); assert.equal(result.marketOutlook.articleSentiments[0].source, 'GEMINI') }
})

test('macro/candle-independent revisions reuse ratings and new headlines assess only the addition', async () => {
  const sent = [], { news } = create((url, request) => { sent.push(JSON.parse(JSON.parse(request.body).contents[0].parts[0].text).articles.map(item => item.id)); return fakeNews(url, request) })
  await news.getNews(context())
  const rebound = await news.getNews(context('Nifty 50', [article()], 'changed-global-quote'))
  assert.equal(rebound.marketOutlook.contextRevision, 'changed-global-quote')
  await news.getNews(context('Nifty 50', [article(), article('added')], 'new-news'))
  assert.deepEqual(sent, [['shared'], ['added']])
})

test('company assessments stay index-specific and corrected headlines invalidate the cache', async () => {
  let calls = 0
  const { news } = create((...args) => { calls++; return fakeNews(...args) })
  const company = article('company', 'companies')
  await news.getNews(context('Nifty 50', [company])); await news.getNews(context('Sensex', [company]))
  assert.equal(calls, 2)
  await news.getNews(context('Nifty 50', [{ ...company, title: 'Corrected announcement' }]))
  assert.equal(calls, 3)
})

test('quota failure opens one shared circuit and retains local text-only assessments without market votes', async () => {
  let calls = 0, local = 0
  const { news, gemini } = create(async () => { calls++; return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 }) }, {
    localClassify: async articles => { local++; return articles.map(item => ({ articleId: item.id, sentiment: 'POSITIVE', impactScore: 2, reason: 'Fixture local text' })) },
  })
  const results = await Promise.all(['Nifty 50', 'Sensex', 'Bank Nifty'].map(name => news.getNews(context(name))))
  assert.equal(calls, 1); assert.equal(local, 1); assert.equal(gemini.status().state, 'COOLDOWN')
  for (const result of results) {
    assert.equal(result.marketOutlook.bias, 'UNAVAILABLE')
    assert.equal(result.marketOutlook.articleSentiments[0].scope, 'TEXT_ONLY')
    assert.equal(result.marketOutlook.articleSentiments[0].impactScore, undefined)
    assert.equal(result.marketOutlook.assessmentStatus.textOnly, 1)
    assert.equal(result.marketOutlook.assessmentStatus.assessed, 0)
  }
  await news.getNews(context()); assert.equal(calls, 1)
})

test('cached market assessments survive quota failure on an added headline', async () => {
  let calls = 0
  const { news } = create((...args) => ++calls === 1 ? fakeNews(...args) : Promise.resolve(new Response('{}', { status: 429 })))
  await news.getNews(context())
  const result = await news.getNews(context('Nifty 50', [article(), article('new')]))
  assert.equal(result.marketOutlook.articleSentiments.length, 1)
  assert.equal(result.marketOutlook.assessmentStatus.assessed, 1)
  assert.equal(result.marketOutlook.assessmentStatus.total, 2)
  assert.equal(result.providerStatus.state, 'COOLDOWN')
})

test('transient overload retries once with delay, succeeds, and queues requests serially', async () => {
  const waits = []; let calls = 0, simultaneous = 0, max = 0
  const gemini = createGeminiClient({ apiKey: 'fixture', model: 'fixture', now: () => clock, random: () => .5, sleep: async ms => waits.push(ms), fetchImpl: async () => {
    simultaneous++; max = Math.max(max, simultaneous); await new Promise(resolve => setTimeout(resolve, 5)); simultaneous--; calls++
    return calls === 1 ? new Response('{}', { status: 503 }) : success({ okay: true })
  } })
  assert.deepEqual(await Promise.all([gemini.generate({}), gemini.generate({})]), [{ okay: true }, { okay: true }])
  assert.equal(calls, 3); assert.equal(max, 1); assert.deepEqual(waits, [1250]); assert.equal(gemini.status().state, 'AVAILABLE')
})

test('persistent overload and invalid responses stop retry loops', async () => {
  for (const response of [() => new Response('{}', { status: 503 }), () => new Response('{}')]) {
    let calls = 0
    const { gemini } = create(async () => { calls++; return response() })
    await assert.rejects(gemini.generate({}))
    await assert.rejects(gemini.generate({}))
    assert.equal(gemini.status().state, 'COOLDOWN')
    assert(calls <= 2)
  }
})

test('configuration errors are not retried and missing API key never performs cloud calls', async () => {
  for (const code of [400, 401, 402, 403, 404]) {
    let calls = 0
    const { gemini } = create(async () => { calls++; return new Response('{}', { status: code }) })
    await assert.rejects(gemini.generate({})); assert.equal(calls, 1)
  }
  const { news } = create(async () => { throw new Error('must not call') }, { apiKey: '' })
  assert.equal((await news.getNews(context())).marketOutlook.bias, 'UNAVAILABLE')
})

test('Retry-After is respected and cooldown expiration permits a later attempt', async () => {
  let time = clock, calls = 0
  const { gemini } = create(async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '7200' } }) : success({ okay: true }), { now: () => time })
  await assert.rejects(gemini.generate({}))
  assert.equal(Date.parse(gemini.status().retryAt), clock + 7200000)
  time += 7200001
  assert.deepEqual(await gemini.generate({}), { okay: true })
})

test('public headline cache and provider cooldown persist across backend restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trading-ai-'))
  try {
    const cache = createAiCache(join(directory, 'news.json'))
    const first = create(fakeNews, { cache, saveState: state => { cache.providerState = state; cache.save() } })
    await first.news.getNews(context()); await cache.flush()
    const saved = createAiCache(join(directory, 'news.json'))
    const second = create(async () => { throw new Error('must use cached headline') }, { cache: saved })
    assert.equal((await second.news.getNews(context())).marketOutlook.assessmentStatus.assessed, 1)
    await saved.flush()
    const paused = create(async () => new Response('{}', { status: 429 }), { cache, saveState: state => { cache.providerState = state; cache.save() } })
    await assert.rejects(paused.gemini.generate({})); await cache.flush()
    const restarted = createAiCache(join(directory, 'news.json'))
    assert.equal(create(fakeNews, { savedState: restarted.providerState }).gemini.status().state, 'COOLDOWN')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('expired, future and stale-source headlines are never assessed', async () => {
  let calls = 0
  const { news } = create((...args) => { calls++; return fakeNews(...args) })
  const data = context('Nifty 50', [{ ...article('expired'), publishedAt: new Date(clock - 49 * 3600000).toISOString() }, { ...article('future'), publishedAt: new Date(clock + 120000).toISOString() }, article('stale')])
  data.feeds[0].status = 'STALE'
  assert.equal((await news.getNews(data)).marketOutlook.articleSentiments.length, 0)
  assert.equal(calls, 0)
})

test('manual commentary deduplicates overlapping requests and does not reuse an expired result', async () => {
  let time = clock, calls = 0
  const cache = createAiCache(), { gemini } = create()
  const news = createAiNewsService({ gemini, cache, now: () => time })
  const generate = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return { bias: 'CALL', stage: 'CONFIRMED' } }
  await Promise.all([news.getCommentary('same', generate), news.getCommentary('same', generate)])
  assert.equal(calls, 1)
  assert.equal((await news.getCommentary('same', generate)).cached, true)
  time += 300001; await news.getCommentary('same', generate); assert.equal(calls, 2)
})

test('local-model failure is contained and cannot invent a neutral/news impact vote', async () => {
  const { news } = create(fakeNews, { apiKey: '', localClassify: async () => { throw new Error('unavailable') } })
  const result = await news.getNews(context())
  assert.equal(result.marketOutlook.bias, 'UNAVAILABLE')
  assert.deepEqual(result.marketOutlook.articleSentiments, [])
  assert.equal(result.marketOutlook.assessmentStatus.assessed, 0)
})

test('a partial headline response cannot cause an immediate duplicate cloud request', async () => {
  let calls = 0
  const { news } = create(async (url, request) => {
    calls++
    const input = JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)
    return success({ articleSentiments: input.articles.slice(0, 1).map(item => ({ articleId: item.id, sentiment: 'POSITIVE', impactScore: 1 })) })
  }, { localClassify: async articles => articles.map(item => ({ articleId: item.id, sentiment: 'NEUTRAL' })) })
  const data = context('Nifty 50', [article(), article('omitted')])
  await news.getNews(data)
  const repeat = await news.getNews(data)
  assert.equal(calls, 1)
  assert.equal(repeat.marketOutlook.assessmentStatus.textOnly, 1)
  assert.equal(Date.parse(repeat.marketOutlook.assessmentStatus.retryAt), clock + 120000)
})
