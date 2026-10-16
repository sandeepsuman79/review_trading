import { atmVwapBias, type AtmVwapSnapshot } from '../api/atmVwap'
import { cachedCandleIndicators } from './candleIndicatorCache'
import { candleSession } from './vwap'
import type { AngelOneCandle } from '../api/angelOne'
import type { IndiaVixSnapshot, InstitutionalFlow, MarketContext, MarketOutlook } from '../api/marketContext'
import { analyzePriceAction } from './priceAction'
import { analyzeTradingEvidence } from './tradingEvidence'
import { buildEarlyPrediction, type PredictionPlan } from './earlyPrediction'
import type { CommodityContract } from './commodities'
import { monitorInterval, timeframeInfo } from './timeframes'

export type MinuteReview = {
  instrument: string; contractToken?: string; asOf?: string; reviewedAt: number; current: boolean
  state: 'WARMING_UP' | 'STALE' | 'WATCH' | 'CONFIRMED' | 'REVERSAL_RISK' | 'WAIT'
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; bullishScore: number; bearishScore: number; coverage: number
  reason: string; plan?: PredictionPlan
  indicators: { ema20?: number; ema50?: number; rsi?: number; atr?: number; supertrend?: string; vwap?: number }
  optionVwap?: AtmVwapSnapshot
  optionVwapError?: string
  pressure?: { side: 'CALL' | 'PUT'; confirmed: boolean; reasons: string[] }
  bullishEvidence: string[]; bearishEvidence: string[]
  sentiment: { bias: string; bullishScore: number; bearishScore: number; coverage: number; contextAt?: string }
}

/** Background-only assessment. Its plan is eligible for protective exits, never new entries. */
export function analyzeMinuteMonitor({ candles, instrument, now, contract, context, outlook, indiaVix, flowHistory, optionVwap, optionVwapError }: {
  optionVwap?: AtmVwapSnapshot; optionVwapError?: string
  candles: AngelOneCandle[]; instrument: string; now: number; contract?: CommodityContract
  context?: MarketContext | null; outlook?: MarketOutlook; indiaVix?: IndiaVixSnapshot; flowHistory?: InstitutionalFlow[]
}): MinuteReview {
  const analysis = analyzePriceAction(candles, monitorInterval, now, instrument)
  const evidence = analyzeTradingEvidence({ analysis, candles, instrument, interval: monitorInterval, now, context, outlook, indiaVix, flowHistory })
  const selected = evidence.selectedAnalysis ?? analysis
  const candidate = buildEarlyPrediction(selected, instrument, monitorInterval, now, context, outlook, evidence, contract)
  const plan = 'plan' in candidate && candidate.plan.stage === 'CONFIRMED' ? candidate.plan : undefined
  const age = now - Date.parse(analysis.latestCandleTime ?? '')
  const duration = timeframeInfo[monitorInterval].milliseconds
  const current = Number.isFinite(age) && age >= duration && age < 2 * duration
  const { closed, averages } = cachedCandleIndicators(candles, monitorInterval, now)
  const last = closed[closed.length - 1], prior = closed[closed.length - 2], ema = averages[averages.length - 1]?.ema20, previousEma = averages[averages.length - 2]?.ema20
  let pressure: MinuteReview['pressure']
  if (last && prior && analysis.atr14 && Date.parse(last[0]) - Date.parse(prior[0]) === 60_000 && candleSession(last[0]) === candleSession(prior[0])) {
    for (const d of [1, -1]) {
      const side = d === 1 ? 'CALL' : 'PUT', atr = analysis.atr14, reasons: string[] = []
      const body = (last[4] - last[1]) * d, breakout = (last[4] - (d === 1 ? prior[2] : prior[3])) * d > .05 * atr
      if (ema !== undefined && previousEma !== undefined && (last[4] - ema) * d > 0 && (ema - previousEma) * d > 0) reasons.push('EMA20 position and slope confirm the minute direction')
      if (analysis.rsi14 !== undefined && analysis.rsi14Momentum !== undefined && analysis.rsi14Momentum * d > 0 && ((analysis.rsi14 - 50) * d > 0 || analysis.rsi14Momentum * d >= 3)) reasons.push('RSI momentum confirms the pressure')
      if (analysis.supertrendDirection === (d === 1 ? 'UP' : 'DOWN')) reasons.push('Supertrend supports the reversal')
      if (evidence.vwap !== undefined && (last[4] - evidence.vwap) * d > .05 * atr) reasons.push('Traded-volume VWAP supports the minute direction')
      if ((prior[4] - prior[1]) * d > 0 && (last[4] - prior[4]) * d > 0) reasons.push('Two completed candles show persistent opposite pressure')
      if (atmVwapBias(optionVwap, instrument, analysis.currentPrice, now) === (d === 1 ? 'BULLISH' : 'BEARISH')) reasons.push('Both ATM CE/PE candle VWAP positions support the reversal (option context)')
      if (breakout) reasons.push('Completed candle broke the preceding candle extreme')
      if (body > 0 && body >= .35 * (last[2] - last[3]) && breakout && reasons.length >= 3) pressure = { side, confirmed: true, reasons }
    }
  }
  const state = analysis.analyzedCandles < 50 ? 'WARMING_UP' : !current ? 'STALE' : plan ? 'CONFIRMED' : pressure?.confirmed ? 'REVERSAL_RISK' : evidence.bias === 'NEUTRAL' ? 'WAIT' : 'WATCH'
  return { instrument, optionVwap, optionVwapError, contractToken: contract?.token, pressure, asOf: analysis.latestCandleTime, reviewedAt: now, current, state, bias: evidence.bias,
    bullishScore: evidence.bullishScore, bearishScore: evidence.bearishScore, coverage: evidence.coverage,
    reason: state === 'WARMING_UP' ? `${analysis.analyzedCandles}/50 completed minute candles available.` : !current ? 'Waiting for a recent completed 1-minute candle.' : candidate.reason,
    plan, indicators: { ema20: selected.exponentialMovingAverage20, ema50: selected.exponentialMovingAverage50, rsi: selected.rsi14, atr: evidence.atr14, supertrend: selected.supertrendDirection, vwap: evidence.vwap },
    bullishEvidence: evidence.bullishEvidence.slice(0, 4), bearishEvidence: evidence.bearishEvidence.slice(0, 4),
    sentiment: { bias: evidence.sentiment.bias, bullishScore: evidence.sentiment.bullishScore, bearishScore: evidence.sentiment.bearishScore, coverage: evidence.sentiment.coverage, contextAt: context?.instrument === instrument ? context.retrievedAt : undefined } }
}

