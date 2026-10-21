import { tradeDirection, isCommodity } from '../analysis/commodities'
import { squareOffLabel } from '../analysis/tradingSession'
import { timeframeInfo } from '../analysis/timeframes'
import { useEffect, useRef } from 'react'
import { confirmedTradePoints, todayConfirmedTrades } from '../analysis/confirmedTrades'
import type { PredictionRecord } from '../analysis/predictionHistory'

const price = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (value: number) => `${value > 0 ? '+' : ''}${price(value)}`
const time = (value?: number) => value === undefined ? '—' : new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
const tone = (points?: number) => points === undefined || points === 0 ? 'neutral' : points > 0 ? 'profit' : 'loss'
const reason = (record: PredictionRecord) => {
  switch (record.status) {
    case 'ACTIVE': return 'Agent managing trade'
    case 'TARGET_HIT': return 'Target hit'
    case 'STOP_LOSS_HIT': return 'Stop-loss hit'
    case 'EARLY_EXIT': return record.earlyExitSource === 'SESSION_SQUARE_OFF' ? `Square-off · ${squareOffLabel(record.instrument, record.entryAt ?? record.generatedAt)} IST` : record.earlyExitSource === 'AGENT_PROTECTION' ? record.reversalInterval === 'ONE_MINUTE' ? '1-minute trend protection' : 'Trailing profit protection' : record.earlyExitSource === 'AGENT_REVERSAL' ? record.reversalInterval === 'ONE_MINUTE' ? '1-minute reversal' : 'Agent-confirmed reversal' : 'Early exit'
    case 'AMBIGUOUS': return 'Unclear price ordering'
    default: return 'Outcome unverified'
  }
}

export default function ConfirmedTrades({ records, now, streamConnected, storageError }: { records: PredictionRecord[]; now: number; streamConnected: boolean; storageError: string }) {
  const { trades, stats, indices } = todayConfirmedTrades(records, now)
  const scrollRef = useRef<HTMLDivElement>(null)
  const latestTradeId = trades[0]?.id
  useEffect(() => { scrollRef.current?.scrollTo({ left: 0 }) }, [latestTradeId])
  return <section className="card confirmed-trades" aria-labelledby="confirmed-trades-heading">
    <div className="confirmed-trades-heading">
      <div><h2 id="confirmed-trades-heading">Today’s confirmed trades</h2><p>Latest first · Instrument profit / loss in points · Times in IST</p></div>
      <div className="confirmed-trades-count" role="status">{stats.total} {stats.total === 1 ? 'trade' : 'trades'} · {stats.wins} {stats.wins === 1 ? 'win' : 'wins'}{stats.open > 0 && ` · ${stats.open} live`}{stats.excluded > 0 && ` · ${stats.excluded} unverified`}</div>
    </div>
    {indices.some(index => index.resolved > 0) && <div className="confirmed-trades-totals" aria-label="Booked profit and loss by instrument">{indices.filter(index => index.resolved > 0).map(index => <span key={index.instrument}>{index.instrument} <strong className={`confirmed-pnl-${tone(index.netPoints)}`}>{signed(index.netPoints)} pts</strong></span>)}</div>}
    {storageError && <div className="confirmed-trades-storage" role="status"><p>{storageError}</p><button type="button" onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, records }, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a'); link.href = url; link.download = 'trade-history-backup.json'; link.click(); URL.revokeObjectURL(url)
    }}>Download trade history backup</button></div>}
    {trades.length === 0 ? <p className="confirmed-trades-empty">No confirmed entries today.</p> : <div ref={scrollRef} className="confirmed-trades-grid" tabIndex={0} aria-label="Scroll confirmed trades horizontally">{trades.map(record => {
      const unit = isCommodity(record.instrument) ? 'futures' : 'index'
      const points = confirmedTradePoints(record)
      const active = record.status === 'ACTIVE'
      const settled = ['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(record.status)
      const live = active && streamConnected && record.latestPriceSource === 'LIVE' && record.latestPriceAt !== undefined && record.latestPriceAt <= now + 1000 && now - record.latestPriceAt <= 30_000
      const current = active ? record.latestPrice : settled ? record.exitPrice : undefined
      const percent = points === undefined ? undefined : points / record.entryPrice! * 100
      return <article key={record.id} className={`confirmed-trade confirmed-outcome-${tone(points)}`} aria-label={`${record.instrument} ${record.side} confirmed trade`}>
        <div className="confirmed-trade-row">
          <div><span className="confirmed-trade-label">Time</span><strong className="confirmed-trade-time">{time(record.entryAt)} <span aria-hidden="true">→</span> {settled ? time(record.exitAt) : active ? 'Live' : 'Unverified'}</strong></div>
          <div className="confirmed-trade-right"><span className="confirmed-trade-label">Direction</span><span className={`confirmed-side confirmed-side-${record.side.toLowerCase()}`}>{tradeDirection(record.instrument, record.side)}</span></div>
        </div>
        <div className="confirmed-trade-row">
          <div><span className="confirmed-trade-label">Instrument</span><strong>{record.instrument}</strong>{record.contract && <small>{record.contract.symbol} · {record.contract.expiry}</small>}<small>{timeframeInfo[record.interval].label} · {active ? 'LIVE' : settled ? 'DONE' : 'UNVERIFIED'}</small></div>
          <div className="confirmed-trade-right"><span className="confirmed-trade-label">Entry ({unit})</span><strong>{price(record.entryPrice)}</strong></div>
        </div>
        <div className="confirmed-trade-row">
          <div><span className="confirmed-trade-label">{active ? live ? `Current ${unit}` : `Last ${unit} quote` : `Exit (${unit})`}</span><strong>{price(current)}</strong>{percent !== undefined && <small className={`confirmed-pnl-${tone(points)}`}>{signed(percent)}% price move</small>}{active && record.latestPriceAt !== undefined && <small>As of {time(record.latestPriceAt)} IST</small>}</div>
          <div className="confirmed-trade-right"><span className="confirmed-trade-label">Stop-loss ({unit})</span><strong className="confirmed-pnl-loss">{price(record.stopLoss)}</strong><small>Target <b className="confirmed-pnl-profit">{price(record.target)}</b></small></div>
        </div>
        <div className="confirmed-trade-row confirmed-trade-result">
          <div><span className="confirmed-trade-label">{active ? 'Unrealized P/L' : 'Booked P/L'}</span><strong className={`confirmed-trade-pnl confirmed-pnl-${tone(points)}`}>{points === undefined ? '—' : `${signed(points)} pts`}</strong>{!active && !settled && <small>Excluded from totals</small>}</div>
          <div className="confirmed-trade-right"><span className="confirmed-trade-label">{active ? 'Status' : 'Exit reason'}</span><span className={`confirmed-exit confirmed-pnl-${tone(points)}`}>{reason(record)}</span></div>
        </div>
        <details className="confirmed-trade-note"><summary>Trade details</summary><p>{record.outcomeNote}</p></details>
      </article>
    })}</div>}
  </section>
}
