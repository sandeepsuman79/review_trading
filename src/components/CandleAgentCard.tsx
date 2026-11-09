import { isCandleStrategy } from '../analysis/strategyPolicy'
import { currentTradeTarget, usesStructureTargets } from '../analysis/tradeTargets'
import type { CandleAssessment } from '../analysis/candleAgent'
import type { PredictionRecord } from '../analysis/predictionHistory'
import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import type { CommodityContract } from '../analysis/commodities'
import { isCommodity } from '../analysis/commodities'
import { diagnoseTradeEntry } from '../analysis/tradeEntry'
import { isFreshTick } from '../analysis/candleData'
import AgentMonitoringPanel from './AgentMonitoringPanel'

const price = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
export default function CandleAgentCard({ assessment, active, pending, records, candles, tick, connected, now, contract }: {
  assessment: CandleAssessment; active?: PredictionRecord; pending?: PredictionRecord; records: PredictionRecord[]; candles: AngelOneCandle[]
  tick?: AngelOneStreamTick; connected: boolean; now: number; contract?: CommodityContract
}) {
  const plan = active ?? assessment.plan, signal = assessment.signal
  const opposite = active && assessment.current && signal && signal.side !== active.side && Date.parse(signal.asOf) + 300000 > (active.entryAt ?? Infinity)
  const decision = active ? opposite ? `EXIT ${active.side}` : `HOLD ${active.side}` : assessment.plan ? `CONFIRMED ${assessment.plan.side}` : assessment.state
  const quote = connected && isFreshTick(tick, now) ? tick?.ltp : active?.latestPrice
  const entry = active?.entryPrice ?? plan?.entry, d = plan?.side === 'CALL' ? 1 : -1
  const profit = active && quote !== undefined && entry !== undefined ? (quote - entry) * d : undefined
  const entryCheck = diagnoseTradeEntry(assessment.plan, tick, connected, now, Boolean(active), pending?.generatedAt)
  const lastExit = records.filter(r => r.instrument === assessment.instrument && r.exitAt !== undefined && r.status !== 'ACTIVE').reduce<PredictionRecord | undefined>((latest, r) => !latest || r.exitAt! > latest.exitAt! ? r : latest, undefined)
  return <section className="agent-trade-card" aria-label="Five-minute candlestick agent">
    <div className="agent-market-view-heading"><strong>5-minute candlestick agent · {assessment.instrument}</strong><span>{decision}</span></div>
    <p className={plan?.side === 'CALL' ? 'agent-text-bullish' : plan?.side === 'PUT' ? 'agent-text-bearish' : ''}><strong>{decision}</strong>{plan && !isCommodity(assessment.instrument) ? ` · ${plan.side === 'CALL' ? 'CE direction' : 'PE direction'}` : ''}</p>
    <p>{active ? opposite ? 'Opposite completed candlestick pattern: exit waits for a fresh matching quote after the candle close.' : 'Stop and TSL remain active. A sideways reading keeps protection in place.' : assessment.reason}</p>
    <p className="agent-score-note">{assessment.completedBars} completed five-minute candles · Pattern: {(signal?.pattern ?? active?.candleConfirmation?.pattern ?? 'None').replace(/_/g, ' ')} · Candlestick and price structure only</p>
    {assessment.asOf && <p className="agent-score-note">Last candle closed {new Date(Date.parse(assessment.asOf) + 300000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST</p>}
    {assessment.structure && <p className="agent-score-note">Price structure: {assessment.structure.trend.replace(/_/g, ' ')} · Recent swings: {assessment.structure.swings.slice(-4).map(s => `${s.label} ${price(s.price)}`).join(' → ') || 'Not yet confirmed'}{assessment.structure.gap ? ` · Observed session gap ${assessment.structure.gap.direction}: ${assessment.structure.gap.state}` : ''}</p>}
    <dl className="agent-trade-facts">
      <div><dt>Entry</dt><dd>{price(entry)}</dd></div>
      <div><dt>Current target</dt><dd>{price(active ? currentTradeTarget(active) : plan?.target)}</dd></div>
      <div><dt>Initial stop-loss</dt><dd>{price(plan?.stopLoss)}</dd></div>
      <div><dt>Current TSL</dt><dd>{price(active?.protection?.stop ?? plan?.stopLoss)}</dd></div>
      <div><dt>{active ? 'Observed P/L points' : 'Planned reward/risk'}</dt><dd>{active ? price(profit) : plan ? `${plan.riskReward.toFixed(2)}:1` : '—'}</dd></div>
    </dl>
    <p className="agent-score-note">Support {price(assessment.support)} · Resistance {price(assessment.resistance)}. Reward/risk is informational; no minimum ratio. {active && !usesStructureTargets(active) ? 'This saved indicator-era trade retains its open-profit reference and recorded trailing policy. Current candlestick patterns can confirm its exit.' : 'At target: book profit or extend to the next confirmed level with fresh same-direction evidence. After +1R, a 35% retreat from best observed profit triggers protection.'} {active && !isCandleStrategy(active.strategyVersion) ? 'Saved trailing policy remains in place.' : 'Candle-only trades trail by initial price risk and confirmed swings, reach break-even at +1R, and never loosen.'}</p>
    {active?.targetManagement && <p role="status" className="agent-score-note">Target extended {active.targetManagement.revisions} time(s) · Initial {price(active.target)} → Current {price(currentTradeTarget(active))} · {active.targetManagement.basis}</p>}
    {!connected && <p role="status">Stream disconnected · Waiting for a fresh quote to enter or exit.</p>}
    <details className="agent-evidence-checks"><summary>Candlestick checks</summary><ul>{assessment.checks.map(check => <li key={check.code}><strong>{check.passed ? '✓' : 'Waiting'} · {check.label}</strong><span>{check.detail}</span></li>)}</ul></details>
    {!active && <details className="agent-evidence-checks"><summary>Entry · {entryCheck.state}</summary><ul>{entryCheck.checks.map(check => <li key={check.code}><strong>{check.status} · {check.label}</strong><span>{check.detail}</span></li>)}</ul></details>}
    {!active && lastExit && <p className="agent-score-note">Last exit: {lastExit.side} · {lastExit.status.replace(/_/g, ' ')} · {price(lastExit.exitPrice)} · {lastExit.outcomeNote}</p>}
    <AgentMonitoringPanel instrument={assessment.instrument} records={records} plan={assessment.plan} active={Boolean(active)} candles={candles} tick={tick} connected={connected} now={now} frontContract={contract} issuedAt={pending?.generatedAt} />
  </section>
}
