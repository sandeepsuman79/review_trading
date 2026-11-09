import type { ChartIndicator, ChartIndicatorVisibility, ChartTradeLevels } from './ChartIndicators'

const controls: Array<{ key: ChartIndicator; label: string; color: string }> = [
  { key: 'supertrend', label: 'Supertrend (10,3)', color: '#16A34A' },
  { key: 'vwap', label: 'VWAP', color: '#A855F7' },
  { key: 'ema20', label: 'EMA 20', color: '#0EA5E9' },
  { key: 'ema50', label: 'EMA 50', color: '#F59E0B' },
  { key: 'sma20', label: 'SMA 20', color: '#64748B' },
]

const number = (value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
export default function ChartIndicatorLegend({ visibility, onToggle, hasVwap, spotIndex, onShowAtm, showTradeContext = true, trade, priceActionOnly = false }: {
  visibility: ChartIndicatorVisibility; onToggle: (key: ChartIndicator) => void; hasVwap: boolean; spotIndex: boolean;
  onShowAtm?: () => void; showTradeContext?: boolean; trade?: ChartTradeLevels; priceActionOnly?: boolean
}) {
  return <div className="chart-indicator-panel chart-indicator-legend">
    <div className="chart-indicator-controls" role="group" aria-label="Chart indicator visibility">
      <span className="chart-indicator-controls-label">Indicators <small>(tap to show/hide)</small></span>
      {controls.map(control => spotIndex && control.key === 'vwap'
        ? <button key={control.key} type="button" onClick={onShowAtm} disabled={priceActionOnly || !onShowAtm} title="View ATM CE/PE VWAP reference values" aria-label="View ATM option VWAP reference"><i aria-hidden="true" style={{ background: control.color }} />VWAP <small>ATM</small></button>
        : <button key={control.key} type="button" aria-pressed={!priceActionOnly && visibility[control.key] && (control.key !== 'vwap' || hasVwap)} disabled={priceActionOnly || control.key === 'vwap' && !hasVwap}
          onClick={() => onToggle(control.key)} title={priceActionOnly ? 'Price-action view: select the index chart to show indicator overlays' : control.key === 'vwap' && !hasVwap ? 'VWAP needs traded candle volume. Waiting for historical or observed volume.' : `${visibility[control.key] ? 'Hide' : 'Show'} ${control.label}`}>
          <i aria-hidden="true" style={{ background: control.color }} />{control.label}{control.key === 'vwap' && !hasVwap && <small>N/A</small>}
        </button>)}
    </div>
    {showTradeContext && <div className="chart-trade-legend" aria-label="Trade level legend">
      <span><i aria-hidden="true" className="is-entry" />Entry</span><span><i aria-hidden="true" className="is-stop" />Initial stop-loss</span><span><i aria-hidden="true" className="is-target" />Target · Exit or extend</span>
      {trade?.trailingStop !== undefined && <span><i style={{ background: '#D97706' }} />TSL {number(trade.trailingStop)}</span>}
      <small>{trade ? 'Current live trade' : 'Levels appear when a confirmed trade is live'}</small>
    </div>}
  </div>
}
