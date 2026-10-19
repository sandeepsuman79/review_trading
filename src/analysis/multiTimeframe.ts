import type { AtmVwapSnapshot } from '../api/atmVwap'
import type { AngelOneCandle } from '../api/angelOne'
import type { IndiaVixSnapshot, InstitutionalFlow, MarketContext, MarketOutlook } from '../api/marketContext'
import { candleIntervalMs } from './candleData'
import type { CommodityContract } from './commodities'
import { buildEarlyPrediction, type EarlyPrediction, type PredictionPlan } from './earlyPrediction'
import { analyzePriceAction, type PriceActionAnalysis } from './priceAction'
import type { PredictionRecord } from './predictionHistory'
import { currentSetupPrediction, setupEntryDeadline } from './setupTiming'
import { chartIntervals } from './timeframes'
import { analyzeTradingEvidence, type TradingEvidence } from './tradingEvidence'

export type AgentTimeframe = typeof chartIntervals[number]
export type TimeframeReview = {
  instrument: string
  interval: AgentTimeframe
  contractToken?: string
  reviewedAt: number
  asOf?: string
  closedAt?: number
  current: boolean
  status: 'WARMING_UP' | 'STALE' | 'CONFIRMED' | 'WATCH' | 'WAIT' | 'ENDED'
  rawAnalysis: PriceActionAnalysis
  analysis: PriceActionAnalysis
  evidence: TradingEvidence
  assessedPrediction: EarlyPrediction
  /** Fully qualified technical signal, before entry-only ledger/extreme guards. */
  assessedPlan?: PredictionPlan
  prediction: EarlyPrediction
  /** Only a current, fully confirmed, unconsumed setup may enter or reverse. */
  plan?: PredictionPlan
  reason: string
}
export type MultiTimeframeAssessment = {
  instrument: string
  contractToken?: string
  reviewedAt: number
  reviews: TimeframeReview[]
  selectedReview?: TimeframeReview
  selectedPlan?: PredictionPlan
  displayReview: TimeframeReview
  conflicts: boolean
}

const tieOrder: Record<AgentTimeframe, number> = { FIFTEEN_MINUTE: 1, FIVE_MINUTE: 0, ONE_HOUR: 2 }
const newestFirst = (a: TimeframeReview, b: TimeframeReview) => (b.closedAt ?? -Infinity) - (a.closedAt ?? -Infinity) || tieOrder[a.interval] - tieOrder[b.interval]
const sameContract = (a?: CommodityContract, b?: CommodityContract) => a?.token === b?.token && a?.symbol === b?.symbol && a?.expiry === b?.expiry && a?.exchange === b?.exchange

/** Each timeframe keeps its own candles, indicator warmup, scores and risk gates.
 * Scores are never combined and a slower view cannot veto a fresh qualified setup.
 */
export function analyzeMultiTimeframe({ candlesByInterval, instrument, now, contract, context, outlook, indiaVix, flowHistory, atmVwap, records = [] }: {
  candlesByInterval: Partial<Record<AgentTimeframe, AngelOneCandle[]>>
  instrument: string
  now: number
  contract?: CommodityContract
  context?: MarketContext | null
  outlook?: MarketOutlook
  indiaVix?: IndiaVixSnapshot
  flowHistory?: InstitutionalFlow[]
  atmVwap?: AtmVwapSnapshot
  records?: PredictionRecord[]
}): MultiTimeframeAssessment {
  const reviews = chartIntervals.map((interval): TimeframeReview => {
    const candles = candlesByInterval[interval] ?? []
    const rawAnalysis = analyzePriceAction(candles, interval, now, instrument)
    const evidence = analyzeTradingEvidence({ analysis: rawAnalysis, candles, interval, instrument, now, context, outlook, indiaVix, flowHistory, atmVwap })
    const analysis = evidence.selectedAnalysis ?? rawAnalysis
    const candidate = buildEarlyPrediction(analysis, instrument, interval, now, context, outlook, evidence, contract)
    const prediction = currentSetupPrediction(candidate, records, candles, now)
    const start = Date.parse(analysis.latestCandleTime ?? '')
    const duration = candleIntervalMs(interval)
    const current = Number.isFinite(start) && now >= start + duration && now < start + 2 * duration
    const plan = current && evidence.canConfirm && 'plan' in prediction && prediction.plan.stage === 'CONFIRMED' ? prediction.plan : undefined
    const ended = 'plan' in candidate && candidate.plan.stage === 'CONFIRMED' && !('plan' in prediction)
    const status = analysis.analyzedCandles < 50 ? 'WARMING_UP' : !current ? 'STALE' : plan ? 'CONFIRMED' : ended ? 'ENDED' : evidence.bias === 'NEUTRAL' ? 'WAIT' : 'WATCH'
    return { instrument, interval, contractToken: contract?.token, reviewedAt: now, asOf: analysis.latestCandleTime,
      closedAt: Number.isFinite(start) ? start + duration : undefined, current, status, rawAnalysis, analysis, evidence, assessedPrediction: candidate,
      assessedPlan: current && evidence.canConfirm && 'plan' in candidate && candidate.plan.stage === 'CONFIRMED' ? candidate.plan : undefined, prediction, plan,
      reason: status === 'WARMING_UP' ? `${analysis.analyzedCandles}/50 completed candles available.` : status === 'STALE' ? 'Waiting for a recent completed candle on this timeframe.' : prediction.reason }
  })
  return assembledAssessment(instrument, contract?.token, now, reviews)
}

