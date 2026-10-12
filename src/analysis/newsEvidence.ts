import type { MarketArticle, MarketContext, MarketOutlook } from '../api/marketContext'

type Sentiment = NonNullable<MarketOutlook['articleSentiments']>[number]

export function headlineTopic(article: MarketArticle) {
  const title = `${article.title} ${article.description || ''}`
  if (/\bRBI\b|\brepo\b|\bFederal Reserve\b|\bFOMC\b|\bmonetary policy\b|\brate (?:hike|cut)\b/i.test(title)) return 'Policy'
  if (/\brupee\b|\bUSD\/?INR\b|\bcurrency\b|\bforex\b/i.test(title)) return 'Currency'
  if (/\bcrude\b|\bBrent\b|\bOPEC\b|\bcommodit(?:y|ies)\b|\bgold\b/i.test(title)) return 'Commodities'
  if (/\bearnings\b|\bquarter(?:ly)?\b|\bQ[1-4]\b|\bresults\b/i.test(title)) return 'Earnings'
  if (article.category === 'companies') return 'Corporate'
  return article.category === 'global' || article.category === 'globalCompanies' ? 'Global' : 'India'
}

function impact(item?: Sentiment) {
  if (!item || item.sentiment === 'UNCLEAR') return undefined
  if (item.impactScore === undefined) return item.sentiment === 'POSITIVE' ? 1 : item.sentiment === 'NEGATIVE' ? -1 : item.sentiment === 'NEUTRAL' ? 0 : undefined
  const score = item.impactScore
  return Number.isInteger(score) && (item.sentiment === 'POSITIVE' ? score === 1 || score === 2
    : item.sentiment === 'NEGATIVE' ? score === -1 || score === -2 : item.sentiment === 'NEUTRAL' && score === 0) ? score : undefined
}

export function buildNewsEvidence(context: MarketContext | null, outlook: MarketOutlook | undefined, now: number) {
  const contextAge = context ? now - Date.parse(context.retrievedAt) : NaN
  const current = Number.isFinite(contextAge) && contextAge >= -60_000 && contextAge <= 10 * 60_000
  const currentOutlook = current && outlook?.contextRevision === context?.revision ? outlook : undefined
  const assessments = new Map((currentOutlook?.articleSentiments || []).map(item => [item.articleId, item]))
  const seen = new Set<string>()
  const headlines = (context?.articles || []).filter(article => {
    const age = now - Date.parse(article.publishedAt)
    if (seen.has(article.id) || !Number.isFinite(age) || age < -60_000 || age > 48 * 3_600_000 || !/^https?:\/\//i.test(article.url)) return false
    seen.add(article.id)
    return true
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).map(article => {
    const eligible = current && context!.feeds.some(feed => feed.category === article.category && feed.status === 'AVAILABLE')
      && (article.category !== 'companies' || context!.constituents.status === 'AVAILABLE')
    const assessment = eligible ? assessments.get(article.id) : undefined
    const score = impact(assessment)
    return { article, topic: headlineTopic(article), eligible, score, reason: assessment?.reason,
      status: !eligible ? 'STALE' : score !== undefined ? score > 0 ? 'POSITIVE' : score < 0 ? 'NEGATIVE' : 'NEUTRAL' : assessment?.sentiment === 'UNCLEAR' ? 'UNCLEAR' : 'UNRATED' }
  })
  const scored = headlines.filter(headline => headline.score !== undefined)
  return { headlines, articles: headlines.filter(headline => headline.eligible).map(headline => headline.article), currentOutlook,
    score: scored.length ? scored.reduce((sum, headline) => sum + headline.score!, 0) / scored.length : undefined,
    assessed: scored.length, positive: scored.filter(headline => headline.score! > 0).length,
    negative: scored.filter(headline => headline.score! < 0).length, neutral: scored.filter(headline => headline.score === 0).length,
  }
}
