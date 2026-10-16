import { isCommodity } from '../analysis/commodities'
import type { MinuteReview } from '../analysis/minuteMonitor'
import type { PredictionRecord } from '../analysis/predictionHistory'
import { tradeDirection } from '../analysis/commodities'

const price = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const time = (value: string | number) => new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
export default function MinuteMonitor({ review, history, activeTrade, entryPaused, connected, now }: {
  review: MinuteReview; history: MinuteReview[]; activeTrade?: PredictionRecord; entryPaused: boolean; connected: boolean; now: number
}) {
  const fresh = review.current && now - Date.parse(review.asOf ?? '') < 120_000
  const opposes = activeTrade && review.plan && review.plan.side !== activeTrade.side && activeTrade.contract?.token === review.plan.contract?.token
  const displayBias = review.state === 'REVERSAL_RISK' ? review.pressure?.side === 'CALL' ? 'BULLISH' : 'BEARISH' : review.bias
  const tone = !fresh ? 'neutral' : displayBias === 'BULLISH' ? 'bullish' : displayBias === 'BEARISH' ? 'bearish' : 'neutral'
  return <section className={`agent-minute-monitor agent-tone-${tone}`} aria-label="Background 1-minute monitoring">
    <div className="agent-market-view-heading"><strong>1-minute background monitor</strong><span className={`agent-text-${tone}`}>{fresh ? review.state === 'CONFIRMED' ? `${tradeDirection(review.instrument, review.plan!.side)} · Confirmed minute setup` : `${displayBias} · ${review.state.replace('_', ' ')}` : review.state === 'WARMING_UP' ? 'Warming up' : 'Waiting for data'}</span></div>
    <p className="agent-score-note">New trades use 5-minute confirmation. Completed minute candles provide earlier warnings and protective exits.{review.asOf && ` Last closed ${time(review.asOf)} IST.`} {history.length}/5 recent minute observations.</p>
    <div className="agent-evidence-scores"><span className="agent-text-bullish">Bullish <strong>{review.bullishScore}/100</strong></span><span className="agent-text-bearish">Bearish <strong>{review.bearishScore}/100</strong></span><span>Coverage {review.coverage}%</span></div>
    {entryPaused && !activeTrade && <p className="agent-text-bearish" role="status">Entry paused: confirmed minute reversal pressure opposes the 5-minute candidate.</p>}
    {opposes && fresh && <p className="agent-text-bearish" role="status">Opposite minute setup detected. Early exit requires a full post-entry candle and a fresh quote after its close.</p>}
    {!connected && <p className="agent-score-note" role="status">Stream disconnected · Live early exit is waiting for a fresh observed quote.</p>}
    {activeTrade?.protection && <p className="agent-score-note">Profit protection: {activeTrade.protection.armed ? `trailing stop ${price(activeTrade.protection.stop)}` : `arms after 0.75R favourable movement`} · Observed best price {price(activeTrade.protection.peakPrice)}. Stops tighten only; a gap can exit beyond the stop.</p>}
    {review.pressure?.confirmed && <p className={`agent-text-${tone}`} role="status">{activeTrade && review.pressure.side === activeTrade.side ? 'Pressure supports the open trade' : 'Reversal risk'}: {review.pressure.reasons.join(" · ")}. Existing trades can exit without an opposite entry setup.</p>}
    {!isCommodity(review.instrument) && <div className="agent-atm-vwap" aria-label="ATM option VWAP context"><strong>ATM CE / PE VWAP · Option prices</strong>{review.optionVwap ? <><p>Strike {price(review.optionVwap.strike)} · Expiry {review.optionVwap.expiry}</p>{(['ce','pe'] as const).map(side => { const leg = review.optionVwap![side]; return <p key={side}>{side.toUpperCase()}: candle VWAP ₹{price(leg.vwap ?? undefined)} · Last completed close ₹{price(leg.close ?? undefined)} · {leg.coverage === 'FULL_SESSION' ? 'Session coverage' : 'Partial data · Not scored'}{leg.asOf ? ` · ${time(leg.asOf)} IST` : ''}</p> })}</> : <p>{review.optionVwapError || 'Waiting for nearest-expiry ATM candle data.'}</p>}<p className="agent-score-note">HLC3 × actual option candle volume; a candle-based VWAP estimate on the option price scale. This is separate from spot-index VWAP. Partial or stale data is excluded from reversal checks.</p></div>}
    <details className="agent-evidence-checks"><summary>Minute technical data & sentiment</summary>
      <p>{review.reason}</p>
      <p>EMA 20 / 50: {price(review.indicators.ema20)} / {price(review.indicators.ema50)} · RSI: {price(review.indicators.rsi)} · ATR: {price(review.indicators.atr)} · Supertrend: {review.indicators.supertrend || '—'} · VWAP: {price(review.indicators.vwap)}</p>
      <p>Sentiment: {review.sentiment.bias} · Bullish {review.sentiment.bullishScore}/100 · Bearish {review.sentiment.bearishScore}/100 · Coverage {review.sentiment.coverage}%{review.sentiment.contextAt && ` · Context checked ${time(review.sentiment.contextAt)} IST`}. Latest available publications; sentiment does not trigger entries or exits.</p>
      <div className="agent-evidence-columns"><div><strong>Bullish minute evidence</strong><ul>{review.bullishEvidence.map(item => <li key={item}>{item}</li>)}</ul></div><div><strong>Bearish minute evidence</strong><ul>{review.bearishEvidence.map(item => <li key={item}>{item}</li>)}</ul></div></div>
      <p>Recent observations (IST): {history.map(item => `${time(item.asOf!)} ${item.bias} ${item.bullishScore}/${item.bearishScore}`).join(' · ') || 'Waiting for completed minute candles.'}</p>
    </details>
  </section>
}
