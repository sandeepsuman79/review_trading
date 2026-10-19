import type { AngelOneCandle } from '../api/angelOne'
import { analyzePriceAction } from './priceAction'
import { analyzeTradingEvidence, tradingEvidenceRules } from './tradingEvidence'
import { buildEarlyPrediction, type PredictionPlan } from './earlyPrediction'
import { isCommodity, validCommodityContract, type CommodityContract } from './commodities'
import { inTradingEntryWindow, squareOffTime, tradingSession } from './tradingSession'

const duration = 300_000
export const replayLimits = { candles: 5000, lookback: 1000, warmup: 50 } as const
const instruments = ['Nifty 50', 'Sensex', 'Bank Nifty', 'Natural Gas', 'Crude Oil', 'Silver', 'Gold']
export type ReplayInput = { instrument: string; interval?: 'FIVE_MINUTE'; candles: AngelOneCandle[]; contract?: CommodityContract; costs?: { slippagePointsPerSide?: number; roundTripCostPoints?: number } }
export type ReplayEvaluation = { instrument: string; contract?: CommodityContract; candles: AngelOneCandle[]; now: number }
/** Injection is for deterministic engine tests only; the CLI always uses the real strategy. */
export type ReplayEvaluator = (input: ReplayEvaluation) => PredictionPlan | undefined
export type ReplayOutcome = 'TARGET' | 'STOP' | 'SQUARE_OFF' | 'AMBIGUOUS' | 'DATA_GAP' | 'END_OF_DATA'
export type ReplayTrade = { signalId: string; side: 'CALL' | 'PUT'; signalCandleTime: string; entryTime: string; entry: number; stop: number; target: number; risk: number; outcome: ReplayOutcome; exitTime?: string; exit?: number; grossPoints?: number; netPoints?: number; netR?: number; note: string }
const round = (value: number) => Math.round(value * 1e8) / 1e8

/** No public context is injected: today's OI/news/VIX cannot be replayed into the past. */
export const evaluateReplaySetup: ReplayEvaluator = ({ instrument, contract, candles, now }) => {
  const analysis = analyzePriceAction(candles, 'FIVE_MINUTE', now, instrument)
  const evidence = analyzeTradingEvidence({ analysis, candles, instrument, interval: 'FIVE_MINUTE', now })
  const result = buildEarlyPrediction(analysis, instrument, 'FIVE_MINUTE', now, undefined, undefined, evidence, contract)
  return result.side !== 'WAIT' && result.plan.stage === 'CONFIRMED' ? result.plan : undefined
}

