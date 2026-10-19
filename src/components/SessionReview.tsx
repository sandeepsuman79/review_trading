import { useEffect, useRef, useState } from 'react'
import type { AngelOneCandle } from '../api/angelOne'
import type { PredictionRecord } from '../analysis/predictionHistory'
import { buildSessionReview, reviewDate, sessionReviewDue, type SessionReport } from '../analysis/sessionReview'
type Saved = { sourceKey?: string; report: SessionReport; commentary?: string; error?: string }
export default function SessionReview({ instrument, records, candles, now, contractToken = '' }: { instrument: string; records: PredictionRecord[]; candles: AngelOneCandle[]; now: number; contractToken?: string }) {
  const [saved, setSaved] = useState<Saved>(), [busy, setBusy] = useState(false)
  const latest = useRef({ records, candles, now }); latest.current = { records, candles, now }
  const date = reviewDate(now), due = sessionReviewDue(instrument, now), minute = Math.floor(now / 60000)
  const key = `traders_session_review_v1:${instrument}:${contractToken}:${date}`
  useEffect(() => {
    try {
      const existing = JSON.parse(localStorage.getItem(key) || 'null') as Saved | null
      setSaved(existing?.report?.date === date ? existing : undefined)
      if (!due) return
      const input = latest.current
      const matching = input.records.filter(r => r.instrument === instrument)
      const sourceKey = JSON.stringify({ records: matching.map(r => [r.id, r.status, r.entryAt, r.exitAt, r.points, r.bullishScore, r.bearishScore]), candles: input.candles.length, first: input.candles[0]?.[0], last: input.candles[input.candles.length - 1] })
      if (existing?.sourceKey === sourceKey) return
      const report = buildSessionReview(instrument, input.records, input.candles, input.now)
      const value = { report, sourceKey }
      localStorage.setItem(key, JSON.stringify(value)); setSaved(value)
    } catch { setSaved(undefined) }
  }, [instrument, key, date, due, minute, records.length, candles.length])
  async function askGemini() {
    if (!saved || busy) return
    setBusy(true)
    try {
      const response = await fetch('/api/ai/session-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saved.report) })
      const data = await response.json()
      if (!response.ok || typeof data.summary !== 'string') throw new Error(data.message || 'Review unavailable')
      const next = { report: saved.report, sourceKey: saved.sourceKey, commentary: data.summary }
      localStorage.setItem(key, JSON.stringify(next)); setSaved(next)
    } catch (error) { setSaved({ ...saved, error: error instanceof Error ? error.message : 'Review unavailable' }) }
    finally { setBusy(false) }
  }
  function download() {
    if (!saved) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${instrument}-${date}-review.json`; link.click(); URL.revokeObjectURL(url)
  }
  return <details className="agent-evidence-checks"><summary>After-market learning review · {date}</summary>
    {!saved ? <p>Automatic review runs after {['Nifty 50', 'Sensex', 'Bank Nifty'].includes(instrument) ? '15:15 IST' : 'the MCX session cutoff'} while this dashboard is open, or on the next visit that evening.</p> : <>
      <p>{saved.report.confirmed} confirmed · {saved.report.entered} entered · {saved.report.settled} verified outcomes · {saved.report.wins} wins / {saved.report.losses} losses · {saved.report.unresolved} unresolved · {saved.report.points.toFixed(2)} underlying/futures points.</p>
      <p>Verified win rate: {saved.report.winRate === null ? 'Unavailable' : `${(saved.report.winRate * 100).toFixed(1)}%`}. Excludes unresolved and unentered signals; before costs.</p>
      <p>Local learned model: {saved.report.model.status} · {saved.report.model.message}</p>
      {saved.report.model.status === 'TRAINED' && <p>Holdout accuracy {(saved.report.model.accuracy! * 100).toFixed(1)}% vs majority baseline {(saved.report.model.majorityBaseline! * 100).toFixed(1)}% · {saved.report.model.training} training / {saved.report.model.holdout} test trades.</p>}
      <p>Chart history: {saved.report.chartCandles} saved candles · {saved.report.chartHistory.message}</p>
      <ul>{saved.report.suggestions.map(item => <li key={item}>{item}</li>)}</ul>
      <button type="button" onClick={download}>Download review</button> <button type="button" disabled={busy} onClick={() => void askGemini()}>{busy ? 'Reviewing…' : 'Ask Gemini for code improvement suggestions'}</button>
      {saved.commentary && <p>{saved.commentary}</p>}{saved.error && <p role="status">{saved.error}</p>}
      <p>Uses all available saved trade history and five-minute chart history. Suggestions require your review; learning does not edit code or live rules. Browser must be open to collect observations.</p>
    </>}
  </details>
}
