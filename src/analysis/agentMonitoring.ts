import type { PredictionPlan } from './earlyPrediction'
import type { PredictionRecord, PredictionStatus } from './predictionHistory'
import type { CommodityContract } from './commodities'
import { setupEntryDeadline } from './setupTiming'
import { candleIntervalMs } from './candleData'
import { defaultChartInterval, type chartIntervals, timeframeInfo } from './timeframes'
import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import type { AtmVwapSnapshot } from '../api/atmVwap'
import { completedCandles } from './candleData'
import { readTradeDiagnostics } from './tradeDecision'
import { diagnoseTradeEntry } from './tradeEntry'

export type TradeTransition = {
  instrument: string; contract?: string; recordId: string; from: PredictionStatus | 'NEW'; to: PredictionStatus
  observedAt: number; signalCandle: string; issuedAt: number; reason: string; quote?: number; quoteAt?: number; quoteSource?: 'LIVE' | 'CANDLE'
  entry: number; stop: number; target: number
}
const transitions: TradeTransition[] = []
/** Only observed state changes generate audit entries; quote-only updates and reloads do not. */
export function recordTradeTransitions(previous: PredictionRecord[], next: PredictionRecord[], now: number) {
  const before = new Map(previous.map(record => [record.id, record]))
  for (const record of next) {
    const old = before.get(record.id)
    const revalidated = record.status === 'PENDING' && old && (old.entry !== record.entry || old.stopLoss !== record.stopLoss || old.target !== record.target)
    if (old?.status === record.status && old.outcomeNote === record.outcomeNote && !revalidated) continue
    transitions.push({ instrument: record.instrument, contract: record.contract?.symbol, recordId: record.id,
      from: old?.status ?? 'NEW', to: record.status, observedAt: now, signalCandle: record.signalCandleTime,
      issuedAt: record.generatedAt, reason: `${revalidated ? 'Pending levels revalidated. ' : ''}${record.outcomeNote}`, quote: record.latestPrice, quoteAt: record.latestPriceAt, quoteSource: record.latestPriceSource,
      entry: record.entryPrice ?? record.entry, stop: record.stopLoss, target: record.target })
  }
  if (transitions.length > 400) transitions.splice(0, transitions.length - 400)
}
export function readTradeTransitions(instrument: string) {
  return transitions.filter(item => item.instrument === instrument).map(item => ({ ...item }))
}

/** One reviewable export of observed decisions and candle history. A current
 * ATM quote is explicitly separate from genuinely archived replay snapshots. */
export function buildAgentMonitoringExport({ instrument, candles, records, plan, tick, connected, now, contract, atmVwap, issuedAt }: {
  instrument: string; candles: AngelOneCandle[]; records: PredictionRecord[]; plan?: PredictionPlan; tick?: AngelOneStreamTick
  connected: boolean; now: number; contract?: CommodityContract; atmVwap?: AtmVwapSnapshot; issuedAt?: number
}) {
  const saved = records.filter(record => record.instrument === instrument)
  const safeContract = (value: CommodityContract) => ({ name: value.name, root: value.root, token: value.token, symbol: value.symbol, exchange: value.exchange,
    exchangeType: value.exchangeType, expiry: value.expiry, expiresAt: value.expiresAt, tickSize: value.tickSize, lotSize: value.lotSize })
  const safePlan = (value: PredictionPlan) => ({ id: value.id, instrument: value.instrument, interval: value.interval, side: value.side, stage: value.stage,
    generatedAt: value.generatedAt, expiresAt: value.expiresAt, signalCandleTime: value.signalCandleTime, entry: value.entry, stopLoss: value.stopLoss,
    target: value.target, riskReward: value.riskReward, confirmationSnapshot: value.confirmationSnapshot, candleConfirmation: value.candleConfirmation, strategyVersion: value.strategyVersion, ...(value.contract ? { contract: safeContract(value.contract) } : {}) })
  const leg = (value: AtmVwapSnapshot['ce']) => ({ symbol: value.symbol, token: value.token, exchange: value.exchange, close: value.close,
    vwap: value.vwap, volume: value.volume, asOf: value.asOf, priceAsOf: value.priceAsOf, coverage: value.coverage })
  return { version: 3, kind: 'AGENT_MONITORING', generatedAt: new Date(now).toISOString(), instrument, interval: 'FIVE_MINUTE',
    ...(contract ? { contract: safeContract(contract) } : {}),
    candles: completedCandles(candles, 'FIVE_MINUTE', now).slice(-5000),
    assessments: readTradeDiagnostics(instrument), tradeTransitions: readTradeTransitions(instrument),
    records: saved.map(record => ({ ...safePlan(record), status: record.status, entryAt: record.entryAt, entryPrice: record.entryPrice,
      exitAt: record.exitAt, exitPrice: record.exitPrice, outcomeNote: record.outcomeNote, protection: record.protection, targetPolicy: record.targetPolicy, targetManagement: record.targetManagement })),
    current: { connected, quote: tick ? { token: tick.token, exchangeType: tick.exchangeType, ltp: tick.ltp, timestamp: tick.timestamp } : null,
      plan: plan ? safePlan(plan) : null, entry: diagnoseTradeEntry(plan, tick, connected, now, saved.some(record => record.status === 'ACTIVE'), issuedAt),
      atmVwap: atmVwap ? { index: atmVwap.index, strike: atmVwap.strike, expiry: atmVwap.expiry, fetchedAt: atmVwap.fetchedAt,
        referenceIndexPrice: atmVwap.referenceIndexPrice, method: atmVwap.method, ce: leg(atmVwap.ce), pe: leg(atmVwap.pe) } : null },
    limitations: ['Assessments and transitions are actual in-memory observations from this page session; missing observations are not reconstructed.',
      'Candlestick-only confirmation uses five-minute OHLC; archived policies may require their own historical context. Current quotes cannot invent past fills.',
      'Candle replay uses fixed-target comparison exits; it does not validate live tick TSL or option-premium returns.'] }
}

