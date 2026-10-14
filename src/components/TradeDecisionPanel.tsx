import type { AngelOneStreamTick } from '../api/angelOne'
import type { PredictionPlan } from '../analysis/earlyPrediction'
import type { CandidateDecision, DecisionCheck } from '../analysis/tradeDecision'
import { readTradeDiagnostics } from '../analysis/tradeDecision'
import { diagnoseTradeEntry } from '../analysis/tradeEntry'

function Checks({ checks }: { checks: DecisionCheck[] }) {
  return <ul>{checks.map(check => <li key={check.code}><strong className={check.status === 'PASS' ? 'agent-text-bullish' : check.status === 'FAIL' ? 'agent-text-bearish' : ''}>{check.status.replace('_', ' ')} · {check.label}</strong><span>{check.detail}</span>{check.status === 'FAIL' && <small>{check.code}</small>}</li>)}</ul>
}
export default function TradeDecisionPanel({ decisions, instrument, plan, tick, connected, now, active, issuedAt }: {
  decisions: CandidateDecision[]; instrument: string; plan?: PredictionPlan; tick?: AngelOneStreamTick; connected: boolean; now: number; active: boolean; issuedAt?: number
}) {
  const entry = diagnoseTradeEntry(plan, tick, connected, now, active, issuedAt)
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(readTradeDiagnostics(instrument), null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${instrument.replace(/ /g, '-')}-agent-evaluations.json`; link.click(); URL.revokeObjectURL(url)
  }
  return <details className="agent-decision-diagnostics">
    <summary>CALL / PUT decisions · {decisions.map(decision => `${decision.side === 'CALL' ? 'CE' : 'PE'} ${decision.state}`).join(' · ')}</summary>
    <div className="agent-decision-row" tabIndex={0} aria-label="Scroll CALL and PUT decision diagnostics horizontally">
      {decisions.map(decision => <section className="agent-decision-side" key={decision.side} aria-label={`${decision.side} decision`}>
        <strong className={decision.side === 'CALL' ? 'agent-text-bullish' : 'agent-text-bearish'}>{decision.side === 'CALL' ? 'CALL / CE' : 'PUT / PE'} · {decision.state}{decision.quality && ` · ${decision.quality}`}</strong>
        <p>Support {decision.supportScore}/100 · Opposition {decision.opposingScore}/100 · Lead {decision.lead} · Coverage {decision.coverage}%</p>
        <p>{decision.setup}</p>
        {decision.entry !== undefined && <p>Entry {decision.entry.toFixed(2)} · SL {decision.stopLoss!.toFixed(2)} · Target {decision.target!.toFixed(2)} · RR {decision.riskReward!.toFixed(2)}:1</p>}
        <Checks checks={decision.checks} />
      </section>)}
    </div>
    <div className="agent-entry-diagnostics"><strong>Entry tracking · {entry.state}</strong><Checks checks={entry.checks} /></div>
    <p>Early candidates and risky proposals are not entered trades. The evaluation log retains up to 400 changed assessments in memory for this page session.</p>
    <button type="button" onClick={download}>Download evaluation log</button>
  </details>
}
