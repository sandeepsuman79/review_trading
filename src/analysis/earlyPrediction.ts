import type { PriceActionAnalysis, PriceActionInterval } from './priceAction'
import { candleIntervalMs } from './candleData'
import type { MarketArticle, MarketContext, MarketOutlook } from '../api/marketContext'
import type { TradingEvidence } from './tradingEvidence'
import { isCommodity, validCommodityContract, type CommodityContract } from './commodities'
import { squareOffTime, inTradingEntryWindow, marketHours } from './tradingSession'
import { chartIntervals } from './timeframes'

export type PredictionPlan = {
  id: string
  instrument: string
  contract?: CommodityContract
  interval: PriceActionInterval
  side: 'CALL' | 'PUT'
  stage: 'EARLY' | 'CONFIRMED' | 'RISKY'
  strategyVersion: 'early-v1' | 'combined-v1' | 'technical-v2'
  confirmationQuality?: 'STANDARD' | 'STRONG'
  risk?: { level: number; levelType: 'SUPPORT' | 'RESISTANCE'; passedChecks: number; unmetChecks: string[]; alignedIndicators: string[]; opposedIndicators: string[] }
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
  evidenceSummary?: { version: 'combined-v1' | 'technical-v2'; coverage: number; atr14?: number; indiaVix?: number; layers: Array<{ name: string; weight: number; coverage: number; bullish: number; bearish: number }>; sentiment?: Pick<TradingEvidence['sentiment'], 'bullishScore' | 'bearishScore' | 'coverage' | 'bias' | 'alignment' | 'reason'> }
}

export type EarlyPrediction = { side: 'WAIT'; reason: string } | { side: 'CALL' | 'PUT'; reason: string; plan: PredictionPlan }
const round = (price: number) => Math.round(price * 100) / 100

