import type { AngelOneCandle } from '../api/angelOne'
import type { PredictionPlan } from './earlyPrediction'
import { analyzeChartStructure, completedChartHistory, observedSessionGap, trendLinePrice, validSavedChartStructure, type ChartStructure } from './chartStructure'
import { isCommodity, validCommodityContract, type CommodityContract } from './commodities'
import { inTradingEntryWindow, squareOffTime } from './tradingSession'
import { hasValidRewardRisk } from './tradeRisk'
import { candleSession } from './vwap'

export const candleAgentPolicy = 'five-minute-candles-v2' as const
export const candleAgentRules = { minimumBars: 20, rangeBars: 10, referenceR: 2, minimumBody: .35, minimumClosePosition: .65 }
export type CandlePattern = 'ACCEPTED_RANGE_BREAK' | 'ENGULFING_REVERSAL' | 'REJECTION_BREAK' | 'INSIDE_BAR_BREAK' | 'ZONE_RETEST' | 'TREND_PULLBACK' | 'TREND_STRUCTURE_BREAK' | 'DOUBLE_TOP_BREAK' | 'DOUBLE_BOTTOM_BREAK'
export type CandleCheck = { code: string; label: string; passed: boolean; detail: string }
export type CandleSignal = { policy: typeof candleAgentPolicy | 'five-minute-candles-v1'; instrument: string; contractToken?: string; asOf: string; reviewedAt: number
  side: 'CALL' | 'PUT'; pattern: CandlePattern; level: number; invalidation: number; trigger: number; chartStructure?: ChartStructure }
export type CandleConfirmation = CandleSignal & { interval: 'FIVE_MINUTE'; completedBars: number; target: number; tickSize: number; checks: CandleCheck[] }
export type CandleAssessment = { policy: typeof candleAgentPolicy; instrument: string; contractToken?: string; interval: 'FIVE_MINUTE'; reviewedAt: number
  asOf?: string; completedBars: number; current: boolean; state: 'WARMING_UP' | 'STALE' | 'SIDEWAYS' | 'WAIT' | 'CONFIRMED'
  reason: string; signal?: CandleSignal; plan?: PredictionPlan; support?: number; resistance?: number; checks: CandleCheck[]
  structure: ChartStructure; candleStops: Partial<Record<'CALL' | 'PUT', { price: number; at: string }>> }
const step = 300_000
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const snap = (value: number, tick: number, up: boolean) => Math.round((up ? Math.ceil(value / tick - 1e-8) : Math.floor(value / tick + 1e-8)) * tick * 1e8) / 1e8
const tailAt = <T,>(values: T[], offset = 1): T | undefined => values[values.length - offset]
const label = (pattern: CandlePattern) => pattern.replace(/_/g, ' ').toLowerCase()

/** The live policy consumes OHLC only. Indicators, volume, sentiment, ATM quotes
 * and other timeframes cannot contribute or veto a candlestick signal. */
