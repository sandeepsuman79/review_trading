import type { TradingEvidence } from './tradingEvidence'
import { gapOutlookMinute, tradingSession } from './tradingSession'
import { timeframeInfo } from './timeframes'

const gapAnalysisInterval = 'FIVE_MINUTE' as const

export const gapOutlookThresholds = { minimumCoverage: 60, minimumLead: 15 }
export type GapInputSummary = { name: string; bullish: number; bearish: number; coverage: number }
export type GapOutlook = {
  inputs?: GapInputSummary[]; bullishScore?: number; bearishScore?: number;
  version: 1 | 2; expiresAt?: number; instrument: string; session: string; generatedAt: number; asOf: string
  bias: 'GAP_UP_BIAS' | 'GAP_DOWN_BIAS' | 'MIXED'
  evidenceScore: number; coverage: number; referencePrice?: number
  technicalLead: number; sentimentLead?: number
  reasons: string[]; missing: string[]
}
export const gapOutlookKey = (instrument: string) => `traders_gap_outlook_v1_${instrument}`
const instruments = ['Nifty 50', 'Sensex', 'Bank Nifty']

/** Latest weekday's outlook is live from 15:00 until the following weekday open. */
export function gapOutlookWindow(now: number) {
  if (!Number.isFinite(now)) return undefined
  let session = tradingSession(now)
  if (session.weekday && session.minute >= 555 && session.minute < gapOutlookMinute) return undefined
  if (!session.weekday || session.minute < gapOutlookMinute) {
    do { session = tradingSession(session.start - 1) } while (!session.weekday)
  }
  let next = tradingSession(session.start + 86400000)
  while (!next.weekday) next = tradingSession(next.start + 86400000)
  return { ...session, expiresAt: next.start + 555 * 60000 }
}

/** External-input outlook after 15:00; no completed index chart is required. */
export function buildGapOutlook(instrument: string, evidence: Pick<TradingEvidence, 'instrument' | 'sentiment'>, now: number): GapOutlook | undefined {
  const session = gapOutlookWindow(now)
  if (!session || !instruments.includes(instrument) || evidence.instrument !== instrument) return undefined
  const sentiment = evidence.sentiment
  if (!sentiment || ![sentiment.bullishScore, sentiment.bearishScore, sentiment.coverage].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) return undefined
  // Older assessments may contain PCR; exclude its contribution without
  // increasing the other inputs' weights. Current equity context already assigns it zero.
  const pcr = (sentiment.layers ?? []).filter(layer => layer.key === 'pcr' || /\bpcr\b/i.test(layer.name))
  const layers = (sentiment.layers ?? []).filter(layer => !pcr.includes(layer))
  const bullishScore = Math.max(0, sentiment.bullishScore - pcr.reduce((sum, layer) => sum + layer.bullish, 0))
  const bearishScore = Math.max(0, sentiment.bearishScore - pcr.reduce((sum, layer) => sum + layer.bearish, 0))
  const sentimentLead = sentiment.bias === 'UNAVAILABLE' ? undefined : bullishScore - bearishScore
  const evidenceScore = Math.round((sentimentLead ?? 0) * 10) / 10
  const coverage = Math.round(Math.max(0, sentiment.coverage - pcr.reduce((sum, layer) => sum + (layer.weight ?? 10) * layer.coverage, 0)) * 10) / 10
  const bias = coverage >= gapOutlookThresholds.minimumCoverage && sentimentLead !== undefined && Math.abs(evidenceScore) >= gapOutlookThresholds.minimumLead
    ? evidenceScore > 0 ? 'GAP_UP_BIAS' : 'GAP_DOWN_BIAS' : 'MIXED'
  const reasons = [
    'External-input outlook: FII/DII 40%, GIFT Nifty 30%, global markets 15% and assessed news 15%. Index chart completion is not required.',
    sentimentLead === undefined ? 'Current external evidence is insufficient; no directional gap bias is issued.' : `External evidence: ${bullishScore.toFixed(1)} bullish / ${bearishScore.toFixed(1)} bearish.`,
  ]
  for (const layer of layers) reasons.push(`${layer.name}: ${layer.bullish.toFixed(1)} bullish / ${layer.bearish.toFixed(1)} bearish · ${(layer.coverage * 100).toFixed(0)}% available. ${layer.details.join(' · ')}`)
  reasons.push('Source publication and observation times determine freshness. New events can revise the outlook; missing inputs earn no directional points.')
  const inputs = layers.map(({ key, name, bullish, bearish, coverage }) => ({ name: key === 'global' ? 'Global markets' : name, bullish, bearish, coverage: Math.min(100, Math.max(0, coverage * 100)) }))
  return { inputs, bullishScore, bearishScore, version: 2, expiresAt: session.expiresAt, instrument, session: session.date, generatedAt: now, asOf: new Date(now).toISOString(), bias, evidenceScore, coverage,
    technicalLead: 0, ...(sentimentLead === undefined ? {} : { sentimentLead }), reasons, missing: sentiment.missing.filter(item => !/\bpcr\b/i.test(item)).slice(0, 20) }
}

