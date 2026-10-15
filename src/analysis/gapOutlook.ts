import type { AngelOneCandle } from '../api/angelOne'
import type { PriceActionAnalysis } from './priceAction'
import type { TradingEvidence } from './tradingEvidence'
import { gapOutlookMinute, tradingSession } from './tradingSession'

export type GapOutlook = {
  version: 1; instrument: string; session: string; generatedAt: number; asOf: string
  bias: 'GAP_UP_BIAS' | 'GAP_DOWN_BIAS' | 'MIXED'
  evidenceScore: number; coverage: number; referencePrice: number
  technicalLead: number; sentimentLead?: number
  reasons: string[]; missing: string[]
}
export const gapOutlookKey = (instrument: string) => `traders_gap_outlook_v1_${instrument}`
const instruments = ['Nifty 50', 'Sensex', 'Bank Nifty']

/** One pre-close heuristic snapshot; never a confirmed trade or an overnight probability. */
export function buildGapOutlook(instrument: string, candles: AngelOneCandle[], analysis: PriceActionAnalysis, evidence: TradingEvidence, now: number): GapOutlook | undefined {
  const session = tradingSession(now), cutoff = session.start + gapOutlookMinute * 60_000
  // Only the live 15:00 minute may create a snapshot. Later data cannot rewrite history.
  if (!session.weekday || now < cutoff || now >= cutoff + 60_000 || !instruments.includes(instrument) || evidence.instrument !== instrument || evidence.interval !== 'ONE_MINUTE' || evidence.coverage < 70 || candles.length < 50) return undefined
  if (![evidence.bullishScore, evidence.bearishScore, evidence.coverage, evidence.sentiment.bullishScore, evidence.sentiment.bearishScore, evidence.sentiment.coverage].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) return undefined
  const latest = candles[candles.length - 1], tail = candles.slice(-30)
  if (!latest || Date.parse(latest[0]) !== cutoff - 60_000 || Date.parse(analysis.latestCandleTime ?? '') !== cutoff - 60_000 || Date.parse(evidence.asOf ?? '') !== cutoff - 60_000
    || !evidence.checks?.some(check => check.label === 'Indicator warmup' && check.passed)
    || !tail.every((bar, i) => tradingSession(Date.parse(bar[0])).date === session.date && (i === 0 || Date.parse(bar[0]) - Date.parse(tail[i - 1][0]) === 60_000))) return undefined
  const technicalLead = evidence.bullishScore - evidence.bearishScore
  const sentiment = evidence.sentiment
  const sentimentLead = sentiment.bias === 'UNAVAILABLE' ? undefined : sentiment.bullishScore - sentiment.bearishScore
  // Missing sentiment retains its 40% budget instead of amplifying intraday technicals.
  const evidenceScore = Math.round((.6 * technicalLead + .4 * (sentimentLead ?? 0)) * 10) / 10
  const coverage = Math.round((.6 * evidence.coverage + .4 * sentiment.coverage) * 10) / 10
  const bias = coverage >= 60 && sentimentLead !== undefined && Math.abs(evidenceScore) >= 15
    ? evidenceScore > 0 ? 'GAP_UP_BIAS' : 'GAP_DOWN_BIAS' : 'MIXED'
  const change = latest[4] - tail[0][1]
  const reasons = [
    `Technical evidence: bullish ${evidence.bullishScore.toFixed(1)} / bearish ${evidence.bearishScore.toFixed(1)}.`,
    `Last 30 minutes: ${change >= 0 ? '+' : ''}${change.toFixed(2)} index points.`,
    `Structure: ${analysis.structure ?? 'Unavailable'} · ${analysis.setup}.`,
    sentimentLead === undefined ? 'Market sentiment is unavailable; no directional gap bias is issued.' : `Market sentiment: ${sentiment.bias.toLowerCase()} · ${sentiment.bullishScore.toFixed(1)} bullish / ${sentiment.bearishScore.toFixed(1)} bearish.`,
  ]
  if (evidence.indiaVix) reasons.push(`India VIX ${evidence.indiaVix.price.toFixed(2)}: volatility reference, not gap direction.`)
  return { version: 1, instrument, session: session.date, generatedAt: now, asOf: latest[0], bias, evidenceScore, coverage,
    referencePrice: latest[4], technicalLead, ...(sentimentLead === undefined ? {} : { sentimentLead }), reasons,
    missing: [...evidence.missing, ...sentiment.missing].slice(0, 12) }
}

export function readGapOutlook(storage: Pick<Storage, 'getItem'>, instrument: string): GapOutlook | undefined {
  const raw = storage.getItem(gapOutlookKey(instrument))
  if (raw === null) return undefined
  const data = JSON.parse(raw) as GapOutlook
  if (!data || data.version !== 1 || data.instrument !== instrument || !['GAP_UP_BIAS', 'GAP_DOWN_BIAS', 'MIXED'].includes(data.bias)
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.session) || ![data.generatedAt, data.evidenceScore, data.coverage, data.referencePrice, data.technicalLead].every(Number.isFinite)
    || data.referencePrice <= 0 || data.coverage < 0 || data.coverage > 100 || Math.abs(data.evidenceScore) > 100 || Math.abs(data.technicalLead) > 100
    || data.sentimentLead !== undefined && (!Number.isFinite(data.sentimentLead) || Math.abs(data.sentimentLead) > 100) || !Number.isFinite(Date.parse(data.asOf))
    || !Array.isArray(data.reasons) || !data.reasons.every(item => typeof item === 'string') || !Array.isArray(data.missing) || !data.missing.every(item => typeof item === 'string')) throw new Error('Saved gap outlook is invalid. Existing data was preserved.')
  const session = tradingSession(data.generatedAt), cutoff = session.start + gapOutlookMinute * 60_000
  if (!session.weekday || session.date !== data.session || data.generatedAt < cutoff || data.generatedAt >= cutoff + 60_000 || Date.parse(data.asOf) !== cutoff - 60_000) throw new Error('Saved gap outlook timestamp is invalid. Existing data was preserved.')
  return data
}