/** Technical evidence confirms a setup. News is recorded as reference and never vetoes entry. */
export function buildEarlyPrediction(analysis: PriceActionAnalysis, instrument: string, interval: PriceActionInterval, now: number, context?: MarketContext | null, outlook?: MarketOutlook, evidence?: TradingEvidence, contract?: CommodityContract): EarlyPrediction {
  analysis = evidence?.selectedAnalysis ?? analysis
  const wait = (reason: string): EarlyPrediction => ({ side: 'WAIT', reason })
  if (!(chartIntervals as readonly string[]).includes(interval)) return wait('New setups use completed 5-minute, 15-minute or 1-hour candles. One-minute strategy analysis is disabled.')
  if (isCommodity(instrument) && !evidence) return wait('Commodity entries require the current full technical assessment.')
  if (isCommodity(instrument) && (!validCommodityContract(contract, instrument) || contract.expiresAt <= now)) return wait('Waiting for a matching, unexpired MCX futures contract before issuing a trade setup.')
  if (isCommodity(instrument) && !inTradingEntryWindow(now, instrument)) return wait(`Outside the MCX entry window (${marketHours(instrument, now)}).`)
  const candleTime = Date.parse(analysis.latestCandleTime || '')
  if (analysis.analyzedCandles < 25 || !Number.isFinite(candleTime)) return wait('At least 25 completed candles are required.')
  if (now < candleTime + candleIntervalMs(interval) || now - candleTime > 2 * candleIntervalMs(interval)) return wait('Waiting for recent completed candles; historical charts do not create new calls.')
  if (evidence && (evidence.instrument !== instrument || evidence.interval !== interval || evidence.asOf !== analysis.latestCandleTime)) return wait('Technical assessment does not match the current index, timeframe or candle.')
  const risky = evidence && !evidence.canConfirm ? evidence.riskySetup : undefined
  const side = risky?.side ?? (analysis.side !== 'WAIT' ? analysis.side : analysis.earlyBias === 'BULLISH' ? 'CALL' : analysis.earlyBias === 'BEARISH' ? 'PUT' : 'WAIT')
  if (side === 'WAIT') return wait(evidence?.reason || 'Technical evidence has no clear early direction.')
  const bias = side === 'CALL' ? 'BULLISH' : 'BEARISH'
  const usableOutlook = context && context.instrument === instrument && outlook?.contextRevision === context.revision
    && now - Date.parse(context.retrievedAt) <= 10 * 60_000 && now >= Date.parse(context.retrievedAt)
    && outlook.evidenceIds.length > 0 && outlook.evidenceIds.every(id => context.articles.some(article => article.id === id
      && context.feeds.some(feed => feed.category === article.category && feed.status === 'AVAILABLE')
      && now - Date.parse(article.publishedAt) <= 48 * 3_600_000 && Date.parse(article.publishedAt) <= now))
    && outlook.bias !== 'UNAVAILABLE' && (Boolean(evidence) || outlook.agreement !== 'INSUFFICIENT')
  const newsAligned = Boolean(usableOutlook && outlook?.bias === bias && outlook.agreement === 'SUPPORTS_CHART')
  const confirmed = !risky && analysis.side !== 'WAIT'
  if (evidence && (evidence.instrument !== instrument || evidence.interval !== interval || evidence.asOf !== analysis.latestCandleTime || !evidence.canConfirm && !risky)) return wait(evidence.reason)
  const score = side === 'CALL' ? analysis.bullishScore : analysis.bearishScore
  const opposingScore = side === 'CALL' ? analysis.bearishScore : analysis.bullishScore
  if (!confirmed && !risky && (score < 50 || score - opposingScore < 15)) return wait('Early chart evidence is too weak or conflicted to issue a conditional call.')
  const entry = risky?.entry ?? (confirmed ? analysis.entry : side === 'CALL' ? analysis.bullishTrigger : analysis.bearishTrigger)
  const stopLoss = risky?.stopLoss ?? evidence?.stopLoss ?? (confirmed ? analysis.stopLoss : side === 'CALL' ? analysis.bullishInvalidation : analysis.bearishInvalidation)
  if (entry === undefined || stopLoss === undefined || ![entry, stopLoss].every(value => Number.isFinite(value) && value > 0)) return wait('A valid entry and chart invalidation level are required.')
  const direction = side === 'CALL' ? 1 : -1
  const risk = (entry - stopLoss) * direction
  if (risk < 0.01) return wait('Entry and stop-loss must be on opposite sides of the setup risk.')
  // An early setup is a conditional breakout, never an already passed trigger.
  if (!confirmed && (analysis.currentPrice === undefined || (entry - analysis.currentPrice) * direction <= 0)) return wait('The early trigger has already passed; waiting for a fresh completed setup.')
  const structure = side === 'CALL' ? analysis.resistance : analysis.support
  let target = risky?.target ?? (confirmed ? analysis.target : structure)
  let targetBasis = risky?.targetBasis ?? (confirmed ? analysis.targetBasis || 'Chart setup target' : 'Chart resistance/support')
  if (evidence) targetBasis += ' · Stop covers chart invalidation and at least 1 × ATR(14)'
  if (!confirmed && (target === undefined || (target - entry) * direction <= 0)) {
    target = entry + direction * risk * 2
    targetBasis = '2R projection from chart invalidation (not an observed level)'
  }
  if (target === undefined || !Number.isFinite(target) || target <= 0) return wait('No valid target is available.')
  const tick = contract?.tickSize
  const snap = (value: number, up: boolean) => tick ? round((up ? Math.ceil(value / tick - 1e-8) : Math.floor(value / tick + 1e-8)) * tick) : round(value)
  const roundedEntry = snap(entry, direction === 1), roundedStop = snap(stopLoss, direction === -1), roundedTarget = snap(target, direction === -1)
  const riskReward = ((roundedTarget - roundedEntry) * direction) / ((roundedEntry - roundedStop) * direction)
  if (!Number.isFinite(riskReward) || riskReward < 1.5) return wait('The chart target offers less than 1.5:1 reward to risk. Waiting for a better setup.')
  const reason = risky ? `Risky conditional ${side} setup: ${risky.passedChecks}/7 checks passed; ${risky.levelType.toLowerCase()} ${risky.level.toFixed(2)} with ${risky.alignedIndicators.join(' or ')}. Missing: ${risky.unmetChecks.join(', ')}. A trigger touch alone is not full confirmation.` : `${confirmed ? 'Confirmed chart setup' : 'Early conditional breakout'}; ${evidence ? `technical evidence ${side === 'CALL' ? evidence.bullishScore : evidence.bearishScore}/100 with ${evidence.coverage}% coverage` : 'technical confirmation; sentiment is reference only'}. Entry must be reached before the call becomes active.`
  return { side, reason, plan: {
    id: `${evidence?.version ?? 'early-v1'}:${risky ? 'risky:' : ''}${instrument}:${contract ? `${contract.token}:` : ''}${interval}:${analysis.latestCandleTime}:${side}`,
    ...(contract ? { contract: { ...contract } } : {}),
    ...(confirmed && evidence?.quality ? { confirmationQuality: evidence.quality } : {}),
    strategyVersion: evidence?.version ?? 'early-v1', instrument, interval, side, stage: risky ? 'RISKY' : confirmed ? 'CONFIRMED' : 'EARLY', signalCandleTime: analysis.latestCandleTime!,
    ...(risky ? { risk: { level: risky.level, levelType: risky.levelType, passedChecks: risky.passedChecks, unmetChecks: risky.unmetChecks, alignedIndicators: risky.alignedIndicators, opposedIndicators: risky.opposedIndicators } } : {}),
    generatedAt: now, expiresAt: Math.min(confirmed && evidence?.version === 'technical-v2' ? candleTime + 2 * candleIntervalMs(interval) : now + 3 * candleIntervalMs(interval), squareOffTime(now, instrument), contract?.expiresAt ?? Infinity), entry: roundedEntry, stopLoss: roundedStop, target: roundedTarget, riskReward: round(riskReward), targetBasis, reason,
    contextMode: !evidence && newsAligned ? 'NEWS_ALIGNED' : 'TECHNICAL_ONLY', bullishScore: evidence?.bullishScore ?? analysis.bullishScore, bearishScore: evidence?.bearishScore ?? analysis.bearishScore,
    technicalEvidence: [...(evidence ? side === 'CALL' ? evidence.bullishEvidence : evidence.bearishEvidence : side === 'CALL' ? analysis.bullishEvidence : analysis.bearishEvidence)],
    ...(evidence ? { evidenceSummary: { version: evidence.version, coverage: evidence.coverage, atr14: evidence.atr14, indiaVix: evidence.indiaVix?.price, layers: evidence.layers.map(({ name, weight, coverage, bullish, bearish }) => ({ name, weight, coverage, bullish, bearish })), sentiment: { bullishScore: evidence.sentiment.bullishScore, bearishScore: evidence.sentiment.bearishScore, coverage: evidence.sentiment.coverage, bias: evidence.sentiment.bias, alignment: evidence.sentiment.alignment, reason: evidence.sentiment.reason } } } : {}),
    newsSummary: usableOutlook ? `Sentiment reference only: ${outlook!.summary}` : 'News interpretation unavailable; technical confirmation is independent.',
    newsEvidence: usableOutlook ? context!.articles.filter(article => outlook!.evidenceIds.includes(article.id)).map(({ id, title, url, publisher, publishedAt, category, matchedCompanies }) => ({ id, title, url, publisher, publishedAt, category, matchedCompanies: [...matchedCompanies] })) : [],
    coverage: context?.instrument === instrument ? context.feeds.map(feed => `${feed.category}: ${feed.status}`) : ['Public market context unavailable'],
  } }
}
