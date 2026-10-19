import type { EvidenceLayer } from '../analysis/tradingEvidence'
/** Fixed-budget bars expose contributions without converting scores into probabilities. */
export default function ScoreContributions({ layers }: { layers: EvidenceLayer[] }) {
  return <div className="agent-contributions" aria-label="Score contributions">{layers.map(layer => <div className="agent-contribution" key={layer.key}>
    <strong>{layer.name} · {layer.weight}-point budget</strong><small>{Math.round(layer.coverage * 100)}% of inputs available</small>
    {(['bullish', 'bearish'] as const).map(side => <div className={`agent-contribution-bar ${side}`} key={side}><span>{side === 'bullish' ? 'Bullish' : 'Bearish'} {layer[side].toFixed(1)}</span><progress max={layer.weight} value={layer[side]} aria-label={`${layer.name} ${side} points`} /></div>)}
  </div>)}</div>
}
