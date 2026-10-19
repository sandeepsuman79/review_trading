import { readTradeTransitions } from '../analysis/agentMonitoring'
import { isCommodity, tradeDirection } from '../analysis/commodities'
import type { AngelOneStreamTick } from '../api/angelOne'
import type { PredictionPlan } from '../analysis/earlyPrediction'
import type { CandidateDecision, DecisionCheck } from '../analysis/tradeDecision'
import { readTradeDiagnostics } from '../analysis/tradeDecision'
import { diagnoseTradeEntry } from '../analysis/tradeEntry'

function Checks({ checks }: { checks: DecisionCheck[] }) {
  return <ul>{checks.map(check => <li key={check.code}><strong className={check.status === 'PASS' ? 'agent-text-bullish' : check.status === 'FAIL' ? 'agent-text-bearish' : ''}>{check.status.replace('_', ' ')} · {check.label}</strong><span>{check.detail}</span>{check.status === 'FAIL' && <small>{check.code}</small>}</li>)}</ul>
}
export default function TradeDecisionPanel({ decisions, instrument, plan, tick, connected, now, active, issuedAt, retired = false }: {
  decisions: CandidateDecision[]; instrument: string; plan?: PredictionPlan; tick?: AngelOneStreamTick; connected: boolean; now: number; active: boolean; issuedAt?: number; retired?: boolean
}) {
  const label = (side: string) => isCommodity(instrument) ? tradeDirection(instrument, side) : side === 'CALL' ? 'CALL / CE' : 'PUT / PE'
  const state = (decision: CandidateDecision) => retired && decision.state === 'CONFIRMED' ? 'SETUP ENDED' : decision.state
  const entry = retired ? { state: 'SETUP ENDED', checks: [] } : diagnoseTradeEntry(plan, tick, connected, now, active, issuedAt)
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 2, instrument, assessments: readTradeDiagnostics(instrument), tradeTransitions: readTradeTransitions(instrument) }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${instrument.replace(/ /g, '-')}-agent-evaluations.json`; link.click(); URL.revokeObjectURL(url)
  }
  return <details className="agent-decision-diagnostics">
    <summary>{isCommodity(instrument) ? 'LONG / SHORT' : 'CALL / PUT'} decisions · {decisions.map(decision => `${label(decision.side)} ${state(decision)}`).join(' · ')}</summary>
    <div className="agent-decision-row" tabIndex={0} aria-label="Scroll CALL and PUT decision diagnostics horizontally">
      {decisions.map(decision => <section className="agent-decision-side" key={decision.side} aria-label={`${label(decision.side)} decision`}>
        <strong className={decision.side === 'CALL' ? 'agent-text-bullish' : 'agent-text-bearish'}>{label(decision.side)} · {state(decision)}{decision.quality && ` · ${decision.quality}`}</strong>
        <p>Support {decision.supportScore}/100 · Opposition {decision.opposingScore}/100 · Lead {decision.lead} · Coverage {decision.coverage}%</p>
        <p>{decision.setup}</p>
        {decision.entry !== undefined && <p>Entry {decision.entry.toFixed(2)} · SL {decision.stopLoss!.toFixed(2)} · Target {decision.target!.toFixed(2)} · RR {decision.riskReward!.toFixed(2)}:1</p>}
        <Checks checks={decision.checks} />
      </section>)}
    </div>
    <div className="agent-entry-diagnostics"><strong>Entry tracking · {entry.state}</strong><Checks checks={entry.checks} /></div>
    <p>Early candidates and risky proposals are not entered trades. The evaluation log includes up to 400 changed assessments and 400 trade state/reason changes in memory for this page session.</p>
    <button type="button" onClick={download}>Download evaluation log</button>
  </details>
}
