import type { MarketContext, MarketOutlook } from './marketContext'
import type { AngelOneCandle } from './angelOne'
import type { PriceActionAnalysis, PriceActionInterval } from '../analysis/priceAction'
import type { TradingEvidence } from '../analysis/tradingEvidence'

export type AiPriceAction = {
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
        observedFlowReports: evidence?.observedFlowReports,
        combinedEvidence: evidence ? { bullishScore: evidence.bullishScore, bearishScore: evidence.bearishScore, coverage: evidence.coverage, riskNotes: evidence.riskNotes.slice(0, 3), layers: evidence.layers.map(({ name, weight, coverage, bullish, bearish }) => ({ name, weight, coverage, bullish, bearish })) } : undefined,
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
    throw new Error(result.message || `AI analysis failed (${response.status}).`)
  }
  return result as AiPriceAction
}
