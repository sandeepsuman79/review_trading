import type { MovingAveragePoint } from '../analysis/movingAverages'
import type { TechnicalIndicatorPoint } from '../analysis/technicalIndicators'
import type { IndiaVixSnapshot } from '../api/marketContext'

export type ChartIndicator = 'supertrend' | 'vwap' | 'ema20' | 'ema50' | 'sma20'
export type ChartIndicatorVisibility = Record<ChartIndicator, boolean>
export type ChartTradeLevels = { entry: number; target: number; stopLoss: number }

const controls: Array<{ key: ChartIndicator; label: string; color: string }> = [
  { key: 'supertrend', label: 'Supertrend (10,3)', color: '#16A34A' },
  { key: 'vwap', label: 'VWAP', color: '#A855F7' },
  { key: 'ema20', label: 'EMA 20', color: '#0EA5E9' },
  { key: 'ema50', label: 'EMA 50', color: '#F59E0B' },
  { key: 'sma20', label: 'SMA 20', color: '#64748B' },
]
const number = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function ChartIndicators({ visibility, onToggle, average, technical, vwap, hasVwap, spotIndex, close, context, trade, indiaVix, indiaVixLoading, now }: {
  visibility: ChartIndicatorVisibility; onToggle: (key: ChartIndicator) => void;
  average: MovingAveragePoint; technical: TechnicalIndicatorPoint; vwap?: number;
  hasVwap: boolean; spotIndex: boolean; close: number; context: string; trade?: ChartTradeLevels;
  indiaVix?: IndiaVixSnapshot; indiaVixLoading?: boolean; now: number
}) {
  const vwapPosition = vwap === undefined ? 'neutral' : close > vwap ? 'positive' : close < vwap ? 'negative' : 'neutral'
  const emaDirection = average.ema20 === undefined || average.ema50 === undefined ? 'neutral' : average.ema20 > average.ema50 ? 'positive' : average.ema20 < average.ema50 ? 'negative' : 'neutral'
  const rsiExtreme = technical.rsi14 !== undefined && (technical.rsi14 >= 70 || technical.rsi14 <= 30)
  const supertrendDirection = technical.supertrendDirection === 'UP' ? 'positive' : technical.supertrendDirection === 'DOWN' ? 'negative' : 'neutral'
  const vix = indiaVix?.data
  const quoteAge = vix ? now - Date.parse(vix.asOf) : Infinity
  const fetchedAge = indiaVix?.fetchedAt ? now - Date.parse(indiaVix.fetchedAt) : Infinity
  const vixCurrent = indiaVix?.status === 'AVAILABLE' && quoteAge >= -60_000 && quoteAge <= 4 * 86_400_000 && fetchedAge >= -60_000 && fetchedAge <= 10 * 60_000
  const vixColor = !vixCurrent || !vix ? 'neutral' : vix.changePercent < 0 ? 'positive' : vix.changePercent > 0 ? 'negative' : 'neutral'
  const vixNumber = (value: number) => value.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 })
  return <div className="chart-indicator-panel">
    <div className="chart-indicator-controls" role="group" aria-label="Chart indicator visibility">
      <span className="chart-indicator-controls-label">Indicators <small>(tap to show/hide)</small></span>
      {controls.map(control => <button key={control.key} type="button" aria-pressed={visibility[control.key] && (control.key !== 'vwap' || hasVwap)} disabled={control.key === 'vwap' && !hasVwap}
        onClick={() => onToggle(control.key)} title={control.key === 'vwap' && !hasVwap ? 'VWAP needs traded candle volume. These spot-index candles have zero volume, so a genuine VWAP cannot be calculated.' : `${visibility[control.key] ? 'Hide' : 'Show'} ${control.label}`}>
        <i aria-hidden="true" style={{ background: control.color }} />{control.label}{control.key === 'vwap' && !hasVwap && <small>N/A</small>}
      </button>)}
    </div>
    <div className="chart-trade-legend" aria-label="Trade level legend">
      <span><i className="is-entry" />Entry</span><span><i className="is-stop" />Stop-loss</span><span><i className="is-target" />Target</span>
      <small>{trade ? 'Current live trade' : 'Levels appear when a confirmed trade is live'}</small>
    </div>
    <div className="chart-indicator-context">{context}</div>
    <div className="chart-indicator-metrics" role="region" aria-label="Chart indicator values" tabIndex={0}>
      <div className="chart-indicator-metric" aria-label="VWAP indicator">
        <span className="chart-indicator-metric-title">VWAP</span><strong>{vwap === undefined ? 'Unavailable' : number(vwap)}</strong>
        <small className={`indicator-${vwapPosition}`}>{vwap === undefined ? spotIndex ? 'Spot index has no traded volume' : 'Waiting for candle volume' : close > vwap ? 'Price above' : close < vwap ? 'Price below' : 'Price at VWAP'}</small>
      </div>
      <div className="chart-indicator-metric" aria-label="EMA 20 and 50 indicators">
        <span className="chart-indicator-metric-title">EMA 20 / 50</span>
        <strong className="indicator-ema-values"><span><small>20</small>{number(average.ema20)}</span><span><small>50</small>{number(average.ema50)}</span></strong>
        <small className={`indicator-${emaDirection}`}>{average.ema50 === undefined ? 'Needs 50 candles' : emaDirection === 'positive' ? 'Uptrend' : emaDirection === 'negative' ? 'Downtrend' : 'Flat'}</small>
      </div>
      <div className="chart-indicator-metric" aria-label="RSI 14 indicator">
        <span className="chart-indicator-metric-title">RSI (14)</span><strong>{technical.rsi14?.toFixed(1) ?? '—'}</strong>
        <small className={rsiExtreme ? 'indicator-warning' : 'indicator-neutral'}>{technical.rsi14 === undefined ? 'Needs 15 candles' : technical.rsi14 >= 70 ? 'Overbought' : technical.rsi14 <= 30 ? 'Oversold' : 'Neutral'}</small>
      </div>
      <div className="chart-indicator-metric" aria-label="Supertrend indicator">
        <span className="chart-indicator-metric-title">Supertrend (10,3)</span><strong>{number(technical.supertrend10)}</strong>
        <small className={`indicator-${supertrendDirection}`}>{technical.supertrendDirection === undefined ? 'Needs 10 candles' : technical.supertrendDirection === 'UP' ? 'Bullish trend' : 'Bearish trend'}</small>
      </div>
      <div className="chart-indicator-metric" aria-label="ATR 14 indicator">
        <span className="chart-indicator-metric-title">ATR (14)</span><strong>{technical.atr14 === undefined ? '—' : `${technical.atr14.toFixed(1)} pts`}</strong>
        <small>{technical.atr14 === undefined ? 'Needs 14 candles' : trade ? `Trade SL ${Math.abs(trade.entry - trade.stopLoss).toFixed(1)} · TGT ${Math.abs(trade.target - trade.entry).toFixed(1)} pts` : '14-candle volatility'}</small>
      </div>
      <div className="chart-indicator-metric" aria-label="ADX and DMI indicators">
        <span className="chart-indicator-metric-title">ADX / DMI (14)</span><strong>{technical.adx14?.toFixed(1) ?? '—'}</strong>
        <small>{technical.adx14 === undefined ? 'Needs 28 candles' : `${technical.adx14 >= 25 ? 'Strong trend' : technical.adx14 >= 20 ? 'Developing trend' : 'Weak trend'} · +DI ${technical.plusDi14?.toFixed(1) ?? '—'} / −DI ${technical.minusDi14?.toFixed(1) ?? '—'}`}</small>
      </div>
      <div className="chart-indicator-metric" aria-label="India VIX indicator">
        <span className="chart-indicator-metric-title">INDIA VIX</span>
        <strong className="indicator-vix-values">{vix ? <><span>{vixNumber(vix.price)}</span><small className={`indicator-${vixColor}`}>{vix.changePercent > 0 ? '+' : ''}{vixNumber(vix.changePercent)}%</small></> : indiaVixLoading ? 'Loading…' : 'Unavailable'}</strong>
        <small>{vix ? <a href={indiaVix!.sourceUrl} target="_blank" rel="noopener noreferrer" title="Latest public India VIX quote; independent of the inspected chart candle">{vixCurrent ? vix.timeBasis === 'RECEIVED' ? 'Angel One · Fetched' : 'As of' : 'Last quote'} {new Date(vix.asOf).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST</a> : 'Waiting for a public quote'}</small>
      </div>
    </div>
  </div>
}