/** Objective time remaining, not a probability or an extra technical vote. */
export function signalFreshness(plan: PredictionPlan, now: number, issuedAt = plan.generatedAt) {
  const closedAt = Date.parse(plan.signalCandleTime) + candleIntervalMs(plan.interval), deadline = setupEntryDeadline(plan)
  const duration = deadline - closedAt
  if (![now, closedAt, deadline, issuedAt].every(Number.isFinite) || duration <= 0 || now < closedAt || now < issuedAt) return undefined
  return { closedAt, issuedAt, ageSeconds: Math.floor((now - issuedAt) / 1000), remainingSeconds: Math.max(0, Math.ceil((deadline - now) / 1000)),
    remainingPercent: Math.max(0, Math.min(100, (deadline - now) / duration * 100)), deadline }
}

/** Operational reminder based on actual resolved expiry; no delivery-period guess. */
export function contractExpiryNotice(contract: CommodityContract | undefined, now: number, front?: CommodityContract) {
  if (!contract || !Number.isFinite(now) || !Number.isFinite(contract.expiresAt)) return undefined
  if (now >= contract.expiresAt) return `${contract.symbol} has expired. New setups require the newly resolved contract; an existing trade keeps its own recorded contract.`
  if (front && front.name === contract.name && front.token !== contract.token) return `Chart contract ${front.symbol}; the open trade remains on ${contract.symbol}. Quotes and exits stay tied to the held contract.`
  const date = (time: number) => Math.floor((time + 330 * 60_000) / 86_400_000)
  const days = date(contract.expiresAt) - date(now)
  return days <= 3 ? `${contract.symbol} expires ${days === 0 ? 'today' : `in ${days} calendar day${days === 1 ? '' : 's'}`} (${contract.expiry}). Contract selection rolls after expiry; held positions are never migrated automatically.` : undefined
}

type Outcome = { at: number; r: number; session: string }
/** Descriptive underlying/futures tracking only. Does not change thresholds or open/close positions. */
export function trackedPerformance(records: PredictionRecord[], instrument: string, now: number, interval: typeof chartIntervals[number] = defaultChartInterval, strategyVersion = 'technical-v2') {
  const matching = records.filter(record => record.instrument === instrument && record.strategyVersion === strategyVersion && record.interval === interval)
  const outcomes: Outcome[] = matching.flatMap(record => {
    const risk = Math.abs((record.entryPrice ?? NaN) - record.stopLoss)
    if (record.stage !== 'CONFIRMED' || !['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(record.status)
      || !Number.isFinite(record.points) || !Number.isFinite(record.entryAt) || !Number.isFinite(record.exitAt) || record.exitAt! > now || record.exitAt! < record.entryAt! || !(risk > 0)) return []
    return [{ at: record.exitAt!, r: record.points! / risk, session: new Date(record.exitAt! + 330 * 60_000).toISOString().slice(0, 10) }]
  }).sort((a, b) => b.at - a.at).slice(0, 40)
  const recent = outcomes.slice(0, 10), baseline = outcomes.slice(10, 20)
  const mean = (items: Outcome[]) => items.length ? items.reduce((sum, item) => sum + item.r, 0) / items.length : undefined
  const recentR = mean(recent), baselineR = mean(baseline)
  let lossStreak = 0
  for (const outcome of outcomes) { if (outcome.r >= 0) break; lossStreak++ }
  const sessions = new Set(outcomes.slice(0, 20).map(item => item.session)).size
  const ready = recent.length === 10 && baseline.length === 10 && sessions >= 3
  // Visible fixed review thresholds, not a statistical model-degradation claim.
  const review = ready && (lossStreak >= 5 || recentR! <= baselineR! - 1)
  return { state: !ready ? 'INSUFFICIENT_HISTORY' as const : review ? 'REVIEW' as const : 'OBSERVING' as const,
    samples: outcomes.length, sessions, recentCount: recent.length, baselineCount: baseline.length, recentR, baselineR, lossStreak,
    excluded: matching.filter(record => ['AMBIGUOUS', 'UNVERIFIED'].includes(record.status)).length,
    reason: !ready ? `Comparison needs 20 settled ${timeframeInfo[interval].label} trades across at least 3 IST sessions.` : review ? 'Review recent results: at least 5 consecutive losses or recent mean return is at least 1R below the preceding ten trades.' : 'Recent tracked returns remain within the configured review thresholds.' }
}
