import type { CSSProperties } from 'react'
import type { AngelOneStreamTick } from '../api/angelOne'
import { candleIntervalMs, isFreshTick, tickTimestamp } from '../analysis/candleData'
import type { EarlyPrediction } from '../analysis/earlyPrediction'
import type { PredictionRecord } from '../analysis/predictionHistory'
import type { PriceActionAnalysis, PriceActionInterval } from '../analysis/priceAction'
import type { TradingEvidence } from '../analysis/tradingEvidence'

function price(value?: number) {
  return value === undefined ? '—' : value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function time(value?: number) {
  return value === undefined ? '—' : `${new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST`
}

function timeframe(interval: PriceActionInterval) {
  return interval === 'FIVE_MINUTE' ? '5-minute' : interval === 'FIFTEEN_MINUTE' ? '15-minute' : '1-hour'
}

export default function AgentTradeCard({ analysis, evidence, prediction, activeTrade, instrument, interval, now, tick, streamConnected }: {
  analysis: PriceActionAnalysis
  evidence?: TradingEvidence
  prediction: EarlyPrediction
  activeTrade?: PredictionRecord
  instrument: string
  interval: PriceActionInterval
  now: number
  tick?: AngelOneStreamTick
  streamConnected: boolean
}) {
  const plan = activeTrade ?? ('plan' in prediction ? prediction.plan : undefined)
  const side = activeTrade?.side ?? prediction.side
  const tone = side === 'CALL' ? 'bullish' : side === 'PUT' ? 'bearish' : 'neutral'
  const status = activeTrade ? 'CONFIRMED · OPEN' : plan?.stage === 'CONFIRMED' ? 'CONFIRMED SETUP · AWAITING ENTRY' : plan ? 'EARLY ANALYSIS · NO TRADE' : 'WAIT · NO TRADE'
  const reason = activeTrade
    ? `Monitoring the live ${activeTrade.side} trade. The agent records its profit or loss before another ${instrument} trade can start.`
    : prediction.reason
  const entry = activeTrade?.entryPrice ?? plan?.entry
  const recordQuoteAt = activeTrade?.latestPriceAt
  const useTick = tick?.ltp !== undefined && Number.isFinite(tick.ltp) && tick.ltp > 0 && (!activeTrade || (tickTimestamp(tick) >= (recordQuoteAt ?? activeTrade.entryAt ?? 0)))
  const quote = useTick ? tick?.ltp : activeTrade?.latestPrice
  const quoteAt = useTick ? tickTimestamp(tick!) : recordQuoteAt
  const quoteIsLive = useTick ? isFreshTick(tick, now) : activeTrade?.latestPriceSource === 'LIVE' && quoteAt !== undefined && now - quoteAt >= -5_000 && now - quoteAt <= 60_000
  const live = streamConnected && quoteIsLive
  const current = quote ?? analysis.currentPrice
  const quoteLabel = quote !== undefined ? live ? 'Live index price' : activeTrade?.latestPriceSource === 'CANDLE' && !useTick ? 'Last candle close' : 'Last index quote' : 'Last closed candle'
  // This is index movement, not an option premium or a rupee return.
  const movement = activeTrade?.entryPrice !== undefined && quote !== undefined ? (quote - activeTrade.entryPrice) * (activeTrade.side === 'CALL' ? 1 : -1) : undefined
  const points = movement === 0 ? 0 : movement
  const progress = plan && quote !== undefined && plan.target !== plan.stopLoss ? Math.max(0, Math.min(100, (quote - plan.stopLoss) / (plan.target - plan.stopLoss) * 100)) : undefined
  const marketBias = evidence?.bias ?? analysis.earlyBias
  const marketTone = marketBias === 'BULLISH' ? 'bullish' : marketBias === 'BEARISH' ? 'bearish' : 'neutral'
  const direction = marketBias === 'BULLISH' ? 'BUY' : marketBias === 'BEARISH' ? 'SELL' : 'NEUTRAL'
  const marketView = marketBias === 'NEUTRAL' ? 'NEUTRAL' : evidence ? evidence.canConfirm && 'plan' in prediction && prediction.plan.stage === 'CONFIRMED' ? `CONFIRMED ${direction}` : `EARLY ${direction}` : analysis.earlyStage === 'TRIGGER' ? `${direction} TRIGGER` : analysis.earlyStage === 'CONFIRMED' ? `CONFIRMED ${direction}` : `EARLY ${direction}`
  const bullishScore = evidence?.bullishScore ?? analysis.bullishScore, bearishScore = evidence?.bearishScore ?? analysis.bearishScore
  const bullishEvidence = evidence?.bullishEvidence ?? analysis.bullishEvidence, bearishEvidence = evidence?.bearishEvidence ?? analysis.bearishEvidence
  const strength = evidence ? Math.max(bullishScore, bearishScore) < 30 ? 'NO BIAS' : marketBias === 'NEUTRAL' ? 'CONFLICTED' : Math.max(bullishScore, bearishScore) < evidence.requiredScore ? 'WEAK' : 'ALIGNED' : analysis.earlyStrength.replace(/_/g, ' ')
  const details = [['Structure', analysis.structure], ['Location', analysis.location], ['Last closed candle', analysis.candleBehavior], ['Setup', analysis.setup]]
  const historical = analysis.latestCandleTime && now - Date.parse(analysis.latestCandleTime) > 2 * candleIntervalMs(interval)

  return (
    <div className={`agent-trade-card agent-tone-${tone}`}>
      <div className="agent-trade-heading">
        <strong className="agent-trade-title"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true"><path d="M3 17l6-6 4 3 8-9M15 5h6v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>{activeTrade || plan?.stage === 'CONFIRMED' ? 'Agent Trade' : 'Trading Prediction Agent'}</strong>
        <span className={`agent-trade-status ${activeTrade ? 'is-open' : ''}`} role="status">{status}</span>
      </div>
      <div className="agent-trade-direction-row">
        <strong className="agent-trade-direction">{side === 'WAIT' ? 'WAIT' : `${side} · ${side === 'CALL' ? 'BULLISH' : 'BEARISH'}`}</strong>
        <div className="agent-trade-instrument"><strong>{instrument}</strong><span>{timeframe(activeTrade?.interval ?? interval)} · Index levels</span></div>
      </div>
      <div className="early-prediction-result" aria-live="polite"><p>{reason}</p></div>
      {!plan && current !== undefined && <div className="agent-quote-preview"><span>{quoteLabel}</span><strong>{price(current)}</strong><small>{time(quoteAt ?? (analysis.latestCandleTime ? Date.parse(analysis.latestCandleTime) : undefined))}</small></div>}
      {plan && <dl className="agent-trade-facts">
        <div><dt>{activeTrade ? 'Entry (index)' : 'Entry trigger (index)'}</dt><dd>{price(entry)}</dd></div>
        <div><dt>{quoteLabel}</dt><dd className={live ? 'agent-text-bullish' : ''}>{price(current)}</dd><small>{quoteAt !== undefined ? time(quoteAt) : analysis.latestCandleTime ? time(Date.parse(analysis.latestCandleTime)) : 'Waiting for data'}</small></div>
        <div><dt>{activeTrade ? 'Entry time' : 'Setup time'}</dt><dd className="agent-trade-time">{time(activeTrade?.entryAt ?? plan?.generatedAt)}</dd></div>
        <div><dt>{activeTrade ? 'Trade timeframe' : 'Analysis timeframe'}</dt><dd className="agent-trade-time">{timeframe(activeTrade?.interval ?? interval)}</dd></div>
        <div><dt>Stop-loss (index)</dt><dd className="agent-text-bearish">{price(plan?.stopLoss)}</dd></div>
        <div><dt>Target (index)</dt><dd className="agent-text-bullish">{price(plan?.target)}</dd></div>
      </dl>}
      {plan && <div className="agent-trade-progress" aria-label="Index price between stop-loss and target">
        <div className="agent-trade-progress-track">{progress !== undefined && <span className="agent-trade-progress-marker" style={{ '--trade-progress': `${progress}%` } as CSSProperties} />}</div>
        <div className="agent-trade-progress-labels"><span>SL <strong>{price(plan.stopLoss)}</strong></span><span>{quote === undefined ? 'Waiting for quote' : `${live ? 'Now' : 'Last'} ${price(quote)}`}</span><span>TGT <strong>{price(plan.target)}</strong></span></div>
      </div>}
      {plan && <div className="agent-trade-summary">
        <div><span>{activeTrade ? 'Unrealized profit / loss' : 'Trade profit / loss'}</span><strong className={points !== undefined ? points >= 0 ? 'agent-text-bullish' : 'agent-text-bearish' : ''}>{points === undefined ? '—' : `${points > 0 ? '+' : ''}${price(points)} pts`}</strong><small>{activeTrade ? live ? 'Index points · Live quote' : 'Index points · Last available quote' : 'Available after confirmed entry'}</small></div>
        <div><span>Reward : risk</span><strong>{plan ? `${plan.riskReward.toFixed(2)} : 1` : '—'}</strong><small>Based on planned index levels</small></div>
      </div>}
      {plan && <p className="agent-trade-note">{activeTrade ? 'Agent-managed exit · One live trade per index' : plan.stage === 'CONFIRMED' ? `Conditional entry · Entry expires after 3 × ${timeframe(plan.interval)} · Trade tracking starts when entry is observed` : 'Early analysis only · Not recorded as a trade'} · {plan.evidenceSummary ? 'Chart + available market evidence' : plan.contextMode === 'NEWS_ALIGNED' ? 'Chart + supporting public news' : 'Chart evidence; news alignment unavailable or neutral'}<br />{plan.targetBasis}</p>}

      <div className="agent-market-view">
        <div className="agent-market-view-heading"><strong className={`agent-text-${marketTone}`}>Market view: {marketView}</strong><span>· {strength}</span></div>
        <p className="agent-analysis-time">{timeframe(interval)} analysis · {analysis.analyzedCandles} completed candles · Forming candle excluded{historical ? ' · Historical snapshot' : ''}</p>
        <div className="agent-evidence-scores"><span className="agent-text-bullish">Bullish score: <strong>{bullishScore}/100</strong></span><span className="agent-text-bearish">Bearish score: <strong>{bearishScore}/100</strong></span></div>
        <p className="agent-score-note">Weighted evidence score, not probability.{evidence && ` Available evidence: ${evidence.coverage}%. Missing inputs do not increase other weights.`}</p>
        <div className="agent-evidence-columns">
          {([['Bullish evidence', bullishEvidence, 'bullish'], ['Bearish evidence', bearishEvidence, 'bearish']] as const).map(([label, items, evidenceTone]) => <div key={label}><strong className={`agent-text-${evidenceTone}`}>{label}</strong>{items.length ? <ul>{items.map(item => <li key={item}>{item}</li>)}</ul> : <p>None currently</p>}</div>)}
        </div>
      </div>
      <dl className="agent-structure-details">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {evidence && <details className="agent-evidence-checks"><summary>Inputs & confirmation checks · {evidence.coverage}% available</summary>
        <div className="agent-evidence-table"><table><thead><tr><th>Input</th><th>Weight</th><th>Available</th><th>Bullish</th><th>Bearish</th></tr></thead><tbody>{evidence.layers.map(layer => <tr key={layer.key}><th>{layer.name}</th><td>{layer.weight}%</td><td>{Math.round(layer.coverage * 100)}%</td><td>{layer.bullish.toFixed(1)}</td><td>{layer.bearish.toFixed(1)}</td></tr>)}</tbody></table></div>
        <p>Confirmation needs a completed chart setup, ≥60% evidence coverage, ≥{evidence.requiredScore} directional support, a ≥20-point lead and at least two external evidence groups. ATR and India VIX provide risk checks.</p>
        <ul>{evidence.riskNotes.map(note => <li key={note}>{note}</li>)}{evidence.missing.map(item => <li key={item}>Unavailable: {item}</li>)}</ul>
      </details>}
    </div>
  )
}
