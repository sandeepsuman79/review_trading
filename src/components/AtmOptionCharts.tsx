import { useState } from 'react'
import { useAtmVwap } from '../hooks/useAtmVwap'
import { useAtmOptionCandles } from '../hooks/useAtmOptionCandles'
import type { AgentTimeframe } from '../analysis/multiTimeframe'
import { timeframeInfo } from '../analysis/timeframes'
import CandleChart from './CandleChart'

export default function AtmOptionCharts({ index, price, interval, now }: { index: string; price?: number; interval: AgentTimeframe; now: number }) {
  const atm = useAtmVwap(index, price, now, true)
  const history = useAtmOptionCandles(atm.data, interval, now)
  const [side, setSide] = useState<'ce' | 'pe'>('ce')
  const snapshot = atm.data, candles = history.data?.[side] ?? []
  return <section id="atm-option-charts" className="atm-option-charts" aria-label={`${index} ATM option charts`}>
    <div className="atm-option-heading"><strong>{index} · Default ATM {snapshot?.strike.toLocaleString('en-IN') ?? '…'}</strong>
      <div role="group" aria-label="ATM option side">{(['ce', 'pe'] as const).map(value => <button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)}>{value.toUpperCase()}</button>)}</div>
    </div>
    <p className="agent-score-note">{snapshot ? `Expiry ${snapshot.expiry} · ` : ''}ATM option prices in ₹ · Actual option volume per candle · VWAP line uses this contract’s candle volume. The index agent uses paired CE/PE context.</p>
    <p role="status">{atm.error || history.error || (!snapshot ? 'Loading ATM contracts…' : !history.data ? 'Loading ATM option candles…' : '')}</p>
    {snapshot && <div className="atm-option-volumes">{(['ce', 'pe'] as const).map(value => <span key={value}><b>{value.toUpperCase()}</b> LTP ₹{snapshot[value].close?.toLocaleString('en-IN') ?? '—'} · VWAP ₹{snapshot[value].vwap?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) ?? '—'} · Session volume {snapshot[value].volume.toLocaleString('en-IN')} · {snapshot[value].priceAsOf || snapshot[value].asOf ? `As of ${new Date((snapshot[value].priceAsOf || snapshot[value].asOf)!).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST` : 'Quote timestamp unavailable'}</span>)}</div>}
    {snapshot && candles.length > 0 && <CandleChart key={`${snapshot.index}:${snapshot.expiry}:${snapshot.strike}:${side}:${interval}`}
      name={`${index} ${snapshot.strike} ${side.toUpperCase()}`} candles={candles} intervalLabel={timeframeInfo[interval].label}
      quotePrice={snapshot[side].close ?? undefined} historyLabel="Broker option history" priceStatusLabel="REST quotes every 10s · Candles every minute"
      savedCandleCount={candles.length} isLive={false} marketHeartbeat={`Option candles · Synced ${new Date(history.data!.fetchedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST`}
      spotIndex={false} showIndexContext={false} showTradeContext={false} now={now} />}
  </section>
}