function validate(input: ReplayInput) {
  if (!input || !instruments.includes(input.instrument)) throw new Error('Choose one of the seven supported instruments.')
  if (input.interval !== undefined && input.interval !== 'FIVE_MINUTE') throw new Error('Replay accepts FIVE_MINUTE candles only.')
  if (!Array.isArray(input.candles) || input.candles.length > replayLimits.candles) throw new Error(`Provide at most ${replayLimits.candles} candles per replay.`)
  if (isCommodity(input.instrument) ? !validCommodityContract(input.contract, input.instrument) : input.contract !== undefined) throw new Error('Commodity candles require one exact valid MCX contract; index candles must not carry an MCX contract.')
  let previous = -Infinity, minimumPrice = Infinity
  for (const row of input.candles) {
    const time = Array.isArray(row) && typeof row[0] === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(row[0]) ? Date.parse(row[0]) : NaN
    if (!Array.isArray(row) || row.length !== 6 || !Number.isFinite(time) || time % duration || time <= previous || !row.slice(1).every(value => typeof value === 'number' && Number.isFinite(value)) || row.slice(1, 5).some(value => value as number <= 0) || row[5] < 0 || row[2] < Math.max(row[1], row[4]) || row[3] > Math.min(row[1], row[4]) || row[2] < row[3]) throw new Error('Candles must be ordered unique, timezone-qualified 5-minute OHLCV rows with positive prices and nonnegative volume.')
    if (input.contract && time + duration > input.contract.expiresAt) throw new Error('Candles exceed the supplied MCX contract expiry; replay contracts separately.')
    minimumPrice = Math.min(minimumPrice, row[3])
    previous = time
  }
  for (const value of [input.costs?.slippagePointsPerSide, input.costs?.roundTripCostPoints]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('Slippage and costs must be finite nonnegative price points.')
  if ((input.costs?.slippagePointsPerSide ?? 0) >= minimumPrice) throw new Error('Per-side slippage must be smaller than the minimum observed price.')
}

/** Bounded chronological OHLC simulation, deliberately distinct from the live tick ledger. */
export function replayStrategy(input: ReplayInput, evaluator: ReplayEvaluator = evaluateReplaySetup) {
  validate(input)
  const slippage = input.costs?.slippagePointsPerSide ?? 0, costs = input.costs?.roundTripCostPoints ?? 0
  const trades: ReplayTrade[] = [], rejected: Record<string, number> = {}, signalIds = new Set<string>()
  let active: ReplayTrade | undefined, pending: PredictionPlan | undefined, blockedSession: string | undefined, evaluations = 0, candidates = 0
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1 }
  const finish = (outcome: ReplayOutcome, note: string, time?: number, observedExit?: number) => {
    if (!active) return
    active.outcome = outcome; active.note = note
    if (outcome === 'DATA_GAP') blockedSession = tradingSession(Date.parse(active.entryTime)).date
    if (time !== undefined) active.exitTime = new Date(time).toISOString()
    if (observedExit !== undefined) {
      const d = active.side === 'CALL' ? 1 : -1
      active.exit = round(observedExit - d * slippage)
      active.grossPoints = round(d * (active.exit - active.entry))
      active.netPoints = round(active.grossPoints - costs)
      active.netR = round(active.netPoints / active.risk)
    }
    active = undefined
  }
  for (let i = 0; i < input.candles.length; i++) {
    const row = input.candles[i], time = Date.parse(row[0]), previous = input.candles[i - 1]
    const contiguous = previous && time === Date.parse(previous[0]) + duration && tradingSession(time).date === tradingSession(Date.parse(previous[0])).date
    if (active && !contiguous) finish('DATA_GAP', 'Missing observation or session boundary: intrabar exits and square-off cannot be recovered.', time)
    if (pending) {
      const plan = pending, d = plan.side === 'CALL' ? 1 : -1
      pending = undefined
      const entry = row[1] + d * slippage, risk = d * (entry - plan.stopLoss), reward = d * (plan.target - entry)
      if (active) reject('POSITION_ALREADY_OPEN')
      else if (!contiguous || time !== Date.parse(plan.signalCandleTime) + duration) reject('MISSING_NEXT_OPEN')
      else if (!inTradingEntryWindow(time, input.instrument) || time >= plan.expiresAt || time >= (input.contract?.expiresAt ?? Infinity)) reject('ENTRY_WINDOW_ENDED')
      else if (d * (row[1] - plan.entry) < 0) reject('TRIGGER_NOT_REACHED_AT_NEXT_OPEN')
      else if (!(risk > 0) || !(reward > 0) || reward / risk < tradingEvidenceRules.minimumRewardRisk) reject('NEXT_OPEN_RR_OR_LEVELS_INVALID')
      else {
        active = { signalId: plan.id, side: plan.side, signalCandleTime: plan.signalCandleTime, entryTime: row[0], entry: round(entry), stop: plan.stopLoss, target: plan.target, risk: round(risk), outcome: 'END_OF_DATA', note: 'No observed exit yet.' }
        trades.push(active)
      }
    }
    if (active) {
      const d = active.side === 'CALL' ? 1 : -1, cutoff = squareOffTime(time, input.instrument)
      if (time >= cutoff || !inTradingEntryWindow(time, input.instrument)) finish('DATA_GAP', 'No observed final session candle; a square-off fill is unknown.', time)
      else if (d * (row[1] - active.stop) <= 0) finish('STOP', 'Gap through stop: observed open plus adverse slippage.', time, row[1])
      else if (d * (row[1] - active.target) >= 0) finish('TARGET', 'Gap beyond target: capped at planned target plus adverse slippage.', time, active.target)
      else {
        const stopTouched = d === 1 ? row[3] <= active.stop : row[2] >= active.stop
        const targetTouched = d === 1 ? row[2] >= active.target : row[3] <= active.target
        if (stopTouched && targetTouched) finish('AMBIGUOUS', 'Both stop and target touched; OHLC cannot reveal ordering. Excluded from performance.', time + duration)
        else if (stopTouched) finish('STOP', 'Stop touched in observed candle; adverse slippage applied.', time + duration, active.stop)
        else if (targetTouched) finish('TARGET', 'Target touched in observed candle; adverse slippage applied.', time + duration, active.target)
        else if (time + duration === cutoff) finish('SQUARE_OFF', 'Scheduled cutoff uses the observed final candle close plus adverse slippage.', cutoff, row[4])
      }
    }
    const now = time + duration
    if (active || blockedSession === tradingSession(time).date || i + 1 < replayLimits.warmup || !inTradingEntryWindow(now, input.instrument) || now >= (input.contract?.expiresAt ?? Infinity)) continue
    // Every evaluation gets a separate prefix and rows: no evaluator sees the next open or future extrema.
    const candles = input.candles.slice(Math.max(0, i + 1 - replayLimits.lookback), i + 1).map(candle => [...candle] as AngelOneCandle)
    const plan = evaluator({ instrument: input.instrument, contract: input.contract, candles, now })
    evaluations++
    if (!plan) continue
    if (plan.stage !== 'CONFIRMED' || plan.strategyVersion !== 'technical-v2' || plan.instrument !== input.instrument || plan.interval !== 'FIVE_MINUTE' || Date.parse(plan.signalCandleTime) !== time || !Number.isFinite(plan.generatedAt) || !Number.isFinite(plan.expiresAt) || plan.generatedAt > now || plan.expiresAt <= now || !['CALL', 'PUT'].includes(plan.side) || ![plan.entry, plan.stopLoss, plan.target].every(value => Number.isFinite(value) && value > 0) || (input.contract ? plan.contract?.token !== input.contract.token || plan.contract?.symbol !== input.contract.symbol || plan.contract?.expiresAt !== input.contract.expiresAt : plan.contract !== undefined)) { reject('INVALID_OR_MISMATCHED_PLAN'); continue }
    if (signalIds.has(plan.id)) continue
    signalIds.add(plan.id); candidates++; pending = plan
  }
  if (pending) reject('NO_NEXT_OPEN')
  if (active) finish('END_OF_DATA', 'Input ended with an open position; unrealised outcome excluded.')
  const resolved = trades.filter(trade => trade.netR !== undefined), total = (key: 'netPoints' | 'grossPoints' | 'netR') => round(resolved.reduce((sum, trade) => sum + trade[key]!, 0))
  let points = 0, r = 0, peakPoints = 0, peakR = 0, drawdownPoints = 0, drawdownR = 0
  for (const trade of resolved) { points += trade.netPoints!; r += trade.netR!; peakPoints = Math.max(peakPoints, points); peakR = Math.max(peakR, r); drawdownPoints = Math.max(drawdownPoints, peakPoints - points); drawdownR = Math.max(drawdownR, peakR - r) }
  return {
    version: 'offline-candle-replay-v1' as const, instrument: input.instrument, contract: input.contract, interval: 'FIVE_MINUTE',
    data: { candles: input.candles.length, first: input.candles[0]?.[0], last: input.candles[input.candles.length - 1]?.[0], evaluations, maximumLookback: replayLimits.lookback },
    assumptions: { entry: 'Immediate next observed 5-minute open only, trigger reached, same session, with actual-open reward/risk >= 1.5. No intrabar trigger fills.', slippagePointsPerSide: slippage, roundTripCostPoints: costs, costsAreUserSupplied: true, defaultCostsAreZero: slippage === 0 && costs === 0, strategy: evaluator === evaluateReplaySetup ? 'Current technical rules, without archived contextual snapshots' : 'Injected test evaluator; not a strategy accuracy result', missingContext: ['Historical OI/PCR', 'Historical India VIX', 'Historical news, institutional flows and global quotes', 'Paired ATM option VWAP'], unsupported: ['Minute/tick protective exits, trailing stops and live quote latency', 'Broker execution, bid/ask spread, liquidity, taxes unless supplied as point costs', 'Exchange holiday/special-session calendar; configured weekday sessions are used', 'Option premium or rupee P/L; results are underlying/futures price points'], ambiguity: 'Dual-touch, data gaps and open positions excluded from resolved metrics. Intrabar exit timestamps use candle close, not an invented tick time.' },
    summary: { candidates, entered: trades.length, resolved: resolved.length, excluded: trades.length - resolved.length, wins: resolved.filter(trade => trade.netPoints! > 0).length, losses: resolved.filter(trade => trade.netPoints! < 0).length, winRate: resolved.length ? round(resolved.filter(trade => trade.netPoints! > 0).length / resolved.length) : null, grossPoints: total('grossPoints'), netPoints: total('netPoints'), netR: total('netR'), maximumRealisedDrawdownPoints: round(drawdownPoints), maximumRealisedDrawdownR: round(drawdownR) },
    warnings: [input.candles.length < replayLimits.warmup ? 'Insufficient history: at least 50 completed candles are required.' : 'Historical signals are evaluated without historical contextual feeds; this can differ from the deployed agent.', 'This is a deterministic simulation, not observed fills or established profitability. Unknown outcomes are excluded and may bias resolved-only metrics.'], rejected, trades,
  }
}