export function analyzeCandleAgent({ candles, instrument, now, contract }: { candles: AngelOneCandle[]; instrument: string; now: number; contract?: CommodityContract }): CandleAssessment {
  const { closed, tail } = completedChartHistory(candles, instrument, now)
  const last = tailAt(closed, 1), prior = tailAt(closed, 2), asOf = last?.[0], start = Date.parse(asOf ?? '')
  const current = finite(start) && now >= start + step && now < start + 2 * step && candleSession(asOf!) === candleSession(new Date(now).toISOString())
  const checks: CandleCheck[] = [], add = (code: string, title: string, passed: boolean, detail: string) => checks.push({ code, label: title, passed, detail })
  const tick = contract?.tickSize ?? .01
  const recent = closed.slice(-3)
  const dataReady = closed.length >= candleAgentRules.minimumBars && tail.length >= 3 && recent.length === 3
    && recent.every((b, i) => candleSession(b[0]) === candleSession(asOf!) && (!i || Date.parse(b[0]) - Date.parse(recent[i - 1][0]) === step))
  add('CANDLE_HISTORY', 'Completed candle history', dataReady, `${closed.length}/${candleAgentRules.minimumBars} completed bars across history; recent pattern bars must be complete and contiguous.`)
  add('CANDLE_FRESHNESS', 'Current five-minute close', current, 'Only a current completed five-minute candle can create a signal; forming bars cannot confirm.')
  const exactContract = !isCommodity(instrument) ? !contract : validCommodityContract(contract, instrument) && contract.expiresAt > now
  add('CANDLE_CONTRACT', 'Instrument identity', exactContract && finite(tick) && tick > 0, 'MCX requires its exact unexpired futures contract and a valid tick size.')
  const structure = analyzeChartStructure(tail, tick, observedSessionGap(closed, instrument))
  // Signal boundaries must already exist before the two accepting candles.
  const known = analyzeChartStructure(tail.slice(0, -2), tick, observedSessionGap(closed.slice(0, -2), instrument))
  const highs = known.swings.filter(s => s.kind === 'HIGH'), lows = known.swings.filter(s => s.kind === 'LOW')
  const supporting = structure.zones.filter(z => z.role === 'SUPPORT' && z.low < (last?.[4] ?? 0))
  const opposing = structure.zones.filter(z => z.role === 'RESISTANCE' && z.high > (last?.[4] ?? Infinity))
  const support = supporting.length ? Math.max(...supporting.map(z => z.high)) : undefined
  const resistance = opposing.length ? Math.min(...opposing.map(z => z.low)) : undefined
  const candleStops: CandleAssessment['candleStops'] = {}
  const latestLow = tailAt(structure.swings.filter(s => s.kind === 'LOW')), latestHigh = tailAt(structure.swings.filter(s => s.kind === 'HIGH'))
  if (latestLow?.label === 'HL') candleStops.CALL = { price: snap(latestLow.price - tick, tick, false), at: latestLow.at }
  if (latestHigh?.label === 'LH') candleStops.PUT = { price: snap(latestHigh.price + tick, tick, true), at: latestHigh.at }
  let signal: CandleSignal | undefined
  if (dataReady && current && exactContract && finite(tick) && tick > 0 && last && prior) {
    const range = last[2] - last[3], history = tail.slice(-12, -2), before = tail.slice(-7, -2)
    const mother = tailAt(tail, 3)
    for (const d of [1, -1] as const) {
      const side = d === 1 ? 'CALL' : 'PUT', body = d * (last[4] - last[1])
      const closePosition = range > 0 ? (d === 1 ? last[4] - last[3] : last[2] - last[4]) / range : 0
      if (!(range > 0 && body >= candleAgentRules.minimumBody * range && closePosition >= candleAgentRules.minimumClosePosition)) continue
      const boundary = history.length === 10 ? d === 1 ? Math.max(...history.map(b => b[2])) : Math.min(...history.map(b => b[3])) : undefined
      const tolerance = Math.max(2 * tick, .25 * (prior[2] - prior[3]))
      const accepted = boundary !== undefined && d * (prior[4] - boundary) >= tick && d * (last[4] - boundary) >= tick
        && (d === 1 ? last[3] >= boundary - tolerance : last[2] <= boundary + tolerance)
      const counterTrend = before.length >= 3 && d * (tailAt(before, 1)![4] - before[0][4]) < -tick
      const atLevel = known.zones.some(z => z.role === (d === 1 ? 'SUPPORT' : 'RESISTANCE')
        && prior[3] <= z.high + known.tolerance && prior[2] >= z.low - known.tolerance
        && d * (last[4] - (d === 1 ? z.high : z.low)) >= tick)
      const location = counterTrend || atLevel
      const engulfing = location && d * (prior[4] - prior[1]) < 0 && d * (last[1] - prior[4]) <= tick
        && d * (last[4] - prior[1]) >= tick && d * (last[4] - (d === 1 ? prior[2] : prior[3])) >= tick
      const priorBody = Math.abs(prior[4] - prior[1]), priorRange = prior[2] - prior[3]
      const rejectionWick = d === 1 ? Math.min(prior[1], prior[4]) - prior[3] : prior[2] - Math.max(prior[1], prior[4])
      const rejected = location && priorRange > 0 && rejectionWick >= Math.max(2 * priorBody, .5 * priorRange)
        && d * (last[4] - (d === 1 ? prior[2] : prior[3])) >= tick
      const inside = mother && prior[2] < mother[2] && prior[3] > mother[3]
        && d * (last[4] - (d === 1 ? mother[2] : mother[3])) >= tick
      const sameLine = known.lines.find(line => line.validated && line.kind === (d === 1 ? 'SUPPORT' : 'RESISTANCE'))
      const reverseLine = known.lines.find(line => line.validated && line.kind === (d === 1 ? 'RESISTANCE' : 'SUPPORT'))
      const priorIndex = tail.length - 2, lastIndex = tail.length - 1
      const pullback = sameLine && known.trend === (d === 1 ? 'UPTREND' : 'DOWNTREND')
        && Math.abs((d === 1 ? prior[3] : prior[2]) - trendLinePrice(sameLine, priorIndex)) <= known.tolerance
        && d * (prior[4] - trendLinePrice(sameLine, priorIndex)) > 0
        && d * (last[4] - trendLinePrice(sameLine, lastIndex)) > 0
        && d * (last[4] - (d === 1 ? prior[2] : prior[3])) >= tick
      const swingBoundary = tailAt(d === 1 ? highs : lows)?.price
      const trendBreak = reverseLine && swingBoundary !== undefined
        && d * (prior[4] - trendLinePrice(reverseLine, priorIndex)) > known.tolerance
        && d * (last[4] - trendLinePrice(reverseLine, lastIndex)) > known.tolerance
        && d * (prior[4] - swingBoundary) >= tick && d * (last[4] - swingBoundary) >= tick
      const retest = known.zones.find(z => z.flipped && z.touches >= 2 && z.role === (d === 1 ? 'SUPPORT' : 'RESISTANCE')
        && prior[3] <= z.high + known.tolerance && prior[2] >= z.low - known.tolerance
        && d * (prior[4] - (d === 1 ? z.high : z.low)) >= tick
        && d * (last[4] - (d === 1 ? prior[2] : prior[3])) >= tick
        && d * ((d === 1 ? last[3] : last[2]) - (d === 1 ? z.low : z.high)) >= -known.tolerance)
      const doublePoints = d === 1 ? lows : highs, first = tailAt(doublePoints, 2), second = tailAt(doublePoints)
      const doubleRange = first && second ? tail.slice(first.index, second.index + 1) : []
      const neckline = doubleRange.length ? d === 1 ? Math.max(...doubleRange.map(b => b[2])) : Math.min(...doubleRange.map(b => b[3])) : undefined
      const approached = first && first.index >= 3 && d * (tail[first.index][4] - tail[Math.max(0, first.index - 6)][4]) < -known.tolerance
      const doubleBreak = approached && first && second && second.index - first.index >= 4 && Math.abs(first.price - second.price) <= known.tolerance
        && neckline !== undefined && d * (prior[4] - neckline) >= tick && d * (last[4] - neckline) >= tick
        && d * ((d === 1 ? last[3] : last[2]) - neckline) >= -known.tolerance
      const pattern: CandlePattern | undefined = doubleBreak ? d === 1 ? 'DOUBLE_BOTTOM_BREAK' : 'DOUBLE_TOP_BREAK'
        : retest ? 'ZONE_RETEST' : pullback ? 'TREND_PULLBACK' : trendBreak ? 'TREND_STRUCTURE_BREAK'
          : engulfing ? 'ENGULFING_REVERSAL' : rejected ? 'REJECTION_BREAK' : accepted ? 'ACCEPTED_RANGE_BREAK' : inside ? 'INSIDE_BAR_BREAK' : undefined
      if (!pattern) continue
      const stopBars = pattern === 'INSIDE_BAR_BREAK' ? [mother!, prior, last] : [prior, last]
      const invalidation = d === 1 ? Math.min(...stopBars.map(b => b[3]), doubleBreak ? second!.price : Infinity, retest ? retest.low : Infinity) - tick : Math.max(...stopBars.map(b => b[2]), doubleBreak ? second!.price : -Infinity, retest ? retest.high : -Infinity) + tick
      signal = { policy: candleAgentPolicy, instrument, ...(contract ? { contractToken: contract.token } : {}), asOf: asOf!, reviewedAt: now,
        side, pattern, chartStructure: known, level: doubleBreak ? neckline! : retest ? d === 1 ? retest.high : retest.low : trendBreak ? swingBoundary! : pullback ? trendLinePrice(sameLine!, lastIndex) : accepted ? boundary! : d === 1 ? prior[2] : prior[3], invalidation: snap(invalidation, tick, d === -1), trigger: snap(d === 1 ? last[2] + tick : last[3] - tick, tick, d === 1) }
      break
    }
  }
  add('CANDLE_PATTERN', 'Accepted candlestick pattern', Boolean(signal), signal ? `${signal.side}: ${label(signal.pattern)} on ${signal.asOf}; the completed close accepts the price break.` : 'Wait for a completed directional pattern at accepted price structure: range, zone retest, validated trend line, neckline or reversal candle.')
  const entryWindow = inTradingEntryWindow(now, instrument)
  add('CANDLE_ENTRY_WINDOW', 'Entry session', entryWindow, 'A new entry must occur within the configured instrument session and before setup expiry.')
  let plan: PredictionPlan | undefined
  if (signal) {
    const d = signal.side === 'CALL' ? 1 : -1, risk = d * (signal.trigger - signal.invalidation)
    const gapEdge = known.gap && known.gap.state !== 'FILLED' && known.gap.direction === (d === 1 ? 'DOWN' : 'UP') ? d === 1 ? known.gap.low : known.gap.high : undefined
    const opposing = [...(gapEdge === undefined ? [] : [gapEdge]), ...(d === 1 ? highs : lows).map(s => s.price), ...known.zones.filter(z => z.role === (d === 1 ? 'RESISTANCE' : 'SUPPORT')).map(z => d === 1 ? z.low : z.high)].filter(v => d * (v - signal!.trigger) > tick)
    const observed = opposing.length ? d === 1 ? Math.min(...opposing) : Math.max(...opposing) : undefined
    const projection = signal.trigger + d * candleAgentRules.referenceR * risk
    const reference = observed === undefined ? projection : d === 1 ? Math.min(observed, projection) : Math.max(observed, projection)
    const target = snap(reference, tick, d === -1), rr = risk > 0 ? d * (target - signal.trigger) / risk : NaN
    const validRisk = risk >= 2 * tick - 1e-8 && signal.invalidation > 0 && target > 0 && hasValidRewardRisk(rr)
    add('CANDLE_RISK', 'Price-structure risk', validRisk, `Initial SL is beyond the pattern wick. Reference reward/risk ${finite(rr) ? `${rr.toFixed(2)}:1` : 'unavailable'} is informational; no minimum ratio. Positive, correctly ordered entry/SL/target levels are required; nearby observed resistance/support is retained.`)
    if (validRisk && entryWindow) {
      const targetBasis = observed !== undefined && Math.abs(reference - observed) < tick / 2 ? 'Nearest observed opposing swing, price zone or unfilled gap edge' : '2R projection from candlestick invalidation (not an observed level)'
      const candleConfirmation: CandleConfirmation = { ...signal, interval: 'FIVE_MINUTE', completedBars: closed.length, target, tickSize: tick, checks: checks.map(c => ({ ...c })) }
      plan = { id: `candle-v2:${instrument}:${contract?.token ?? 'spot'}:${asOf}:${signal.side}`, instrument, ...(contract ? { contract: { ...contract } } : {}), interval: 'FIVE_MINUTE',
        side: signal.side, stage: 'CONFIRMED', strategyVersion: 'candle-v2', candleConfirmation, signalCandleTime: asOf!, generatedAt: now,
        expiresAt: Math.min(start + 2 * step, squareOffTime(now, instrument), contract?.expiresAt ?? Infinity), entry: signal.trigger, stopLoss: signal.invalidation,
        target, riskReward: rr, targetBasis, reason: `Confirmed ${label(signal.pattern)} from completed five-minute candles. Entry waits for a fresh quote through ${signal.trigger}.`,
        contextMode: 'TECHNICAL_ONLY', bullishScore: 0, bearishScore: 0, technicalEvidence: [label(signal.pattern), `Price structure ${known.trend}`, `Validated trend lines ${known.lines.filter(l => l.validated).length}`,  `Price level ${signal.level}`, `Pattern invalidation ${signal.invalidation}`],
        newsSummary: 'Candlestick-only confirmation.', newsEvidence: [], coverage: [`${closed.length} completed five-minute OHLC bars; no weighted indicator score`] }
    }
  }
  const lastSix = tail.slice(-6), span = lastSix.length ? Math.max(...lastSix.map(b => b[2])) - Math.min(...lastSix.map(b => b[3])) : 0
  const overlaps = lastSix.slice(1).filter((b, i) => b[3] <= lastSix[i][2] && b[2] >= lastSix[i][3]).length
  const sideways = !signal && dataReady && span > 0 && overlaps >= 4 && Math.abs(tailAt(lastSix, 1)![4] - lastSix[0][1]) < .3 * span
  const state = !current ? 'STALE' : !dataReady ? 'WARMING_UP' : plan ? 'CONFIRMED' : sideways ? 'SIDEWAYS' : 'WAIT'
  const reason = plan?.reason ?? (!current ? 'Waiting for a current completed five-minute candle.' : !dataReady ? 'Waiting for sufficient completed price history and contiguous pattern bars.'
    : signal ? checks.find(c => !c.passed)?.detail ?? 'Price pattern found; awaiting valid risk/session conditions.' : sideways ? 'Overlapping candles with little net progress: sideways; no directional trade.' : 'No accepted directional candlestick pattern yet.')
  return { policy: candleAgentPolicy, instrument, contractToken: contract?.token, interval: 'FIVE_MINUTE', reviewedAt: now, asOf, completedBars: closed.length, current, state, reason, signal, plan, support, resistance, checks, candleStops, structure }
}