export function readGapOutlook(storage: Pick<Storage, 'getItem'>, instrument: string): GapOutlook | undefined {
  const raw = storage.getItem(gapOutlookKey(instrument))
  if (raw === null) return undefined
  const data = JSON.parse(raw) as GapOutlook
  if (!data || ![1, 2].includes(data.version) || data.instrument !== instrument || !['GAP_UP_BIAS', 'GAP_DOWN_BIAS', 'MIXED'].includes(data.bias)
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.session) || ![data.generatedAt, data.evidenceScore, data.coverage, data.technicalLead].every(Number.isFinite)
    || (data.referencePrice !== undefined && (!Number.isFinite(data.referencePrice) || data.referencePrice <= 0)) || data.coverage < 0 || data.coverage > 100 || Math.abs(data.evidenceScore) > 100 || Math.abs(data.technicalLead) > 100
    || data.sentimentLead !== undefined && (!Number.isFinite(data.sentimentLead) || Math.abs(data.sentimentLead) > 100) || !Number.isFinite(Date.parse(data.asOf))
    || !Array.isArray(data.reasons) || !data.reasons.every(item => typeof item === 'string') || !Array.isArray(data.missing) || !data.missing.every(item => typeof item === 'string')) throw new Error('Saved gap outlook is invalid. Existing data was preserved.')
  if (data.inputs !== undefined && (!Array.isArray(data.inputs) || !data.inputs.every(input => typeof input.name === 'string' && [input.bullish, input.bearish, input.coverage].every(value => Number.isFinite(value) && value >= 0 && value <= 100)))) throw new Error('Saved gap input summary is invalid. Existing data was preserved.')
  if ([data.bullishScore, data.bearishScore].some(value => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100))) throw new Error('Saved gap comparison is invalid. Existing data was preserved.')
  if (data.version === 2) {
    const window = gapOutlookWindow(data.generatedAt)
    if (!window || data.session !== window.date || data.expiresAt !== window.expiresAt || Date.parse(data.asOf) !== data.generatedAt || data.technicalLead !== 0) throw new Error('Saved dynamic gap outlook timestamp is invalid. Existing data was preserved.')
    return data
  }
  const session = tradingSession(data.generatedAt), cutoff = session.start + gapOutlookMinute * 60_000
  // Legacy pre-close snapshots remain readable; version 2 uses live external inputs.
  if (!Number.isFinite(data.referencePrice) || !session.weekday || session.date !== data.session || data.generatedAt < cutoff || data.generatedAt >= cutoff + 60_000 || ![timeframeInfo[gapAnalysisInterval].milliseconds, 60_000].some(duration => Date.parse(data.asOf) === cutoff - duration)) throw new Error('Saved gap outlook timestamp is invalid. Existing data was preserved.')
  return data
}

/** Relative shares of directional evidence, never estimated opening probabilities. */
export function gapEvidenceComparison(outlook: GapOutlook) {
  const bullish = outlook.bullishScore, bearish = outlook.bearishScore
  if (bullish === undefined || bearish === undefined || !Number.isFinite(bullish) || !Number.isFinite(bearish) || bullish < 0 || bearish < 0 || bullish + bearish <= 0) return undefined
  const up = Math.round(bullish / (bullish + bearish) * 1000) / 10
  return { up, down: Math.round((100 - up) * 10) / 10 }
}
