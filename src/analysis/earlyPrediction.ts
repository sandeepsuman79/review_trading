import type { PriceActionAnalysis, PriceActionInterval } from './priceAction'
import { candleIntervalMs } from './candleData'
import type { MarketArticle, MarketContext, MarketOutlook } from '../api/marketContext'

export type PredictionPlan = {
  id: string
  instrument: string
  interval: PriceActionInterval
  side: 'CALL' | 'PUT'
  stage: 'EARLY' | 'CONFIRMED'
  strategyVersion: 'early-v1'
  signalCandleTime: string
  generatedAt: number
  expiresAt: number
  entry: number
  target: number
  stopLoss: number
  riskReward: number
  targetBasis: string
  reason: string
  contextMode: 'NEWS_ALIGNED' | 'TECHNICAL_ONLY'
  bullishScore: number
  bearishScore: number
  technicalEvidence: string[]
  newsSummary: string
  newsEvidence: MarketArticle[]
  coverage: string[]
}

export type EarlyPrediction = { side: 'WAIT'; reason: string } | { side: 'CALL' | 'PUT'; reason: string; plan: PredictionPlan }
const round = (price: number) => Math.round(price * 100) / 100

/** News can confirm or veto a setup; all numerical levels come from completed chart data. */
export function buildEarlyPrediction(analysis: PriceActionAnalysis, instrument: string, interval: PriceActionInterval, now: number, context?: MarketContext | null, outlook?: MarketOutlook): EarlyPrediction {
  const wait = (reason: string): EarlyPrediction => ({ side: 'WAIT', reason })
  const candleTime = Date.parse(analysis.latestCandleTime || '')
  if (analysis.analyzedCandles < 25 || !Number.isFinite(candleTime)) return wait('At least 25 completed candles are required.')
  if (now < candleTime + candleIntervalMs(interval) || now - candleTime > 2 * candleIntervalMs(interval)) return wait('Waiting for recent completed candles; historical charts do not create new calls.')
  const side = analysis.side !== 'WAIT' ? analysis.side : analysis.earlyBias === 'BULLISH' ? 'CALL' : analysis.earlyBias === 'BEARISH' ? 'PUT' : 'WAIT'
  if (side === 'WAIT') return wait('Technical evidence has no clear early direction.')
  const bias = side === 'CALL' ? 'BULLISH' : 'BEARISH'
  const usableOutlook = context && context.instrument === instrument && outlook?.contextRevision === context.revision
    && now - Date.parse(context.retrievedAt) <= 10 * 60_000 && now >= Date.parse(context.retrievedAt)
    && outlook.evidenceIds.length > 0 && outlook.evidenceIds.every(id => context.articles.some(article => article.id === id
      && context.feeds.some(feed => feed.category === article.category && feed.status === 'AVAILABLE')
      && now - Date.parse(article.publishedAt) <= 48 * 3_600_000 && Date.parse(article.publishedAt) <= now))
    && outlook.bias !== 'UNAVAILABLE' && outlook.agreement !== 'INSUFFICIENT'
  if (usableOutlook && (outlook.bias === 'MIXED' || outlook.agreement === 'MIXED' || outlook.agreement === 'CONFLICTS_WITH_CHART' || (outlook.bias !== 'NEUTRAL' && outlook.bias !== bias))) {
    return wait('Chart and news disagree or are mixed. Waiting for alignment before issuing a new call.')
  }
  const newsAligned = Boolean(usableOutlook && outlook?.bias === bias && outlook.agreement === 'SUPPORTS_CHART')
  const confirmed = analysis.side !== 'WAIT'
  const score = side === 'CALL' ? analysis.bullishScore : analysis.bearishScore
  const opposingScore = side === 'CALL' ? analysis.bearishScore : analysis.bullishScore
  if (!confirmed && (score < 50 || score - opposingScore < 15)) return wait('Early chart evidence is too weak or conflicted to issue a conditional call.')
  const entry = confirmed ? analysis.entry : side === 'CALL' ? analysis.bullishTrigger : analysis.bearishTrigger
  const stopLoss = confirmed ? analysis.stopLoss : side === 'CALL' ? analysis.bullishInvalidation : analysis.bearishInvalidation
  if (entry === undefined || stopLoss === undefined || ![entry, stopLoss].every(value => Number.isFinite(value) && value > 0)) return wait('A valid entry and chart invalidation level are required.')
  const direction = side === 'CALL' ? 1 : -1
  const risk = (entry - stopLoss) * direction
  if (risk < 0.01) return wait('Entry and stop-loss must be on opposite sides of the setup risk.')
  // An early setup is a conditional breakout, never an already passed trigger.
  if (!confirmed && (analysis.currentPrice === undefined || (entry - analysis.currentPrice) * direction <= 0)) return wait('The early trigger has already passed; waiting for a fresh completed setup.')
  const structure = side === 'CALL' ? analysis.resistance : analysis.support
  let target = confirmed ? analysis.target : structure
  let targetBasis = confirmed ? 'Chart setup target' : 'Chart resistance/support'
  if (!confirmed && (target === undefined || (target - entry) * direction <= 0)) {
    target = entry + direction * risk * 2
    targetBasis = '2R projection from chart invalidation (not an observed level)'
  }
  if (target === undefined || !Number.isFinite(target) || target <= 0) return wait('No valid target is available.')
  const roundedEntry = round(entry), roundedStop = round(stopLoss), roundedTarget = round(target)
  const riskReward = ((roundedTarget - roundedEntry) * direction) / ((roundedEntry - roundedStop) * direction)
  if (!Number.isFinite(riskReward) || riskReward < 1.5) return wait('The chart target offers less than 1.5:1 reward to risk. Waiting for a better setup.')
  const reason = `${confirmed ? 'Confirmed chart setup' : 'Early conditional breakout'}; ${newsAligned ? 'available news supports the chart direction' : 'technical-only: news alignment is unavailable or neutral'}. Entry must be reached before the call becomes active.`
  return { side, reason, plan: {
    id: `early-v1:${instrument}:${interval}:${analysis.latestCandleTime}:${side}`,
    strategyVersion: 'early-v1', instrument, interval, side, stage: confirmed ? 'CONFIRMED' : 'EARLY', signalCandleTime: analysis.latestCandleTime!,
    generatedAt: now, expiresAt: now + 3 * candleIntervalMs(interval), entry: roundedEntry, stopLoss: roundedStop, target: roundedTarget, riskReward: round(riskReward), targetBasis, reason,
    contextMode: newsAligned ? 'NEWS_ALIGNED' : 'TECHNICAL_ONLY', bullishScore: analysis.bullishScore, bearishScore: analysis.bearishScore,
    technicalEvidence: [...(side === 'CALL' ? analysis.bullishEvidence : analysis.bearishEvidence)],
    newsSummary: usableOutlook ? outlook!.summary : 'News interpretation unavailable; chart-only setup.',
    newsEvidence: usableOutlook ? context!.articles.filter(article => outlook!.evidenceIds.includes(article.id)).map(({ id, title, url, publisher, publishedAt, category, matchedCompanies }) => ({ id, title, url, publisher, publishedAt, category, matchedCompanies: [...matchedCompanies] })) : [],
    coverage: context?.instrument === instrument ? context.feeds.map(feed => `${feed.category}: ${feed.status}`) : ['Public market context unavailable'],
  } }
}
