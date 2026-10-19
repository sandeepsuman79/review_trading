import type { MarketContext, MarketOutlook } from './marketContext'
import type { AngelOneCandle } from './angelOne'
import type { PriceActionAnalysis, PriceActionInterval } from '../analysis/priceAction'
import type { TradingEvidence } from '../analysis/tradingEvidence'

export type AiPriceAction = {
  providerStatus?: AiProviderStatus
  marketContext?: MarketContext
  marketOutlook?: MarketOutlook
  model: string
  bias: 'CALL' | 'PUT' | 'WAIT'
  stage: 'EARLY' | 'TRIGGER' | 'CONFIRMED' | 'NEUTRAL'
  summary: string
  bullishEvidence: string[]
  bearishEvidence: string[]
  confirmation: string
  invalidation: string
  caveat: string
  analyzedCandles: number
  asOf: string
}

export type AiProviderStatus = { state: 'AVAILABLE' | 'CACHED' | 'COOLDOWN' | 'UNAVAILABLE'; code: string; message: string; retryAt: string | null }
export type NewsAssessment = { marketContext: MarketContext; marketOutlook: MarketOutlook; providerStatus: AiProviderStatus }

/** News changes, rather than every candle or macro quote, trigger automatic assessment. */
export function newsAssessmentKey(context: MarketContext | null, now: number) {
  if (!context) return ''
  const available = new Set(context.feeds.filter(feed => feed.status === 'AVAILABLE').map(feed => feed.category))
  return JSON.stringify([context.instrument, context.articles.filter(article => available.has(article.category)
    && (article.category !== 'companies' || context.constituents.status === 'AVAILABLE')
    && now - Date.parse(article.publishedAt) >= -60_000 && now - Date.parse(article.publishedAt) <= 48 * 3600_000)
    .map(({ id, title, description, url, publisher, publishedAt, category, matchedCompanies }) => ({ id, title, description, url, publisher, publishedAt, category, matchedCompanies })).sort((a, b) => a.id.localeCompare(b.id))])
}

export async function getNewsAssessment(instrument: string, signal?: AbortSignal): Promise<NewsAssessment> {
  const response = await fetch(`/api/ai/news?${new URLSearchParams({ instrument })}`, { signal })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.marketContext?.instrument !== instrument || !Array.isArray(data.marketContext?.articles) || !Array.isArray(data.marketContext?.feeds)
    || !data.marketContext?.constituents || data.marketOutlook?.contextRevision !== data.marketContext.revision || !Array.isArray(data.marketOutlook?.articleSentiments) || !Array.isArray(data.marketOutlook?.evidenceIds)
    || !['AVAILABLE', 'CACHED', 'COOLDOWN', 'UNAVAILABLE'].includes(data.providerStatus?.state)) throw new Error('News assessment is unavailable. Technical evaluation continues.')
  return data
}

export async function getAiPriceAction(
  instrument: string,
  interval: PriceActionInterval,
  candles: AngelOneCandle[],
  rules: PriceActionAnalysis,
  signal?: AbortSignal,
  includeMarketContext = false,
  evidence?: TradingEvidence,
): Promise<AiPriceAction> {
  const response = await fetch('/api/ai/price-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      instrument,
      interval,
      includeMarketContext,
      candles: candles.slice(-40),
      rules: {
        decision: rules.side,
        tradeStatus: rules.tradeStatus,
        earlyBias: rules.earlyBias,
        earlyStage: rules.earlyStage,
        earlyStrength: rules.earlyStrength,
        phase: rules.phase,
        structure: rules.structure,
        structureEvent: rules.structureEvent,
        location: rules.location,
        candleBehavior: rules.candleBehavior,
        pattern: rules.pattern,
        setup: rules.setup,
        vwap: evidence?.vwap,
        atmVwap: evidence?.atmVwap,
        observedFlowReports: evidence?.observedFlowReports,
        technicalEvidence: evidence ? { bullishScore: evidence.bullishScore, bearishScore: evidence.bearishScore, coverage: evidence.coverage, riskNotes: evidence.riskNotes.slice(0, 3), layers: evidence.layers.map(({ name, weight, coverage, bullish, bearish }) => ({ name, weight, coverage, bullish, bearish })), turns: evidence.turns } : undefined,
        marketSentiment: evidence ? { bullishScore: evidence.sentiment.bullishScore, bearishScore: evidence.sentiment.bearishScore, coverage: evidence.sentiment.coverage, bias: evidence.sentiment.bias, alignment: evidence.sentiment.alignment, role: 'REFERENCE_ONLY' } : undefined,
        bullishScore: rules.bullishScore,
        bearishScore: rules.bearishScore,
        bullishEvidence: rules.bullishEvidence,
        bearishEvidence: rules.bearishEvidence,
        support: rules.support,
        resistance: rules.resistance,
        movingAverage20: rules.movingAverage20,
        exponentialMovingAverage20: rules.exponentialMovingAverage20,
        exponentialMovingAverage50: rules.exponentialMovingAverage50,
        rsi14: rules.rsi14,
        atr14: rules.atr14,
        rsi14Momentum: rules.rsi14Momentum,
        supertrend10: rules.supertrend10,
        supertrendDirection: rules.supertrendDirection,
      },
    }),
  })

  const result = await response.json().catch(() => ({})) as Partial<AiPriceAction> & { message?: string }
  if (!response.ok) {
    throw new Error(response.status === 429 ? 'Gemini quota reached. Technical evaluation continues.'
      : response.status >= 500 ? 'Gemini is temporarily unavailable. Technical evaluation continues.'
        : (result.message || `Optional AI analysis failed (${response.status}).`).slice(0, 180))
  }
  return result as AiPriceAction
}