function assembledAssessment(instrument: string, contractToken: string | undefined, now: number, reviews: TimeframeReview[]): MultiTimeframeAssessment {
  const selectedReview = reviews.filter(review => review.plan).sort(newestFirst)[0]
  const directional = reviews.filter(review => review.current && review.status !== 'WARMING_UP').map(review => review.plan?.side ?? (review.evidence.bias === 'BULLISH' ? 'CALL' : review.evidence.bias === 'BEARISH' ? 'PUT' : undefined))
  return { instrument, contractToken, reviewedAt: now, reviews, selectedReview, selectedPlan: selectedReview?.plan,
    displayReview: selectedReview ?? reviews.find(review => review.interval === 'FIVE_MINUTE')!, conflicts: directional.includes('CALL') && directional.includes('PUT') }
}

/** Recheck entry consumption on current forming extremes and ledger changes without
 * recomputing every indicator for each incoming quote. This cannot create a signal.
 */
export function revalidateMultiTimeframeAssessment(base: MultiTimeframeAssessment, { candlesByInterval, records = [], now }: {
  candlesByInterval: Partial<Record<AgentTimeframe, AngelOneCandle[]>>; records?: PredictionRecord[]; now: number
}): MultiTimeframeAssessment {
  const reviews = base.reviews.map((review): TimeframeReview => {
    const start = Date.parse(review.asOf ?? ''), duration = candleIntervalMs(review.interval)
    const current = Number.isFinite(start) && now >= start + duration && now < start + 2 * duration
    const candidate: EarlyPrediction = 'plan' in review.assessedPrediction
      ? { ...review.assessedPrediction, plan: { ...review.assessedPrediction.plan, generatedAt: now } } : review.assessedPrediction
    const prediction = currentSetupPrediction(candidate, records, candlesByInterval[review.interval] ?? [], now)
    const assessedPlan = current && review.evidence.canConfirm && 'plan' in candidate && candidate.plan.stage === 'CONFIRMED' && now < setupEntryDeadline(candidate.plan) ? candidate.plan : undefined
    const plan = assessedPlan && 'plan' in prediction && prediction.plan.stage === 'CONFIRMED' ? prediction.plan : undefined
    const ended = 'plan' in candidate && candidate.plan.stage === 'CONFIRMED' && !('plan' in prediction)
    const status = review.analysis.analyzedCandles < 50 ? 'WARMING_UP' : !current ? 'STALE' : plan ? 'CONFIRMED' : ended ? 'ENDED' : review.evidence.bias === 'NEUTRAL' ? 'WAIT' : 'WATCH'
    return { ...review, reviewedAt: now, current, prediction, assessedPlan, plan, status,
      reason: status === 'WARMING_UP' ? review.reason : status === 'STALE' ? 'Waiting for a recent completed candle on this timeframe.' : prediction.reason }
  })
  return assembledAssessment(base.instrument, base.contractToken, now, reviews)
}

/** Revalidate both review and signal age: stale evaluations cannot become fresh exits.
 * Live quote freshness and stop/target priority are enforced by the trade ledger.
 */
export function selectReversalPlan(record: PredictionRecord, reviews: TimeframeReview[], now: number): PredictionPlan | undefined {
  if (record.status !== 'ACTIVE' || record.entryAt === undefined || !Number.isFinite(now)) return
  return reviews.filter(review => {
    const plan = review.assessedPlan
    if (!plan || !(chartIntervals as readonly string[]).includes(plan.interval) || review.interval !== plan.interval || review.instrument !== record.instrument || !review.current || !review.evidence.canConfirm) return false
    const start = Date.parse(plan.signalCandleTime), duration = candleIntervalMs(plan.interval)
    return plan.stage === 'CONFIRMED' && plan.strategyVersion === 'technical-v2' && plan.instrument === record.instrument && plan.side !== record.side
      && sameContract(plan.contract, record.contract) && review.contractToken === record.contract?.token && review.asOf === plan.signalCandleTime
      && Number.isFinite(start) && start >= record.entryAt! && now >= start + duration && now < start + 2 * duration
      && now >= review.reviewedAt && now - review.reviewedAt <= 30_000 && now >= plan.generatedAt && now - plan.generatedAt <= 30_000
      && now < setupEntryDeadline(plan)
  }).sort(newestFirst)[0]?.assessedPlan
}
