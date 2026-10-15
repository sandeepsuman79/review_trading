import type { GapOutlook } from '../analysis/gapOutlook'
import { gapOutlookMinute, tradingSession } from '../analysis/tradingSession'

export default function GapOutlookCard({ instrument, outlook, error, now }: { instrument: string; outlook?: GapOutlook; error: string; now: number }) {
  const session = tradingSession(now), current = outlook?.session === session.date
  const label = outlook?.bias === 'GAP_UP_BIAS' ? '↑ Gap-up bias' : outlook?.bias === 'GAP_DOWN_BIAS' ? '↓ Gap-down bias' : 'Mixed · No clear gap direction'
  const waiting = !session.weekday ? 'Scheduled for the next weekday at 15:00 IST.' : session.minute < gapOutlookMinute ? 'Scheduled for today at 15:00 IST.'
    : session.minute === gapOutlookMinute ? 'Waiting for complete 14:59 candles and warmed-up indicators.' : 'Today’s 15:00 snapshot was unavailable. No outlook has been backdated.'
  return <details className="gap-outlook" open={current}>
    <summary><strong>Next-session gap outlook</strong><span>15:00 IST · {current ? label : session.weekday && session.minute > gapOutlookMinute ? 'Unavailable' : 'Scheduled'}</span></summary>
    <div className="gap-outlook-content">
      <p>{instrument} · Mon–Fri 15:00 IST · Next trading session, excluding weekends and exchange holidays.</p>
      {!current && <p role="status">{waiting}</p>}
      {error && <p className="ai-status-message is-error" role="status">{error}</p>}
      {outlook && <>
        <div className="gap-outlook-result"><strong className={outlook.bias === 'GAP_UP_BIAS' ? 'confirmed-pnl-profit' : outlook.bias === 'GAP_DOWN_BIAS' ? 'confirmed-pnl-loss' : ''}>{label}</strong><span>{!current && 'Previous snapshot · '}{new Date(outlook.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST</span></div>
        <p>Reference index {outlook.referencePrice.toLocaleString('en-IN', { maximumFractionDigits: 2 })} · Evidence score {outlook.evidenceScore > 0 ? '+' : ''}{outlook.evidenceScore.toFixed(1)}/100 · Coverage {outlook.coverage.toFixed(1)}%</p>
        <ul>{outlook.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        {outlook.missing.length > 0 && <details><summary>Unavailable inputs</summary><ul>{outlook.missing.map((item, i) => <li key={`${i}-${item}`}>{item}</li>)}</ul></details>}
      </>}
      <p className="gap-outlook-caveat">Pre-close evidence bias, not a calibrated probability or a confirmed trade. The remaining session and overnight news can change the opening gap. Keep the dashboard open at 15:00 IST to save the daily snapshot.</p>
    </div>
  </details>
}
