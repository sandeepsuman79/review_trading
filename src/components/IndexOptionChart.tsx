import { useState } from 'react'
import type { AgentTimeframe } from '../analysis/multiTimeframe'
import type { ScaleView } from '../analysis/indexPriceScale'
import CandleChart, { type CandleChartProps } from './CandleChart'

type Props = CandleChartProps & { interval: AgentTimeframe }

/** CE/PE select a directional price-action view of the same underlying candles. */
function IndexPriceActionChart(props: Props) {
  const { name, now, optionExpiry } = props
  const [view, setView] = useState<ScaleView>('INDEX')
  const expiry = optionExpiry && /^\d{4}-\d{2}-\d{2}$/.test(optionExpiry) && Date.parse(`${optionExpiry}T15:30:00+05:30`) > now ? optionExpiry : undefined
  const expiryLabel = expiry ? `${expiry.slice(8, 10)}/${expiry.slice(5, 7)} E` : 'Index'
  const controls = <div className="chart-scale-controls" aria-label="Underlying price-action chart controls">
    <span role="status">{view === 'INDEX' ? `${name} underlying chart` : `${view === 'CE' ? 'CALL / CE' : 'PUT / PE'} price action · ${name} underlying prices · Agent uses completed 5-minute candles`}</span>
    <div>
      <button type="button" className={view === 'CE' ? 'is-selected' : ''} aria-pressed={view === 'CE'} aria-label="Show CALL CE price action" onClick={() => setView('CE')}>← CE</button>
      <button type="button" className={view === 'INDEX' ? 'is-selected' : ''} aria-pressed={view === 'INDEX'} aria-label={`Show ${name} index chart`} onClick={() => setView('INDEX')}>{expiryLabel}</button>
      <button type="button" className={view === 'PE' ? 'is-selected' : ''} aria-pressed={view === 'PE'} aria-label="Show PUT PE price action" onClick={() => setView('PE')}>PE →</button>
    </div>
  </div>
  return <CandleChart {...props} chartControls={controls} onViewChange={setView} priceActionOnly={props.priceActionOnly || view !== 'INDEX'} />
}
export default function MarketCandleChart(props: Props) {
  return props.spotIndex ? <IndexPriceActionChart {...props} /> : <CandleChart {...props} />
}
