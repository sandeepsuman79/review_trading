import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionAnalysis } from './priceAction'
import type { TradingEvidence } from './tradingEvidence'
import { candleIntervalMs } from './candleData'
import { candleSession } from './vwap'

export type TradeReasonCode = 'INSUFFICIENT_CANDLES' | 'STALE_DATA' | 'SESSION_DATA_GAP' | 'INDICATOR_NOT_READY' | 'NO_DIRECTIONAL_ROUTE' | 'SCORE_BELOW_THRESHOLD' | 'DIRECTIONAL_LEAD_TOO_SMALL' | 'TECHNICAL_COVERAGE_LOW' | 'NO_CONFIRMED_PATTERN' | 'ATR_INVALID' | 'TRADE_LEVELS_INVALID' | 'RR_BELOW_MINIMUM' | 'OUTSIDE_ENTRY_WINDOW' | 'ENTRY_NOT_REACHED' | 'LIVE_STREAM_DISCONNECTED' | 'QUOTE_STALE' | 'QUOTE_BEFORE_SIGNAL' | 'SETUP_NOT_CONFIRMED' | 'TRADE_ALREADY_OPEN'
export type DecisionCheck = { code: TradeReasonCode; label: string; status: 'PASS' | 'FAIL' | 'NOT_CHECKED'; detail: string }
export type CandidateDecision = {
  side: 'CALL' | 'PUT'; state: 'EARLY' | 'CONFIRMED' | 'RISKY' | 'REJECTED' | 'WAIT'; quality?: 'STANDARD' | 'STRONG'
  supportScore: number; opposingScore: number; lead: number; coverage: number; requiredScore: number; requiredGap: number
  setup: string; pattern: string; routes: string[]; entry?: number; stopLoss?: number; target?: number; riskReward?: number
  checks: DecisionCheck[]; reasons: TradeReasonCode[]
}

/** New entries end at 15:25 IST; this gate never stops management of an open trade. */
export function withinEntryWindow(now: number) {
  if (!Number.isFinite(now)) return false
  const time = new Date(now + 330 * 60_000), minutes = time.getUTCHours() * 60 + time.getUTCMinutes()
  return minutes >= 555 && minutes < 925
}

