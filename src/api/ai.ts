import type { AngelOneCandle } from './angelOne'
import type { PriceActionAnalysis, PriceActionInterval } from '../analysis/priceAction'

export type AiPriceAction = {
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
): Promise<AiPriceAction> {
  const response = await fetch('/api/ai/price-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      instrument,
      interval,
      candles: candles.slice(-60),
      rules: {
        decision: rules.side,
        phase: rules.phase,
        structure: rules.structure,
        support: rules.support,
        resistance: rules.resistance,
        bullishScore: rules.bullishScore,
        bearishScore: rules.bearishScore,
      },
    }),
  })

  const result = await response.json().catch(() => ({})) as Partial<AiPriceAction> & { message?: string }
  if (!response.ok) {
    throw new Error(result.message || `AI analysis failed (${response.status}).`)
  }
  return result as AiPriceAction
}
