import { gapEvidenceComparison, gapOutlookThresholds, gapOutlookWindow, type GapOutlook } from '../analysis/gapOutlook'

export default function GapOutlookCard({ instrument, outlook, error, now }: { instrument: string; outlook?: GapOutlook; error: string; now: number }) {
  const window = gapOutlookWindow(now), current = Boolean(outlook && window && outlook.session === window.date && outlook.version === 2 && now >= outlook.generatedAt && now - outlook.generatedAt < 120000)
  const label = outlook?.bias === 'GAP_UP_BIAS' ? '↑ Gap-up bias' : outlook?.bias === 'GAP_DOWN_BIAS' ? '↓ Gap-down bias' : '↔ No clear direction'
  const tone = outlook?.bias === 'GAP_UP_BIAS' ? 'gap-bullish' : outlook?.bias === 'GAP_DOWN_BIAS' ? 'gap-bearish' : 'gap-neutral'
  const comparison = outlook ? gapEvidenceComparison(outlook) : undefined
  return <details className="gap-outlook" open={current}>
    <summary><strong>Next-session gap outlook</strong><span>{current ? label : window ? 'Updating' : 'After 15:00 IST'}</span></summary>
    <div className="gap-outlook-content">
      {error && <p className="ai-status-message is-error" role="status">{error}</p>}
      {outlook ? <>
        <div className="gap-outlook-result"><strong className={tone}>Prediction: {instrument} · {label}</strong><span>{!current && 'Last saved · '}{new Date(outlook.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST</span></div>
        <p className="gap-evidence-comparison">Evidence comparison: <span className="gap-bullish">↑ Up {comparison ? `${comparison.up.toFixed(1)}%` : '—'}</span> / <span className="gap-bearish">↓ Down {comparison ? `${comparison.down.toFixed(1)}%` : '—'}</span></p>
        <ul className="gap-input-summary" aria-label="Gap outlook input scores">{outlook.inputs?.length ? outlook.inputs.map((input, i) => <li key={`${input.name}-${i}`}>
          <span className={input.coverage === 0 || input.bullish === input.bearish ? 'gap-neutral' : input.bullish > input.bearish ? 'gap-bullish' : 'gap-bearish'}>{input.coverage === 0 ? '○' : input.bullish > input.bearish ? '↑' : input.bearish > input.bullish ? '↓' : '↔'} {input.name}:</span>{' '}
          <span className="gap-bullish">{input.bullish.toFixed(1)} bullish</span> / <span className="gap-bearish">{input.bearish.toFixed(1)} bearish</span> · {input.coverage.toFixed(0)}% available
        </li>) : <li>Input scores load with the next update.</li>}</ul>
        <p>Bias threshold: Up lead ≥ +{gapOutlookThresholds.minimumLead}; Down lead ≤ −{gapOutlookThresholds.minimumLead}; availability ≥ {gapOutlookThresholds.minimumCoverage}%.</p>
        <p>Current lead {outlook.evidenceScore > 0 ? '+' : ''}{outlook.evidenceScore.toFixed(1)} · Availability {outlook.coverage.toFixed(1)}% · {current && outlook.bias !== 'MIXED' ? '✓ Bias threshold met' : current ? '○ Threshold not met' : 'Saved reading; refreshing required'}</p>
      </> : <p role="status">{window ? 'Loading current inputs…' : 'Available after 15:00 IST and overnight until the next weekday open.'}</p>}
      <p className="gap-outlook-caveat">Percentages compare bullish/bearish evidence, not the probability of an opening gap. Updates as feeds refresh.</p>
    </div>
  </details>
}