export function buildCandidateDecision(analysis: PriceActionAnalysis, evidence: TradingEvidence, side: 'CALL' | 'PUT', candles: AngelOneCandle[], now: number, early: { earlyCandles: number; earlyCoverage: number; earlyScore: number; earlyGap: number }): CandidateDecision {
  const supportScore = side === 'CALL' ? evidence.bullishScore : evidence.bearishScore
  const opposingScore = side === 'CALL' ? evidence.bearishScore : evidence.bullishScore
  const lead = Math.round((supportScore - opposingScore) * 10) / 10
  const routes = Date.parse(analysis.alignment?.at ?? '') === Date.parse(analysis.latestCandleTime ?? '') ? analysis.alignment?.routes.filter(route => route.side === side).map(route => route.name) ?? [] : []
  const previous = candles[candles.length - 2], latest = candles[candles.length - 1]
  const consecutive = Boolean(previous && latest && Date.parse(latest[0]) - Date.parse(previous[0]) === candleIntervalMs(evidence.interval) && candleSession(previous[0]) === candleSession(latest[0]) && candleSession(latest[0]) === candleSession(new Date(now).toISOString()))
  const fresh = evidence.checks?.find(check => check.label === 'Recent completed candles')?.passed === true
  const warm = evidence.checks?.find(check => check.label === 'Indicator warmup')?.passed === true
  const atr = evidence.atr14 !== undefined && Number.isFinite(evidence.atr14) && evidence.atr14 > 0
  const pattern = analysis.side === side && analysis.pattern !== 'NO_CONFIRMED_PATTERN'
  const d = side === 'CALL' ? 1 : -1, entry = pattern ? Math.round((analysis.entry ?? NaN) * 100) / 100 : undefined
  const stopLoss = pattern ? evidence.stopLoss : undefined, target = pattern ? Math.round((analysis.target ?? NaN) * 100) / 100 : undefined
  const levels = [entry, stopLoss, target].every(value => value !== undefined && Number.isFinite(value) && value > 0) && d * (entry! - stopLoss!) > 0 && d * (target! - entry!) > 0
  const riskReward = levels ? d * (target! - entry!) / (d * (entry! - stopLoss!)) : undefined
  const checks: DecisionCheck[] = []
  const add = (code: TradeReasonCode, label: string, pass: boolean, detail: string, checked = true) => checks.push({ code, label, status: !checked ? 'NOT_CHECKED' : pass ? 'PASS' : 'FAIL', detail })
  add('INSUFFICIENT_CANDLES', 'Initial analysis', candles.length >= early.earlyCandles, `${candles.length} completed candles / ${early.earlyCandles} for initial analysis; 50 for full scoring`)
  add('STALE_DATA', 'Data freshness', fresh, 'Latest completed candle must match the current chart and remain within its confirmation interval')
  add('SESSION_DATA_GAP', 'Session continuity', consecutive, 'Consecutive completed bars from the current IST session')
  add('OUTSIDE_ENTRY_WINDOW', 'Entry window', withinEntryWindow(now), '09:15–15:25 IST; open trades remain monitored')
  add('INDICATOR_NOT_READY', 'Full indicator readiness', warm, '50 completed candles and available EMA20/50, RSI/momentum and Supertrend')
  add('ATR_INVALID', 'ATR(14)', atr, atr ? `${evidence.atr14!.toFixed(2)} points` : 'Current positive ATR required')
  add('NO_CONFIRMED_PATTERN', 'Price pattern', pattern, pattern ? analysis.setup : 'No completed price setup detected for this direction')
  add('NO_DIRECTIONAL_ROUTE', 'Directional route', routes.length > 0, routes.join(' or ') || 'No EMA, Supertrend or level route in this direction')
  add('TECHNICAL_COVERAGE_LOW', 'Full technical coverage', evidence.coverage >= 70, `${evidence.coverage}% / 70% full, ${early.earlyCoverage}% early; missing weights stay missing`)
  add('SCORE_BELOW_THRESHOLD', 'Supporting score', supportScore >= evidence.requiredScore, `${supportScore}/100 / ${evidence.requiredScore} required`)
  add('DIRECTIONAL_LEAD_TOO_SMALL', 'Directional lead', lead >= evidence.requiredGap, `${lead} points / ${evidence.requiredGap} required`)
  add('TRADE_LEVELS_INVALID', 'Trade levels', levels, 'Positive entry, ATR-adjusted stop and target on the correct sides', pattern)
  add('RR_BELOW_MINIMUM', 'Reward/risk', riskReward !== undefined && riskReward >= 1.5, riskReward !== undefined ? `${riskReward.toFixed(2)}:1 / 1.50:1 required` : 'No validated trade levels', pattern && levels)
  const hardReady = fresh && consecutive && withinEntryWindow(now) && atr && candles.length >= early.earlyCandles
  const initialIndicators = [analysis.exponentialMovingAverage20, analysis.rsi14, analysis.rsi14Momentum].every(value => value !== undefined && Number.isFinite(value)) && Boolean(analysis.supertrendDirection)
  const earlyReady = hardReady && initialIndicators && routes.length > 0 && evidence.coverage >= early.earlyCoverage && supportScore >= Math.max(early.earlyScore, evidence.requiredScore) && lead >= Math.max(early.earlyGap, evidence.requiredGap)
  const state = pattern && evidence.canConfirm ? 'CONFIRMED' : hardReady && evidence.riskySetup?.side === side ? 'RISKY' : earlyReady ? 'EARLY' : pattern || routes.length > 0 ? 'REJECTED' : 'WAIT'
  return { side, state, quality: state === 'CONFIRMED' ? evidence.quality : undefined, supportScore, opposingScore, lead, coverage: evidence.coverage, requiredScore: evidence.requiredScore, requiredGap: evidence.requiredGap,
    setup: pattern ? analysis.setup : 'No completed setup', pattern: pattern ? analysis.pattern : 'NO_CONFIRMED_PATTERN', routes,
    entry: levels ? entry : undefined, stopLoss: levels ? stopLoss : undefined, target: levels ? target : undefined, riskReward,
    checks, reasons: checks.filter(check => check.status === 'FAIL').map(check => check.code) }
}

type DiagnosticSnapshot = { instrument: string; interval: string; candle?: string; evaluatedAt: string; decisions: CandidateDecision[] }
const audit: DiagnosticSnapshot[] = [], fingerprints = new Map<string, string>()
/** Bounded memory log, deduplicated across heartbeats; no synchronous storage writes. */
export function recordTradeDiagnostics(instrument: string, interval: string, candle: string | undefined, now: number, decisions: CandidateDecision[]) {
  const key = `${instrument}:${interval}`, fingerprint = JSON.stringify({ candle, decisions })
  if (fingerprints.get(key) === fingerprint) return
  fingerprints.set(key, fingerprint)
  audit.push({ instrument, interval, candle, evaluatedAt: new Date(now).toISOString(), decisions })
  if (audit.length > 400) audit.shift()
}
export function readTradeDiagnostics(instrument?: string) {
  return audit.filter(item => !instrument || item.instrument === instrument).map(item => ({ ...item, decisions: item.decisions.map(decision => ({ ...decision, checks: decision.checks.map(check => ({ ...check })), reasons: [...decision.reasons], routes: [...decision.routes] })) }))
}
