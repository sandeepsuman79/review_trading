import type { IndicatorTrajectoryRow } from '../analysis/scoreTrajectory'
import type { TimeframeTrajectories } from '../hooks/useTimeframeTrajectories'
import type { MultiTimeframeAssessment } from '../analysis/multiTimeframe'
import type { PredictionRecord } from '../analysis/predictionHistory'
import { isCommodity, tradeDirection } from '../analysis/commodities'
import { timeframeInfo } from '../analysis/timeframes'

const indicatorTone = (row: IndicatorTrajectoryRow) => {
  if (row.risk || row.movement === 'WAITING' || row.movement === 'FLAT') return ''
  const bullish = (row.movement === 'RISING') !== (row.name === '-DI')
  return bullish ? 'agent-text-bullish' : 'agent-text-bearish'
}

const clock = (value: number) => new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })

export default function MultiTimeframePanel({ assessment, activeTrade, connected = true, now, trajectories }: {
  trajectories?: TimeframeTrajectories; assessment: MultiTimeframeAssessment; activeTrade?: PredictionRecord; connected?: boolean; now: number
}) {
  return <details open className="agent-multi-timeframe" aria-label="Multi-timeframe technical analysis">
    <summary className="agent-market-view-heading"><strong>Timeframe analysis · {assessment.instrument}</strong><span>{assessment.selectedPlan ? `${timeframeInfo[assessment.selectedPlan.interval].label} · ${tradeDirection(assessment.instrument, assessment.selectedPlan.side)}` : 'Waiting for a qualified setup'}</span></summary>
    <p className="agent-score-note">Continuation: accepted breakout or pullback with ADX strength, the selected indicator and no opposing higher trend (5m → 15m; 15m → 1h). Reversal: proven opposing-structure break, a momentum turn and stricter scores; EMA crossover may lag. Hourly entries use their own context. Scores stay separate. Newest qualified setup wins; ties prefer 5-minute. Forming candles cannot confirm.</p>
    <div className="agent-timeframe-row" tabIndex={0} aria-label="Scroll timeframe assessments horizontally">
      {assessment.reviews.map(review => {
        const fresh = review.current && now >= review.reviewedAt && now - review.reviewedAt <= 30_000
        const tone = !fresh ? 'neutral' : review.evidence.bias === 'BULLISH' ? 'bullish' : review.evidence.bias === 'BEARISH' ? 'bearish' : 'neutral'
        const trajectory = trajectories?.[review.interval]
        const selected = review.plan?.id === assessment.selectedPlan?.id && Boolean(review.plan)
        return <article key={review.interval} className={`agent-structure-item agent-tone-${tone}`} aria-label={`${timeframeInfo[review.interval].label} analysis`}>
          <div className="agent-market-view-heading"><strong>{timeframeInfo[review.interval].label}</strong>{selected && <span>Selected entry</span>}</div>
          <p className={`agent-text-${tone}`}><strong>{review.plan ? tradeDirection(assessment.instrument, review.plan.side) : review.evidence.bias}</strong> · {fresh || review.status === 'WARMING_UP' ? review.status.replace('_', ' ') : 'Waiting for current data'}</p>
          <p className="agent-score-note">Bullish {review.evidence.bullishScore}/100 · Bearish {review.evidence.bearishScore}/100 · Coverage {review.evidence.coverage}%</p>
          <p>{review.analysis.setup}</p>
          <p className="agent-score-note">{review.closedAt ? `Last candle closed ${clock(review.closedAt)} IST` : 'Waiting for completed history'}</p>
          <details className="timeframe-trajectory">
            <summary className="trajectory-title"><span>Trajectory <span className={trajectory?.state === 'BULLISH_PRESSURE' ? 'agent-text-bullish' : trajectory?.state === 'BEARISH_PRESSURE' ? 'agent-text-bearish' : ''}>{trajectory?.state === 'BULLISH_PRESSURE' ? '↑' : trajectory?.state === 'BEARISH_PRESSURE' ? '↓' : '↔'}</span> · {trajectory?.state === 'WARMING_UP' || !trajectory ? '◷ Warming up' : trajectory.state === 'BULLISH_PRESSURE' ? '↑ Bullish pressure' : trajectory.state === 'BEARISH_PRESSURE' ? '↓ Bearish pressure' : trajectory.state === 'UNAVAILABLE' ? 'Unavailable' : '↔ Mixed'}</span><span className="trajectory-title-scores"><span className="agent-text-bullish">Bullish {review.evidence.bullishScore.toFixed(1)}</span> / <span className="agent-text-bearish">Bearish {review.evidence.bearishScore.toFixed(1)}</span></span></summary>
            <div className="timeframe-score-changes"><span className="agent-text-bullish">Bullish Δ <strong>{trajectory?.bullDelta === undefined ? '—' : `${trajectory.bullDelta >= 0 ? '+' : ''}${trajectory.bullDelta.toFixed(1)}`}</strong></span><span className="agent-text-bearish">Bearish Δ <strong>{trajectory?.bearDelta === undefined ? '—' : `${trajectory.bearDelta >= 0 ? '+' : ''}${trajectory.bearDelta.toFixed(1)}`}</strong></span></div>
            {trajectory?.indicators && <div className="timeframe-indicators" aria-label={`${timeframeInfo[review.interval].label} indicator changes`}>
              {trajectory.indicators.filter(row => row.name !== 'India VIX' || !isCommodity(assessment.instrument)).map(row => <div className="timeframe-indicator-row" key={row.name}>
                <div><strong>{({ EMA20: 'EMA 20', EMA50: 'EMA 50', RSI: 'RSI (14)', ATR: 'ATR (14)', ADX: 'ADX (14)', SMA20: 'SMA 20' } as Record<string, string>)[row.name] ?? row.name}</strong><span>{row.value === undefined ? 'Unavailable' : row.value.toFixed(2)}{row.direction ? ` · ${row.direction}` : ''}</span></div>
                <small className={indicatorTone(row)}>{row.movement === 'RISING' ? '↑ Low → high' : row.movement === 'FALLING' ? '↓ High → low' : row.movement === 'FLAT' ? '↔ Flat' : 'Waiting for movement'}{row.structure?.trend !== 'WARMING_UP' && row.structure ? ` · ${row.structure.pattern}${row.structure.trend === 'UPTREND' ? ' uptrend' : row.structure.trend === 'DOWNTREND' ? ' downtrend' : ' mixed'}` : ' · Swings forming'}{row.structure?.breakDirection ? ` · Structure break ${row.structure.breakDirection === 'UP' ? '↑' : '↓'}` : ''}</small>
                <small>{row.change === undefined ? 'Waiting for previous candle' : `${row.movement === 'RISING' ? '↑' : row.movement === 'FALLING' ? '↓' : '↔'} ${row.change >= 0 ? '+' : ''}${row.change.toFixed(2)} vs previous candle`}{row.turn === 'FROM_PEAK' ? ' · Turning down from peak' : row.turn === 'FROM_TROUGH' ? ' · Turning up from trough' : ''}</small>
                {row.low !== undefined && row.high !== undefined && <small>Recent low {row.low.toFixed(2)} / high {row.high.toFixed(2)}{row.risk ? ' · Risk / strength context' : ''}</small>}
              </div>)}
            </div>}
            <p className="agent-score-note">{trajectory?.detail ?? 'Waiting for three consecutive completed score observations on this timeframe.'}</p>
          </details>
          <details><summary>Decision</summary><p className="agent-score-note">{review.reason}</p></details>
        </article>
      })}
    </div>
    <p className="agent-score-note">Indicator changes update on each completed candle of their own timeframe. India VIX is a shared risk quote sampled at those observations.</p>
    {assessment.conflicts && <p className="agent-score-note" role="status">Timeframes currently disagree. Scores stay separate; continuations cannot oppose their required higher trend. Reversals need a proven structure break, a momentum turn and stricter scores; missing higher history always blocks.</p>}
    {activeTrade && <p className="agent-score-note">Open trade: {tradeDirection(activeTrade.instrument, activeTrade.side)} · Entry timeframe {timeframeInfo[activeTrade.interval].label}. A fresh fully confirmed opposite setup can close it before any replacement trade.</p>}
    {!connected && <p className="agent-score-note" role="status">Stream disconnected · Entries and live exits wait for a fresh matching quote.</p>}
  </details>
}
