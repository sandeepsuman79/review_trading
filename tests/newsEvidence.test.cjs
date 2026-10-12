const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename)
const { buildNewsEvidence, headlineTopic } = require('../src/analysis/newsEvidence.ts')
const now = Date.parse('2026-10-12T19:00:00Z')
const article = (id, category = 'india', age = 1000) => ({ id, category, title: `Headline ${id}`, publishedAt: new Date(now - age).toISOString(), url: `https://publisher.example/${id}`, publisher: 'Fixture', matchedCompanies: [] })
const context = () => ({ instrument: 'Nifty 50', revision: 'r1', retrievedAt: new Date(now).toISOString(), constituents: { status: 'AVAILABLE' }, feeds: ['india', 'global', 'companies', 'globalCompanies'].map(category => ({ category, status: 'AVAILABLE' })), articles: [article('a'), article('b', 'companies', 2000), article('c', 'global', 3000), article('d', 'globalCompanies', 4000)] })

test('news score uses only individually assessed current headlines and preserves impact magnitude', () => {
  const outlook = { contextRevision: 'r1', articleSentiments: [{ articleId: 'a', sentiment: 'NEGATIVE', impactScore: -2 }, { articleId: 'b', sentiment: 'POSITIVE', impactScore: 1 }, { articleId: 'c', sentiment: 'NEUTRAL', impactScore: 0 }, { articleId: 'd', sentiment: 'UNCLEAR', impactScore: 0 }, { articleId: 'invented', sentiment: 'POSITIVE', impactScore: 2 }] }
  const result = buildNewsEvidence(context(), outlook, now)
  assert.equal(result.score, -1 / 3)
  assert.deepEqual([result.assessed, result.positive, result.negative, result.neutral], [3, 1, 1, 1])
  assert.deepEqual(result.headlines.map(item => item.status), ['NEGATIVE', 'POSITIVE', 'NEUTRAL', 'UNCLEAR'])
})

test('stale revisions, feed outages and expired membership suppress badges without losing readable headlines', () => {
  const outlook = { contextRevision: 'r1', articleSentiments: [{ articleId: 'a', sentiment: 'POSITIVE', impactScore: 2 }, { articleId: 'b', sentiment: 'NEGATIVE', impactScore: -1 }] }
  assert.equal(buildNewsEvidence(context(), { ...outlook, contextRevision: 'old' }, now).score, undefined)
  assert.equal(buildNewsEvidence(context(), outlook, now + 11 * 60000).score, undefined)
  const stale = context(); stale.feeds[0].status = 'STALE'; stale.constituents.status = 'STALE'
  const result = buildNewsEvidence(stale, outlook, now)
  assert.equal(result.headlines.length, 4)
  assert.deepEqual(result.headlines.slice(0, 2).map(item => item.status), ['STALE', 'STALE'])
  assert.equal(result.score, undefined)
})

test('headlines reject unsafe links, invalid dates, duplicate IDs and old/future items, latest first', () => {
  const data = context()
  data.articles = [article('older', 'india', 10000), article('newest'), article('newest'), article('old', 'india', 49 * 3600000), article('future', 'india', -120000), { ...article('bad'), url: 'javascript:alert(1)' }, { ...article('date'), publishedAt: 'invalid' }]
  assert.deepEqual(buildNewsEvidence(data, undefined, now).headlines.map(item => item.article.id), ['newest', 'older'])
  assert.equal(buildNewsEvidence(null, undefined, now).score, undefined)
})

test('mismatched impact scores remain unscored and legacy direction-only assessments use one point', () => {
  const data = context()
  const bad = buildNewsEvidence(data, { contextRevision: 'r1', articleSentiments: [{ articleId: 'a', sentiment: 'POSITIVE', impactScore: -2 }] }, now)
  assert.equal(bad.score, undefined)
  const legacy = buildNewsEvidence(data, { contextRevision: 'r1', articleSentiments: [{ articleId: 'a', sentiment: 'POSITIVE' }] }, now)
  assert.equal(legacy.score, 1)
})

test('display topics identify policy, currency, commodities and earnings without assigning sentiment', () => {
  for (const [title, topic] of [['RBI reviews repo policy', 'Policy'], ['Rupee moves against dollar', 'Currency'], ['Brent crude supply outlook', 'Commodities'], ['Q2 earnings announced', 'Earnings']]) assert.equal(headlineTopic({ ...article('a'), title }), topic)
  assert.equal(headlineTopic(article('a', 'companies')), 'Corporate')
  assert.equal(headlineTopic(article('a', 'global')), 'Global')
})
