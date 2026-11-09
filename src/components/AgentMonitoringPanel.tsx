import type { CommodityContract } from '../analysis/commodities'
import { useEffect, useRef, useState } from 'react'
import type { PredictionPlan } from '../analysis/earlyPrediction'
import type { PredictionRecord } from '../analysis/predictionHistory'
import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import type { AtmVwapSnapshot } from '../api/atmVwap'
import { chartIntervals, defaultChartInterval, timeframeInfo } from '../analysis/timeframes'
import { readIntrabarContext } from '../analysis/intrabarContext'
import { buildAgentMonitoringExport, contractExpiryNotice, readTradeTransitions, signalFreshness, trackedPerformance } from '../analysis/agentMonitoring'
const time = (value: number) => new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })
const r = (value?: number) => value === undefined ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}R`

export default function AgentMonitoringPanel({ instrument, records, plan, active, now, frontContract, candles = [], tick, issuedAt, connected = false, atmVwap }: {
  instrument: string; records: PredictionRecord[]; plan?: PredictionPlan; active: boolean; now: number; frontContract?: CommodityContract; candles?: AngelOneCandle[]; tick?: AngelOneStreamTick; issuedAt?: number; connected?: boolean; atmVwap?: AtmVwapSnapshot
}) {
  const [expanded, setExpanded] = useState(false)
  const latest = useRef({ records, now }); latest.current = { records, now }
  const reviewMinute = Math.floor(now / 60_000)
  // Quote updates replace the records array frequently. Review the ledger at minute
  // boundaries or disclosure toggles, rather than sorting it on every live render.
  const performanceInterval = plan && (chartIntervals as readonly string[]).includes(plan.interval) ? plan.interval as typeof chartIntervals[number] : defaultChartInterval
  const strategyVersion = plan?.strategyVersion ?? 'candle-v2'
  const [performance, setPerformance] = useState(() => trackedPerformance(records, instrument, now, performanceInterval, strategyVersion))
  useEffect(() => { setPerformance(trackedPerformance(latest.current.records, instrument, latest.current.now, performanceInterval, strategyVersion)) }, [instrument, performanceInterval, strategyVersion, reviewMinute, expanded, records.length])
  const freshness = plan?.stage === 'CONFIRMED' && !active ? signalFreshness(plan, now, issuedAt) : undefined
  const expiry = contractExpiryNotice(plan?.contract ?? frontContract, now, frontContract)
  const events = expanded ? readTradeTransitions(instrument).slice(-10).reverse() : []
  const intrabar = tick ? readIntrabarContext(tick, now) : undefined
  function exportReplay() {
    const payload = buildAgentMonitoringExport({ instrument, candles, records, plan, tick, connected, now, contract: frontContract, atmVwap, issuedAt })
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${instrument.replace(/ /g, '-')}-agent-monitoring.json`; link.click(); URL.revokeObjectURL(url)
  }
  return <details className="agent-evidence-checks agent-monitoring" onToggle={event => setExpanded(event.currentTarget.open)}><summary>Agent monitoring · {performance.state === 'REVIEW' ? 'Review recent results · ' : ''}Freshness, results & decision trail</summary>
    {freshness && <div aria-label="Signal freshness"><strong>Entry window remaining: {Math.round(freshness.remainingPercent)}% · {freshness.remainingSeconds}s</strong><progress max={100} value={freshness.remainingPercent} aria-label="Entry window remaining" /><p>Candle closed {time(freshness.closedAt)} · Setup first issued {time(freshness.issuedAt)} · Age {freshness.ageSeconds}s · Deadline {time(freshness.deadline)} IST. This measures time remaining; technical scores are unchanged.</p></div>}
    {expiry && <p className="agent-entry-status" role="status">{expiry}</p>}
    <div aria-label="Observed intrabar context"><strong>Observed quote context · {intrabar?.state.replace(/_/g, ' ') ?? 'WAITING FOR QUOTES'}</strong>
      {intrabar?.state === 'OBSERVED' ? <p>{intrabar.priceChange! > 0 ? '+' : ''}{intrabar.priceChange!.toFixed(2)} price points over {(intrabar.spanMs / 1000).toFixed(1)}s · {intrabar.sampleCount} sampled quotes for token {tick!.token}{intrabar.cumulativeVolumeDelta !== undefined ? ` · Cumulative traded-volume change ${intrabar.cumulativeVolumeDelta.toLocaleString('en-IN')}` : ' · Traded volume unavailable'}.</p> : <p>Needs at least five seconds of current observations. Missing or stale quotes cannot supply a live movement reading.</p>}
      <p className="agent-score-note">Actual received quotes in the last 30 seconds. Quote count is not traded volume; this context does not add a technical vote or change entry rules.</p>
    </div>
    <strong>Tracked performance · {timeframeInfo[performanceInterval].label} · {performance.state.replace(/_/g, ' ')}</strong>
    <p role={performance.state === 'REVIEW' ? 'status' : undefined}>{performance.reason}</p>
    <p>Recent {performance.recentCount}: {r(performance.recentR)} average · Previous {performance.baselineCount}: {r(performance.baselineR)} · Consecutive losses {performance.lossStreak} · Ambiguous/unverified records excluded: {performance.excluded}.</p>
    <p className="agent-score-note">Results refresh each minute and when this panel opens. R uses each trade’s recorded underlying/futures stop distance. These are local tracked results before execution costs, not option-premium returns. The review flag never changes live thresholds or places orders.</p>
    <strong>Recent state changes</strong>
    {events.length ? <ol className="agent-transition-list">{events.map((event, i) => <li key={`${event.recordId}:${event.observedAt}:${i}`}><strong>{time(event.observedAt)} IST · {event.from} → {event.to}</strong>{event.contract && <small>Contract: {event.contract}</small>}<span>{event.reason}</span>{event.quote !== undefined && <small>{event.quoteSource === 'LIVE' ? 'Observed live quote' : event.quoteSource === 'CANDLE' ? 'Recorded candle close' : 'Recorded price'} {event.quote.toFixed(2)}{event.quoteAt !== undefined ? ` at ${time(event.quoteAt)} IST` : ''}</small>}</li>)}</ol> : <p>New state changes appear here during this page session. Loading saved trades does not create events.</p>}
    <button type="button" onClick={exportReplay}>Export candles and agent diagnostics</button>
    <p className="agent-score-note">Includes up to 5,000 completed five-minute candles{frontContract ? ` for ${frontContract.symbol}` : ''}, observed CALL/PUT checks, trade transitions, saved outcomes, current quote/connection and ATM VWAP context. Broker credentials are excluded. The current quote cannot recreate historical fills. Candle-only replay needs at least 20 completed price bars; archived indicator policies retain their own requirements.</p>
  </details>
}
