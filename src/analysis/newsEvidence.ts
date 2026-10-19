import type { MarketArticle, MarketContext, MarketOutlook } from '../api/marketContext'
import { sentimentFreshness } from './sentimentFreshness'

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
  if (!item || item.sentiment === 'UNCLEAR' || item.scope === 'TEXT_ONLY' || item.source === 'LOCAL_FINBERT') return undefined
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
    const saved = eligible ? assessments.get(article.id) : undefined
    const assessmentAge = saved?.assessedAt ? now - Date.parse(saved.assessedAt) : undefined
    const assessment = assessmentAge === undefined || Number.isFinite(assessmentAge) && assessmentAge >= -60_000 && assessmentAge <= 24 * 3600_000 ? saved : undefined
    const score = impact(assessment)
    const freshness = sentimentFreshness('news', article.publishedAt, now)
    return { article, topic: headlineTopic(article), eligible, score, freshness, ageAdjustedScore: score === undefined || !freshness ? undefined : score * freshness.factor, reason: assessment?.reason, source: assessment?.source, assessedAt: assessment?.assessedAt,
      status: !eligible ? 'STALE' : assessment?.scope === 'TEXT_ONLY' || assessment?.source === 'LOCAL_FINBERT' ? `TEXT_${assessment.sentiment}` : score !== undefined ? score > 0 ? 'POSITIVE' : score < 0 ? 'NEGATIVE' : 'NEUTRAL' : assessment?.sentiment === 'UNCLEAR' ? 'UNCLEAR' : 'UNRATED' }
  })
  const scored = headlines.filter(headline => headline.score !== undefined)
  return { headlines, articles: headlines.filter(headline => headline.eligible).map(headline => headline.article), currentOutlook,
    score: scored.length ? scored.reduce((sum, headline) => sum + headline.score!, 0) / scored.length : undefined,
    // Keep raw card impact labels; reduce older evidence without redistributing its lost weight.
    ageAdjustedScore: scored.length ? scored.reduce((sum, headline) => sum + (headline.ageAdjustedScore ?? 0), 0) / scored.length : undefined,
    assessed: scored.length, positive: scored.filter(headline => headline.score! > 0).length,
    negative: scored.filter(headline => headline.score! < 0).length, neutral: scored.filter(headline => headline.score === 0).length,
  }
}