export function validCandleConfirmation(value: CandleConfirmation | undefined, plan: PredictionPlan) {
  return Boolean(value && value.policy === (plan.strategyVersion === 'candle-v1' ? 'five-minute-candles-v1' : candleAgentPolicy) && value.instrument === plan.instrument && value.contractToken === plan.contract?.token
    && (plan.strategyVersion !== 'candle-v2' || validSavedChartStructure(value.chartStructure, value.asOf))
    && value.interval === 'FIVE_MINUTE' && plan.interval === 'FIVE_MINUTE' && value.asOf === plan.signalCandleTime && value.side === plan.side
    && ['ACCEPTED_RANGE_BREAK', 'ENGULFING_REVERSAL', 'REJECTION_BREAK', 'INSIDE_BAR_BREAK', ...(plan.strategyVersion === 'candle-v2' ? ['ZONE_RETEST', 'TREND_PULLBACK', 'TREND_STRUCTURE_BREAK', 'DOUBLE_TOP_BREAK', 'DOUBLE_BOTTOM_BREAK'] : [])].includes(value.pattern)
    && [value.trigger, value.invalidation, value.target, value.level, value.tickSize, value.reviewedAt].every(finite)
    && [value.trigger, value.invalidation, value.target, value.level, value.tickSize].every(v => v > 0)
    && value.trigger === plan.entry && value.invalidation === plan.stopLoss && value.target === plan.target
    && Date.parse(value.asOf) % step === 0 && value.reviewedAt >= Date.parse(value.asOf) + step && value.reviewedAt < Date.parse(value.asOf) + 2 * step
    && hasValidRewardRisk((plan.target - plan.entry) / (plan.entry - plan.stopLoss))
    && Number.isInteger(value.completedBars) && value.completedBars >= candleAgentRules.minimumBars
    && Array.isArray(value.checks) && value.checks.length === 6 && new Set(value.checks.map(c => c.code)).size === 6
    && ['CANDLE_HISTORY', 'CANDLE_FRESHNESS', 'CANDLE_CONTRACT', 'CANDLE_PATTERN', 'CANDLE_ENTRY_WINDOW', 'CANDLE_RISK'].every(code => value.checks.some(c => c.code === code && c.passed === true && typeof c.label === 'string' && typeof c.detail === 'string')))
}
