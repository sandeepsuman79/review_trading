import { useState } from 'react'
import { canExitPredictionEarly, predictionDisplayStatus, predictionHistoryStats, predictionSuccessScore, type PredictionRecord } from '../analysis/predictionHistory'

const price = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const time = (value?: number) => value === undefined ? '—' : `${new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST`
const intervalLabel = (interval: string) => interval === 'FIVE_MINUTE' ? '5-minute' : interval === 'FIFTEEN_MINUTE' ? '15-minute' : '1-hour'
const statusLabel = (status: string) => status.replace(/_/g, ' ')

export default function PredictionHistory({ records, storageError, now, onExitEarly }: { records: PredictionRecord[]; storageError: string; now: number; onExitEarly: (id: string) => void }) {
  const [index, setIndex] = useState('All indices')
  const [side, setSide] = useState('All calls')
  const filtered = records.filter(record => (index === 'All indices' || record.instrument === index) && (side === 'All calls' || record.side === side))
  const stats = predictionHistoryStats(records)
  const filteredStats = predictionHistoryStats(filtered)
  const exportCsv = () => {
    const headers = ['Indices', 'Direction', 'Status', 'Entry', 'Target', 'Stop Loss', 'Early Exit', 'Success Score (%)', 'Timeframe', 'Issued IST', 'Stage', 'Outcome', 'Entry trigger', 'Entry time IST', 'Exit price', 'Exit time IST', 'Points', 'Early exit source', 'Context', 'Outcome note']
    const rows = filtered.map(record => [record.instrument, record.side, predictionDisplayStatus(record), record.entryPrice ?? record.entry, record.target, record.stopLoss, record.status === 'EARLY_EXIT' ? record.exitPrice : '', predictionSuccessScore(record) ?? '', intervalLabel(record.interval), time(record.generatedAt), record.stage, record.status, record.entry, time(record.entryAt), record.exitPrice ?? '', time(record.exitAt), record.points ?? '', record.earlyExitSource ?? '', record.contextMode, record.outcomeNote])
    const csv = [headers, ...rows].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'prediction-history.csv'; link.click()
    URL.revokeObjectURL(url)
  }
  return <section className="card prediction-history" aria-label="Prediction history">
    <div className="history-heading">
      <div><h2>History</h2><p>CALL / PUT setups · Index prices and points · Saved on this browser</p></div>
      <button type="button" onClick={exportCsv} disabled={!filtered.length}>Export CSV</button>
    </div>
    {storageError && <p role="status" className="history-storage-status">History saving is unavailable. Existing saved data is preserved; new calls may not be recorded.</p>}
    <div className="history-filters">
      <label>Index<select aria-label="History index" value={index} onChange={event => setIndex(event.target.value)}>{['All indices', 'Nifty 50', 'Sensex', 'Bank Nifty'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Direction<select aria-label="History direction" value={side} onChange={event => setSide(event.target.value)}>{['All calls', 'CALL', 'PUT'].map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    <div className="history-table-scroll" tabIndex={0} aria-label="Scroll prediction history">
      <table className="history-table"><caption className="history-table-caption">{filtered.length} of {records.length} saved calls · Latest first</caption><thead><tr><th scope="col">Indices</th><th scope="col">Direction</th><th scope="col">Status</th><th scope="col">Entry</th><th scope="col">Target</th><th scope="col">Stop Loss</th><th scope="col">Early Exit</th><th scope="col">Success Score</th></tr></thead><tbody>
        {!filtered.length && <tr><td colSpan={8} className="history-empty">{records.length ? 'No calls match these filters.' : 'No calls saved yet. New CALL / PUT setups appear here automatically.'}</td></tr>}
        {[...filtered].sort((a, b) => b.generatedAt - a.generatedAt).map(record => {
          const floating = record.status === 'ACTIVE' && record.entryPrice !== undefined && record.latestPrice !== undefined ? (record.latestPrice - record.entryPrice) * (record.side === 'CALL' ? 1 : -1) : undefined
          const score = predictionSuccessScore(record)
          const points = record.points ?? floating
          return <tr key={record.id}>
            <td><strong>{record.instrument}</strong><small>{intervalLabel(record.interval)} · {time(record.generatedAt)}</small><details><summary>Details</summary><p>{record.reason}</p><p>{record.targetBasis}</p><p>{record.outcomeNote}</p><p>News: {record.newsSummary}</p><ul>{record.technicalEvidence.map(item => <li key={item}>{item}</li>)}</ul><ul>{record.newsEvidence.map(article => <li key={article.id}><a href={article.url} target="_blank" rel="noreferrer">{article.title}</a> · {article.publisher}</li>)}</ul><small>{record.coverage.join(' · ')}</small></details></td>
            <td><strong className={record.side === 'CALL' ? 'history-positive' : 'history-negative'}>{record.side}</strong><small>{record.stage}</small></td>
            <td><span className={`history-status ${predictionDisplayStatus(record) === 'Live' ? 'is-live' : 'is-done'}`}>{predictionDisplayStatus(record)}</span><small>{statusLabel(record.status)}</small></td>
            <td><strong>{price(record.entryPrice ?? record.entry)}</strong><small>{record.entryAt ? time(record.entryAt) : 'Waiting for trigger'}{record.entryPrice !== undefined && record.entryPrice !== record.entry && <><br />Trigger {price(record.entry)}</>}</small></td>
            <td><strong>{price(record.target)}</strong><small>{record.riskReward.toFixed(2)}:1 reward / risk</small></td>
            <td><strong>{price(record.stopLoss)}</strong></td>
            <td>{record.status === 'EARLY_EXIT' ? <><strong>{price(record.exitPrice)}</strong><small>{time(record.exitAt)}<br />{record.earlyExitSource === 'AGENT_REVERSAL' ? 'Agent: chart reversal' : 'Manual exit'}</small></> : record.status === 'ACTIVE' ? <><button className="history-early-exit" type="button" disabled={!canExitPredictionEarly(record, now)} onClick={() => onExitEarly(record.id)} aria-label={`Exit ${record.instrument} ${record.side} early`}>Exit early</button><small>{canExitPredictionEarly(record, now) ? `Live ${price(record.latestPrice)}` : 'Waiting for a fresh live quote'}</small></> : <span>—</span>}</td>
            <td><strong className={score === null ? undefined : score > 0 ? 'history-positive' : 'history-negative'}>{score === null ? '—' : `${score}%`}</strong><small>{statusLabel(record.status)}{record.exitPrice !== undefined && record.status !== 'EARLY_EXIT' && <> · Exit {price(record.exitPrice)}</>}</small>{points !== undefined && <span className={`history-points ${points >= 0 ? 'history-positive' : 'history-negative'}`}>{points > 0 ? '+' : ''}{price(points)} points{floating !== undefined ? ' · Unrealized' : ''}</span>}</td>
          </tr>
        })}
      </tbody></table>
    </div>
    <div className="history-metrics" aria-label="Overall history results">
      <div><span>Overall success score</span><strong>{stats.successRate === null ? '—' : `${stats.successRate.toFixed(1)}%`}</strong><small>{stats.wins} profitable / {stats.resolved} closed calls{(index !== 'All indices' || side !== 'All calls') && <><br />Filtered success score: {filteredStats.successRate === null ? '—' : `${filteredStats.successRate.toFixed(1)}%`}</>}</small></div>
      <div><span>Overall settled points</span><strong>{stats.netPoints > 0 ? '+' : ''}{price(stats.netPoints)}</strong><small>{stats.targets} targets · {stats.stops} stops · {stats.earlyExits} early exits</small></div>
      <div><span>All saved calls</span><strong>{stats.total}</strong><small>{stats.open} pending / active · {stats.excluded} excluded<br />{stats.losses} losing · {stats.breakEven} break-even calls</small></div>
    </div>
    <p className="history-method">Row success score: 100% for a closed call with positive points, 0% for a loss or break-even. Overall success score = profitable closed calls ÷ all closed calls, including early exits. Pending, active, expired, ambiguous and unverified calls are excluded. Early exits record a simulated close at a fresh live index quote; no broker order is sent. Results are index points, and points across indices are a simple sum.</p>
    {index === 'All indices' && records.length > 0 && <div className="history-index-results">{['Nifty 50', 'Sensex', 'Bank Nifty'].map(name => {
      const result = predictionHistoryStats(filtered.filter(record => record.instrument === name))
      return <div key={name}><strong>{name}</strong><span>{result.successRate === null ? 'No resolved calls' : `${result.successRate.toFixed(1)}% · ${result.resolved} resolved`}</span><span>{price(result.netPoints)} settled points</span></div>
    })}</div>}
    <p className="history-method">History remains after refresh and logout in this browser. Clearing browser storage or using a different browser removes access to this local history. Tracking runs while the page is open; missed or unclear price periods are marked unverified rather than counted as wins.</p>
  </section>
}
