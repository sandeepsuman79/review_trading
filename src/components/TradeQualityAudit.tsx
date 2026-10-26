import { useState } from 'react'
import type { AngelOneCandle } from '../api/angelOne'
import type { AgentTimeframe } from '../analysis/multiTimeframe'
import type { PredictionRecord } from '../analysis/predictionHistory'
import type { CommodityContract } from '../analysis/commodities'
import { auditTradeQuality } from '../analysis/tradeQualityAudit'

export default function TradeQualityAudit({ instrument, records, candlesByInterval, contract, now }: {
  instrument: string; records: PredictionRecord[]; candlesByInterval: Partial<Record<AgentTimeframe, AngelOneCandle[]>>; contract?: CommodityContract; now: number
}) {
  const [report, setReport] = useState<ReturnType<typeof auditTradeQuality>>()
  function review() { setReport(auditTradeQuality({ instrument, records, candlesByInterval, contract, now })) }
  function download() {
    if (!report) return
    const url = URL.createObjectURL(new Blob([JSON.stringify({ report, records: records.filter(record => report.rows.some(row => row.id === record.id)) }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${instrument}-${report.date}-trade-quality.json`; link.click(); URL.revokeObjectURL(url)
  }
  return <details className="agent-evidence-checks"><summary>Today’s trade quality audit · {instrument}</summary>
    <p>Review this browser’s saved entries and booked outcomes against the revised price filters. The audit uses candles available at each signal, before costs.</p>
    <button type="button" onClick={review}>Review today’s trades</button>
    {report && <>
      <p>{report.date} · {report.summary.entries} entries · {report.summary.settled} settled · {report.summary.wins} wins / {report.summary.losses} losses · {report.summary.unresolved} unresolved · {report.summary.points.toFixed(2)} instrument points.</p>
      <p>{report.summary.priceBlocked} entries fail the revised price filters · {report.summary.unavailable} lack sufficient historical candles. This is a diagnostic comparison, not a claim those losses would be avoided.</p>
      <p>{report.scope}</p>
      <ul>{report.rows.map(row => <li key={row.id}><strong>{new Date(row.entryAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST · {row.side} · {row.priceAssessment}</strong> · {row.points === undefined ? 'Outcome unresolved' : `${row.points.toFixed(2)} points${row.r !== undefined ? ` / ${row.r.toFixed(2)}R` : ''}`}<br />{row.blockers.join(' · ') || 'Price filters pass; historical VWAP/OI confirmation is not established.'}</li>)}</ul>
      <button type="button" onClick={download}>Download trade audit</button>
    </>}
  </details>
}