/** Keep one observation per completed minute in the last five minutes; gaps stay missing. */
export function rollingMinuteReviews(previous: MinuteReview[], next: MinuteReview, now: number) {
  const boundary = Math.floor(now / 60_000) * 60_000
  const reviews = previous.filter(review => review.instrument === next.instrument && Date.parse(review.asOf ?? '') >= boundary - 5 * 60_000 && Date.parse(review.asOf ?? '') < boundary)
  if (next.current && next.asOf) {
    const index = reviews.findIndex(review => review.asOf === next.asOf)
    if (index >= 0) reviews[index] = next
    else reviews.push(next)
  }
  return reviews.sort((a, b) => Date.parse(a.asOf!) - Date.parse(b.asOf!)).slice(-5)
}

export function minutePlanOpposes(plan: PredictionPlan | undefined, minutePlan: PredictionPlan | undefined, checkedAt: number, now: number) {
  const start = Date.parse(minutePlan?.signalCandleTime ?? '')
  return Boolean(plan && minutePlan?.stage === 'CONFIRMED' && minutePlan.strategyVersion === 'technical-v2' && now >= minutePlan.generatedAt && now - minutePlan.generatedAt < 60_000 && minutePlan.interval === monitorInterval && plan.instrument === minutePlan.instrument
    && plan.contract?.token === minutePlan.contract?.token && plan.contract?.symbol === minutePlan.contract?.symbol && plan.side !== minutePlan.side
    && now >= checkedAt && now - checkedAt < 60_000 && now >= start + 60_000 && now < start + 120_000 && now < minutePlan.expiresAt)
}

export function minuteReviewOpposes(plan: PredictionPlan | undefined, review: MinuteReview | undefined, now: number) {
  const start = Date.parse(review?.asOf ?? '')
  if (!plan || !review || review.instrument !== plan.instrument || review.contractToken !== plan.contract?.token || !review.current || now < review.reviewedAt || now - review.reviewedAt >= 60_000 || now < start + 60_000 || now >= start + 120_000) return false
  return minutePlanOpposes(plan, review.plan, review.reviewedAt, now) || Boolean(review.pressure?.confirmed && review.pressure.side !== plan.side)
}
