import { useState } from 'react'
import { useAtmVwap } from '../hooks/useAtmVwap'
import { useAtmOptionCandles } from '../hooks/useAtmOptionCandles'
import type { AgentTimeframe } from '../analysis/multiTimeframe'
import type { ScaleView } from '../analysis/indexPriceScale'
import CandleChart, { type CandleChartProps } from './CandleChart'

type Props = CandleChartProps & { interval: AgentTimeframe }

/** The same chart area switches between the index and its current ATM contracts. */
function IndexOptionChart({ interval, ...props }: Props) {
  const { name, tick, candles, now, optionExpiry } = props
  const [view, setView] = useState<ScaleView>('INDEX')
  const price = tick?.ltp ?? candles[candles.length - 1]?.[4]
  const atm = useAtmVwap(name, price, now, true)
  const history = useAtmOptionCandles(view === 'INDEX' ? undefined : atm.data, interval, now)
  const snapshot = atm.data, side = view === 'PE' ? 'pe' : 'ce'
  const optionCandles = history.data?.[side] ?? []
  const expiry = [snapshot?.expiry, optionExpiry].find(value => value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Date.parse(`${value}T15:30:00+05:30`) > now)
  const expiryLabel = expiry ? `${expiry.slice(8, 10)}/${expiry.slice(5, 7)} E` : '— E'
  const quoteTime = snapshot?.[side].priceAsOf ?? snapshot?.[side].asOf
  const status = view === 'INDEX' ? 'Index chart · CE / PE show the current ATM contract'
    : atm.error || history.error || (!snapshot ? 'Loading ATM contracts…' : !history.data ? `Loading ATM ${view} candles…`
      : `ATM ${snapshot.strike.toLocaleString('en-IN')} ${view} · ₹ premiums · Session volume ${snapshot[side].volume.toLocaleString('en-IN')}${quoteTime ? ` · Quote ${new Date(quoteTime).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST` : ''}`)
  const controls = <div className="chart-scale-controls" aria-label="Index and ATM option chart controls">
    <span role="status">{status}</span>
    <div>
      <button type="button" className={view === 'CE' ? 'is-selected' : ''} aria-pressed={view === 'CE'} aria-label="Show ATM CE chart" onClick={() => setView('CE')}>← CE</button>
      <button type="button" className={view === 'INDEX' ? 'is-selected' : ''} aria-pressed={view === 'INDEX'} aria-label={`Show ${name} index chart`} title={expiry ? `Nearest option expiry: ${expiry}; return to index chart` : 'Return to index chart'} onClick={() => setView('INDEX')}>{expiryLabel}</button>
      <button type="button" className={view === 'PE' ? 'is-selected' : ''} aria-pressed={view === 'PE'} aria-label="Show ATM PE chart" onClick={() => setView('PE')}>PE →</button>
    </div>
  </div>
  if (view === 'INDEX') return <CandleChart key={`index:${interval}`} {...props} chartControls={controls} onViewChange={setView} />
  if (!snapshot || !optionCandles.length) return <section className="candle-chart" aria-label={`${name} ATM ${view} chart`}>
    <div className="candle-chart-header"><strong>{name} · ATM {snapshot?.strike.toLocaleString('en-IN') ?? '…'} {view}</strong></div>
    <div className="atm-chart-loading" role="status">{status}</div>{controls}
  </section>
  return <CandleChart key={`${snapshot.index}:${snapshot.expiry}:${snapshot.strike}:${side}:${interval}`}
    name={`${name} ${snapshot.strike} ${view}`} candles={optionCandles} intervalLabel={props.intervalLabel}
    quotePrice={snapshot[side].close ?? undefined} historyLabel="Broker option history" priceStatusLabel="REST quotes every 10s · Candles every minute"
    savedCandleCount={optionCandles.length} isLive={false} now={now} chartControls={controls}
    marketHeartbeat={`ATM ${view} · Expiry ${snapshot.expiry} · Candle-volume VWAP · Synced ${new Date(history.data!.fetchedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST`}
    spotIndex={false} showIndexContext={false} showTradeContext={false} />
}

export default function MarketCandleChart(props: Props) {
  return props.spotIndex ? <IndexOptionChart {...props} /> : <CandleChart {...props} />
}
