import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { connectAngelOneOrderStream, connectAngelOneStream, createGttRule, getAngelOneLtp, getAngelOneProfile, getAngelOneRms, getGttRuleDetails, getHistoricalCandles, getHistoricalOi, getInstrumentMaster, listGttRules, modifyGttRule, cancelGttRule, refreshAngelOneToken } from '../api/angelOne'
import type { AngelOneOrderUpdate } from '../api/angelOne'
import type { AngelOneStreamTick } from '../api/angelOne'
import type { AngelOneCandle, AngelOneGttRule, AngelOneProfile, AngelOneRms } from '../api/angelOne'
import { getAiPriceAction, type AiPriceAction } from '../api/ai'
import { analyzePriceAction, type PriceActionAnalysis } from '../analysis/priceAction'
import { applyLiveTick, completedCandles, tickTimestamp } from '../analysis/candleData'
import MarketContextPanel from '../components/MarketContextPanel'
import { useMarketContext } from '../hooks/useMarketContext'
import ErrorToast from '../components/ErrorToast'
import CandleChart from '../components/CandleChart'
import { buildEarlyPrediction, type EarlyPrediction, type PredictionPlan } from '../analysis/earlyPrediction'
import { usePredictionHistory } from '../hooks/usePredictionHistory'
import PredictionHistory from '../components/PredictionHistory'
import PredictionHeader from '../components/PredictionHeader'
import PredictionNotifications from '../components/PredictionNotifications'
import type { PredictionEvent } from '../analysis/predictionEvents'

function isInvalidToken(message: string) {
  return /invalid[\s_-]*token|token[\s_-]*invalid/i.test(message)
}

function ConnectionStatus({ label, status }: { label: string; status: string }) {
  const connected = status === 'Connected'
  const connection = connected ? 'Connected' : 'Disconnected'
  return (
    <span className="prediction-connection" role="status" aria-label={`${label}: ${connection}`} title={`${label}: ${status}`}>
      <span className={`connection-dot ${connected ? 'is-connected' : 'is-disconnected'}`} aria-hidden="true" />
      <span className="prediction-connection-text"><span className="prediction-connection-label">{label === 'WebSocket stream' ? 'Stream' : 'Orders'}</span><strong>{connection}</strong></span>
    </span>
  )
}

const trackedInstruments = [
  { name: 'Nifty 50', exchange: 'NSE', symbol: 'Nifty 50', token: '99926000' },
  { name: 'Sensex', exchange: 'BSE', symbol: 'SENSEX', token: '99919000' },
  { name: 'Bank Nifty', exchange: 'NSE', symbol: 'Nifty Bank', token: '99926009' },
]

function formatProfileList(value: AngelOneProfile['exchanges']) {
  if (Array.isArray(value)) return value.join(', ')
  if (!value) return 'Not available'
  try {
    const parsed = JSON.parse(value.replace(/'/g, '"'))
    return Array.isArray(parsed) ? parsed.join(', ') : value
  } catch {
    return value
  }
}

function formatHistoricalDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function isHistoricalRateLimit(error: unknown) {
  return error instanceof Error && /rate|exceeding access/i.test(error.message)
}

type ChartInterval = 'FIVE_MINUTE' | 'FIFTEEN_MINUTE' | 'ONE_HOUR'
const chartIntervals: ChartInterval[] = ['FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR']
const chartCacheVersion = 1

function chartCacheKey(token: string, interval: ChartInterval) {
  return `angelone_chart_v${chartCacheVersion}_${token}_${interval}`
}

function readChartCache(token: string, interval: ChartInterval): AngelOneCandle[] | null {
  const saved = localStorage.getItem(chartCacheKey(token, interval))
  if (!saved) return null
  const parsed: unknown = JSON.parse(saved)
  if (!Array.isArray(parsed)) throw new Error(`Saved ${intervalLabel(interval)} chart data is invalid.`)
  const candles = parsed.filter((item): item is AngelOneCandle =>
    Array.isArray(item)
    && item.length >= 6
    && typeof item[0] === 'string'
    && Number.isFinite(new Date(item[0]).getTime())
    && item.slice(1, 6).every((value) => typeof value === 'number' && Number.isFinite(value)),
  )
  if (candles.length !== parsed.length) throw new Error(`Saved ${intervalLabel(interval)} chart data is incomplete.`)
  return candles.length ? candles : null
}

function getInitialChartCandles(interval: ChartInterval): Record<string, AngelOneCandle[]> {
  return Object.fromEntries(trackedInstruments.map((instrument) => {
    try {
      return [instrument.name, readChartCache(instrument.token, interval) || []]
    } catch {
      return [instrument.name, []]
    }
  }))
}

function intervalLabel(interval: ChartInterval) {
  return interval === 'FIVE_MINUTE' ? '5-minute' : interval === 'FIFTEEN_MINUTE' ? '15-minute' : '1-hour'
}

function intervalMilliseconds(interval: ChartInterval) {
  return interval === 'FIVE_MINUTE' ? 5 * 60 * 1000 : interval === 'FIFTEEN_MINUTE' ? 15 * 60 * 1000 : 60 * 60 * 1000
}

function mergeCandles(existing: AngelOneCandle[], incoming: AngelOneCandle[]): AngelOneCandle[] {
  const candlesByTime = new Map<number, AngelOneCandle>()
  for (const candle of [...existing, ...incoming]) {
    const timestamp = new Date(candle[0]).getTime()
    if (Number.isFinite(timestamp)) candlesByTime.set(timestamp, candle)
  }
  return [...candlesByTime.entries()]
    .sort(([timeA], [timeB]) => timeA - timeB)
    .map(([, candle]) => candle)
}

function chartHistoryWindowDays(interval: ChartInterval) {
  return interval === 'FIVE_MINUTE' ? 180 : interval === 'FIFTEEN_MINUTE' ? 365 : 3650
}

function formatCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function candleBucket(timestamp: number, interval: ChartInterval) {
  const normalizedTimestamp = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
  const intervalMs = intervalMilliseconds(interval)
  const alignment = interval === 'ONE_HOUR' ? 45 * 60 * 1000 : 0
  return Math.floor((normalizedTimestamp - alignment) / intervalMs) * intervalMs + alignment
}

function PriceActionAgent({ candles, interval, now, instrument, onError, onPrediction }: { candles: AngelOneCandle[]; interval: ChartInterval; now: number; instrument: string; onError: (message: string) => void; onPrediction: (plan: PredictionPlan) => void }) {
  const market = useMarketContext(instrument)
  useEffect(() => { if (market.error) onError(market.error) }, [market.error, onError])
  const marketRevision = market.context?.revision
  const snapshot = completedCandles(candles, interval, now)
  const analysis: PriceActionAnalysis = analyzePriceAction(snapshot, interval, now)
  const snapshotKey = JSON.stringify(snapshot)
  const chartCurrent = Boolean(analysis.latestCandleTime && now - Date.parse(analysis.latestCandleTime) <= 2 * intervalMilliseconds(interval))
  const [aiAnalysis, setAiAnalysis] = useState<AiPriceAction | null>(null)
  const [aiError, setAiError] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [assessedSnapshot, setAssessedSnapshot] = useState('')
  const assessmentKey = `${instrument}:${interval}:${snapshotKey}:${marketRevision || 'no-context'}`
  const requestController = useRef<AbortController | null>(null)
  const requestAiRef = useRef<() => Promise<void>>(async () => {})
  requestAiRef.current = async () => {
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    let timedOut = false
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, 45_000)
    setAiAnalysis(null)
    setAssessedSnapshot('')
    setAiLoading(true)
    setAiError('')
    try {
      const result = await getAiPriceAction(instrument, interval, snapshot, analysis, controller.signal, Boolean(market.context))
      if (result.asOf !== analysis.latestCandleTime) throw new Error('AI analysis returned a different chart timestamp. Using the current chart only.')
      if (!controller.signal.aborted) { setAiAnalysis(result); setAssessedSnapshot(assessmentKey); setAiError('') }
    } catch (error) {
      if (!controller.signal.aborted || timedOut) {
        setAiError(timedOut ? 'AI news interpretation timed out. The early agent continues with chart evidence.' : error instanceof Error ? error.message : 'AI analysis failed.')
        setAssessedSnapshot(assessmentKey)
      }
    } finally {
      window.clearTimeout(timeout)
      if (!controller.signal.aborted || timedOut) setAiLoading(false)
    }
  }

  useEffect(() => {
    setAiAnalysis(null)
    setAiError('')
    setAiLoading(false)
    if (analysis.analyzedCandles >= 25 && market.loaded) void requestAiRef.current()
    return () => requestController.current?.abort()
  }, [instrument, interval, snapshotKey, analysis.analyzedCandles, marketRevision, market.loaded, chartCurrent])

  const ready = market.loaded && !market.loading && !aiLoading && assessedSnapshot === assessmentKey && Boolean(aiAnalysis || aiError)
  const prediction: EarlyPrediction = ready
    ? buildEarlyPrediction(analysis, instrument, interval, now, aiAnalysis?.marketContext || market.context, aiAnalysis?.marketOutlook)
    : { side: 'WAIT', reason: analysis.analyzedCandles < 25 ? 'Waiting for at least 25 completed candles.' : 'Checking completed chart data and available market context…' }
  const plan = 'plan' in prediction ? prediction.plan : undefined
  const planRef = useRef(plan)
  planRef.current = plan
  useEffect(() => { if (planRef.current) onPrediction(planRef.current) }, [plan?.id, onPrediction])
  useEffect(() => { if (aiError) onError(aiError) }, [aiError, onError])
  const color = prediction.side === 'CALL' ? '#15803D' : prediction.side === 'PUT' ? '#B91C1C' : '#92400E'
  const background = prediction.side === 'CALL' ? '#DCFCE7' : prediction.side === 'PUT' ? '#FEE2E2' : '#FEF3C7'
  const formatPrice = (value?: number) => value === undefined ? '—' : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const earlyDirection = analysis.earlyBias === 'BULLISH' ? 'BUY' : analysis.earlyBias === 'BEARISH' ? 'SELL' : 'NEUTRAL'
  const earlyViewLabel = analysis.earlyBias === 'NEUTRAL'
    ? 'NEUTRAL'
    : analysis.earlyStage === 'TRIGGER'
      ? `${earlyDirection} TRIGGER`
      : analysis.earlyStage === 'CONFIRMED'
        ? `CONFIRMED ${earlyDirection}`
        : `EARLY ${earlyDirection}`
  const earlyColor = analysis.earlyBias === 'BULLISH' ? '#15803D' : analysis.earlyBias === 'BEARISH' ? '#B91C1C' : '#92400E'
  const details = [
    ['Structure', analysis.structure],
    ['Location', analysis.location],
    ['Last closed candle', analysis.candleBehavior],
    ['Setup', analysis.setup],
  ]

  return (
    <section aria-label="Candle price-action agent" style={{ marginTop: 14, padding: 14, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div>
          <strong style={{ fontSize: 15 }}>Early Prediction Agent</strong>
          <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>OHLC + SMA(20)/EMA(20,50) + RSI(14) + Supertrend(10,3) · {intervalLabel(interval)} · {analysis.analyzedCandles} completed candles</div>
        </div>
        <span style={{ padding: '5px 10px', borderRadius: 999, color, background, fontSize: 12, fontWeight: 700 }}>
          {prediction.side === 'WAIT' ? 'WAIT — NO TRADE' : `${plan?.stage} ${prediction.side} SETUP`}
        </span>
      </div>
      <div className="early-prediction-result" style={{ background, color }} aria-live="polite">
        <p>{prediction.reason}</p>
        {plan && <><div className="early-prediction-levels">
          <span>Index entry <strong>{formatPrice(plan.entry)}</strong></span>
          <span>Target <strong>{formatPrice(plan.target)}</strong></span>
          <span>Stop-loss <strong>{formatPrice(plan.stopLoss)}</strong></span>
          <span>Reward:risk <strong>{plan.riskReward.toFixed(2)}:1</strong></span>
        </div><small>{plan.contextMode === 'NEWS_ALIGNED' ? 'Chart + supporting public news' : 'Chart only; news alignment unavailable or neutral'} · Conditional entry · Entry expires after 3 × {intervalLabel(interval)} · Automatically recorded in History<br />{plan.targetBasis}</small></>}
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 10 }}>
        {analysis.latestCandleTime ? `Last completed candle: ${new Date(analysis.latestCandleTime).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST` : 'Waiting for completed candles'} · Forming candle excluded
        {analysis.latestCandleTime && now - new Date(analysis.latestCandleTime).getTime() > 2 * intervalMilliseconds(interval) && <span> · Historical snapshot; waiting for recent completed candles</span>}
      </div>
      <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--card)', fontSize: 12, lineHeight: 1.7 }}>
        <strong style={{ color: earlyColor }}>Early market view: {earlyViewLabel}</strong>
        <span style={{ color: 'var(--text-secondary)' }}> · {analysis.earlyStrength.replace(/_/g, ' ')}</span>
        <div>Bullish score: {analysis.bullishScore}/100 · Bearish score: {analysis.bearishScore}/100 <span style={{ color: 'var(--text-secondary)' }}>(weighted evidence score, not probability)</span></div>
        {(analysis.bullishEvidence.length > 0 || analysis.bearishEvidence.length > 0) && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: 8, marginTop: 4 }}>
            <div><strong style={{ color: '#15803D' }}>Bullish evidence</strong>{analysis.bullishEvidence.length ? <ul style={{ margin: '2px 0', paddingLeft: 18 }}>{analysis.bullishEvidence.map((item) => <li key={item}>{item}</li>)}</ul> : <div>None currently</div>}</div>
            <div><strong style={{ color: '#B91C1C' }}>Bearish evidence</strong>{analysis.bearishEvidence.length ? <ul style={{ margin: '2px 0', paddingLeft: 18 }}>{analysis.bearishEvidence.map((item) => <li key={item}>{item}</li>)}</ul> : <div>None currently</div>}</div>
          </div>
        )}
        <div>
          <span style={{ color: '#D97706' }}>SMA(20): {formatPrice(analysis.movingAverage20)}</span>
          {' · '}
          <span style={{ color: '#EA580C' }}>EMA(20): {formatPrice(analysis.exponentialMovingAverage20)}</span>
          {' · '}
          <span style={{ color: '#2563EB' }}>EMA(50): {formatPrice(analysis.exponentialMovingAverage50)}</span>
          {analysis.exponentialMovingAverage50 === undefined && <span style={{ color: 'var(--text-secondary)' }}> · EMA(50) needs at least 50 candles</span>}
        </div>
        <div>
          <span style={{ color: 'var(--text-primary)' }}>RSI(14): {analysis.rsi14?.toFixed(2) ?? '—'}{analysis.rsi14Momentum !== undefined ? ` · Δ3 ${analysis.rsi14Momentum >= 0 ? '+' : ''}${analysis.rsi14Momentum.toFixed(2)}` : ''}</span>
          {' · '}
          <span style={{ color: analysis.supertrendDirection === 'UP' ? '#15803D' : analysis.supertrendDirection === 'DOWN' ? '#B91C1C' : 'var(--text-secondary)' }}>
            Supertrend(10,3): {formatPrice(analysis.supertrend10)} {analysis.supertrendDirection ?? ''}
          </span>
        </div>
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
          <strong>Technical confirmation: {analysis.tradeStatus}</strong>
        </div>
        {(analysis.bullishTrigger !== undefined || analysis.bearishTrigger !== undefined) && (
          <div style={{ color: 'var(--text-secondary)' }}>
            Current close: {formatPrice(analysis.currentPrice)} · {' '}
            {analysis.bullishTrigger !== undefined && <>Upside trigger: {formatPrice(analysis.bullishTrigger)} · {formatPrice(analysis.distanceToBullishTrigger)} away · invalidation: {formatPrice(analysis.bullishInvalidation)}{analysis.bearishTrigger !== undefined ? ' | ' : ''}</>}
            {analysis.bearishTrigger !== undefined && <>Downside trigger: {formatPrice(analysis.bearishTrigger)} · {formatPrice(analysis.distanceToBearishTrigger)} away · invalidation: {formatPrice(analysis.bearishInvalidation)}</>}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: '8px 14px', marginBottom: 10 }}>
        {details.map(([label, value]) => (
          <div key={label} style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{label}: </span><strong>{value}</strong>
          </div>
        ))}
      </div>
      <p style={{ marginTop: 9, color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>{analysis.reason}</p>
      {analysis.warnings.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>
          {analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      <MarketContextPanel context={ready ? aiAnalysis?.marketContext || market.context : market.context} loading={market.loading} refresh={() => void market.refresh()} outlook={ready ? aiAnalysis?.marketOutlook : undefined} chartCurrent={chartCurrent} />
      <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--card)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Gemini AI second opinion</strong>
          <button type="button" onClick={() => void requestAiRef.current()} disabled={aiLoading || !market.loaded || analysis.analyzedCandles < 25}>
            {aiLoading ? 'Analyzing…' : aiAnalysis ? 'Re-analyze' : 'Analyze with Gemini AI'}
          </button>
        </div>
        {aiLoading && !aiAnalysis && <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>Requesting a second opinion from Gemini…</p>}
        {aiError && <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>News interpretation unavailable; the agent uses chart evidence.</p>}
        {aiAnalysis && (
          <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55 }}>
            <strong>{aiAnalysis.stage} {aiAnalysis.bias}</strong>
            <span style={{ color: 'var(--text-secondary)' }}> · {aiAnalysis.model} · {aiAnalysis.analyzedCandles} completed candles</span>
            <p style={{ margin: '5px 0' }}>{aiAnalysis.summary}</p>
            <div><strong>Bullish evidence:</strong> {aiAnalysis.bullishEvidence.join(' · ') || 'None identified'}</div>
            <div><strong>Bearish evidence:</strong> {aiAnalysis.bearishEvidence.join(' · ') || 'None identified'}</div>
            <div><strong>Confirmation:</strong> {aiAnalysis.confirmation || 'Not specified'}</div>
            <div><strong>Invalidation:</strong> {aiAnalysis.invalidation || 'Not specified'}</div>
            {aiAnalysis.caveat && <div style={{ color: 'var(--text-secondary)' }}><strong>Caveat:</strong> {aiAnalysis.caveat}</div>}
          </div>
        )}
        <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11 }}>Completed candles and available public headlines are sent to Google Gemini. Its sourced news outlook can confirm or veto an early setup; entry, target and stop-loss are calculated from the chart.</div>
      </div>
      {(analysis.support !== undefined || analysis.resistance !== undefined) && (
        <div style={{ marginTop: 5, color: 'var(--text-secondary)', fontSize: 12 }}>
          Support {formatPrice(analysis.support)} · Resistance {formatPrice(analysis.resistance)}
        </div>
      )}
      <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5 }}>
        CALL/PUT is directional guidance on the index, not an options-contract recommendation or an order. Analysis is rule-based and not financial advice.
      </div>
    </section>
  )
}

export default function PredictionPage() {
  const [angelProfile, setAngelProfile] = useState<AngelOneProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [angelRms, setAngelRms] = useState<AngelOneRms | null>(null)
  const [rmsError, setRmsError] = useState('')
  const [gttRules, setGttRules] = useState<AngelOneGttRule[]>([])
  const [gttForm, setGttForm] = useState({ id: '', tradingsymbol: '', symboltoken: '', exchange: 'NSE', transactiontype: 'BUY', producttype: 'DELIVERY', price: '', qty: '', triggerprice: '', disclosedqty: '0' })
  const [gttMessage, setGttMessage] = useState('')
  const [gttError, setGttError] = useState('')
  const [instrumentError, setInstrumentError] = useState('')
  const [instrumentLoading, setInstrumentLoading] = useState(false)
  const [historicalMode, setHistoricalMode] = useState<'candles' | 'oi'>('candles')
  const [historicalForm, setHistoricalForm] = useState({ exchange: 'NSE', symboltoken: '99926000', interval: 'ONE_DAY', fromdate: '', todate: '' })
  const [historicalData, setHistoricalData] = useState<Array<unknown>>([])
  const [historicalError, setHistoricalError] = useState('')
  const [historicalLoading, setHistoricalLoading] = useState(false)
  const [selectedIndexToken, setSelectedIndexToken] = useState(trackedInstruments[0].token)
  const chartSectionRef = useRef<HTMLDivElement>(null)
  const [chartInterval, setChartInterval] = useState<ChartInterval>('FIVE_MINUTE')
  const [chartCandles, setChartCandles] = useState<Record<string, AngelOneCandle[]>>(() => getInitialChartCandles('FIVE_MINUTE'))
  const [chartLoading, setChartLoading] = useState(false)
  const [chartError, setChartError] = useState('')
  const [chartCacheError, setChartCacheError] = useState('')
  const [streamStatus, setStreamStatus] = useState('Disconnected')
  const [streamTicks, setStreamTicks] = useState<Record<string, AngelOneStreamTick>>({})
  const [streamSocket, setStreamSocket] = useState<WebSocket | null>(null)
  const [orderStatus, setOrderStatus] = useState('Disconnected')
  const [orderUpdates, setOrderUpdates] = useState<AngelOneOrderUpdate[]>([])
  const [errorToast, setErrorToast] = useState<{ message: string; id: number } | null>(null)
  const showErrorToast = useCallback((message: string) => setErrorToast({ message, id: Date.now() }), [])
  const [activeTab, setActiveTab] = useState<'live' | 'history'>('live')
  const [predictionNotifications, setPredictionNotifications] = useState<PredictionEvent[]>([])
  const showPredictionEvents = useCallback((events: PredictionEvent[]) => {
    setPredictionNotifications(current => [...current, ...events.filter(event => !current.some(item => item.id === event.id))])
  }, [])
  const dismissPredictionEvent = useCallback((id: string) => setPredictionNotifications(current => current.filter(event => event.id !== id)), [])
  const { records: predictionRecords, storageError: historyStorageError, recordPrediction, sync: syncPredictions, syncTick, exitEarly, acknowledgeEarlyExit } = usePredictionHistory(showErrorToast, showPredictionEvents)
  const pendingEarlyExit = predictionRecords.find(record => record.status === 'EARLY_EXIT' && record.earlyExitAcknowledgedAt === undefined)
  const [heartbeat, setHeartbeat] = useState(Date.now())
  const chartInitialised = useRef(false)
  const chartIntervalRef = useRef(chartInterval)
  chartIntervalRef.current = chartInterval
  const consumeTickRef = useRef<(tick: AngelOneStreamTick) => void>(() => {})
  consumeTickRef.current = tick => {
    const instrument = trackedInstruments.find(item => item.token === tick.token)
    if (!instrument || !Number.isFinite(tickTimestamp(tick))) return
    syncTick(instrument.name, tick, record => {
      try { return record.interval === chartInterval ? chartCandles[instrument.name] || [] : readChartCache(instrument.token, record.interval) || [] }
      catch { return [] }
    }, Date.now())
  }

  useEffect(() => {
    const cache = new Map<string, AngelOneCandle[]>()
    syncPredictions(record => {
      const instrument = trackedInstruments.find(item => item.name === record.instrument)!
      const key = `${instrument.token}:${record.interval}`
      if (!cache.has(key)) {
        try { cache.set(key, record.interval === chartInterval ? chartCandles[instrument.name] || [] : readChartCache(instrument.token, record.interval) || []) }
        catch { cache.set(key, []) }
      }
      return { candles: cache.get(key)!, tick: streamTicks[instrument.token] }
    }, heartbeat)
  }, [heartbeat, streamTicks, chartCandles, chartInterval, syncPredictions])

  const previousErrors = useRef<string[]>([])
  useEffect(() => {
    const errors = [profileError, rmsError, gttError, instrumentError, historicalError, chartError, streamStatus, orderStatus]
    const toastErrors = errors.filter((message, index) => message && (index < 5 || isInvalidToken(message)))
    const hasNewError = errors.some((message, index) => message && (index < 5 || isInvalidToken(message)) && message !== previousErrors.current[index])
    previousErrors.current = errors
    if (hasNewError) setErrorToast({ message: [...new Set(toastErrors)].join(' · '), id: Date.now() })
  }, [profileError, rmsError, gttError, instrumentError, historicalError, chartError, streamStatus, orderStatus])


  useEffect(() => {
    fetchAngelProfile()
    fetchInstrumentQuotes()
    if (!chartInitialised.current) {
      chartInitialised.current = true
      fetchChartCandles('FIVE_MINUTE')
    }
    const socket = connectAngelOneStream((tick) => {
      // Record every exchange quote before React batches chart updates, preserving stop/target ordering.
      consumeTickRef.current(tick)
      setStreamTicks((current) => {
        const previous = current[tick.token]
        if (!Number.isFinite(tickTimestamp(tick)) || previous && tickTimestamp(tick) < tickTimestamp(previous)) return current
        return { ...current, [tick.token]: tick }
      })
    }, setStreamStatus)
    if (socket) setStreamSocket(socket)
    const orderSocket = connectAngelOneOrderStream((update) => setOrderUpdates((current) => [update, ...current].slice(0, 20)), setOrderStatus)
    const synchronizeAfterLogin = () => {
      fetchAngelProfile()
      fetchInstrumentQuotes()
      void fetchChartCandles(chartIntervalRef.current)
    }
    window.addEventListener('angelone-auth-changed', synchronizeAfterLogin)
    return () => {
      window.removeEventListener('angelone-auth-changed', synchronizeAfterLogin)
      socket?.close()
      orderSocket?.close()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setHeartbeat(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const preventHorizontalHistorySwipe = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('.candle-chart') && Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault()
    }
    window.addEventListener('wheel', preventHorizontalHistorySwipe, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', preventHorizontalHistorySwipe, true)
  }, [])

  async function fetchChartCandles(interval = chartInterval) {
    setChartLoading(true)
    setChartError('')
    const cacheForInterval: Record<string, AngelOneCandle[]> = {}
    const cachedCandles = new Map<string, AngelOneCandle[] | null>()
    try {
      for (const instrument of trackedInstruments) {
        const cached = readChartCache(instrument.token, interval)
        cachedCandles.set(instrument.name, cached)
        cacheForInterval[instrument.name] = cached || []
      }
    } catch (error) {
      setChartLoading(false)
      setChartError(error instanceof Error ? error.message : 'Unable to read saved chart data.')
      return
    }
    setChartCandles(cacheForInterval)
    setChartInterval(interval)
    try {
      const token = localStorage.getItem('angelone_jwt_token')
      if (!token) {
        setChartError('Showing saved chart data. Log in to synchronize the latest candles.')
        return
      }

      const to = new Date()
      const todaySessionStart = new Date(to)
      todaySessionStart.setHours(9, 0, 0, 0)
      const errors: string[] = []
      for (const [index, instrument] of trackedInstruments.entries()) {
        if (index > 0) await wait(2500)
        const cached = cachedCandles.get(instrument.name) || []
        const latestCachedTime = cached.length
          ? Math.max(...cached.map((candle) => new Date(candle[0]).getTime()).filter(Number.isFinite))
          : undefined
        const from = latestCachedTime === undefined
          ? new Date(to.getTime() - chartHistoryWindowDays(interval) * 24 * 60 * 60 * 1000)
          : new Date(Math.min(todaySessionStart.getTime(), latestCachedTime - intervalMilliseconds(interval)))
        let loaded = false
        for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
          try {
            const result = await getHistoricalCandles(token, {
              exchange: instrument.exchange,
              symboltoken: instrument.token,
              interval,
              fromdate: formatHistoricalDate(from),
              todate: formatHistoricalDate(to),
            })
            const candles = Array.isArray(result.data) ? result.data : []
            if (!candles.length) {
              errors.push(`${instrument.name}: no candles returned for the requested sync range.`)
            } else {
              const merged = mergeCandles(cached, candles)
              setChartCandles((current) => ({ ...current, [instrument.name]: merged }))
              try {
                localStorage.setItem(chartCacheKey(instrument.token, interval), JSON.stringify(merged))
              } catch (error) {
                setChartCacheError(error instanceof Error ? `Unable to save synchronized ${instrument.name} candles locally: ${error.message}` : `Unable to save synchronized ${instrument.name} candles locally.`)
              }
            }
            loaded = true
          } catch (error) {
            if (isHistoricalRateLimit(error) && attempt < 2) {
              await wait(3000 * (attempt + 1))
              continue
            }
            errors.push(`${instrument.name}: ${error instanceof Error ? error.message : 'request failed'}`)
            break
          }
        }
      }
      if (errors.length) setChartError(`Some historical requests were rejected. ${errors.join(' ')}`)
    } catch (error) {
      setChartError(error instanceof Error ? error.message : 'Unable to load saved chart data.')
    } finally {
      setChartLoading(false)
    }
  }

  useEffect(() => {
    for (const instrument of trackedInstruments) {
      const candles = chartCandles[instrument.name]
      if (!candles?.length) continue
      try {
        localStorage.setItem(chartCacheKey(instrument.token, chartInterval), JSON.stringify(candles))
        setChartCacheError('')
      } catch (error) {
        setChartCacheError(error instanceof Error ? `Unable to save ${instrument.name} chart locally: ${error.message}` : `Unable to save ${instrument.name} chart locally.`)
      }
    }
  }, [chartCandles, chartInterval])

  useEffect(() => {
    const tickByToken = streamTicks
    const activeIntervalCandles: Record<string, AngelOneCandle[]> = {}
    for (const instrument of trackedInstruments) {
      const tick = tickByToken[instrument.token]
      if (!tick?.ltp) continue
      for (const interval of chartIntervals) {
        try {
          const savedCandles = readChartCache(instrument.token, interval)
          if (!savedCandles?.length) continue
          const updatedCandles = applyLiveTick(savedCandles, tick, interval)
          const oldLast = savedCandles[savedCandles.length - 1]
          const newLast = updatedCandles[updatedCandles.length - 1]
          const changed = oldLast?.[0] !== newLast?.[0]
            || oldLast?.[2] !== newLast?.[2]
            || oldLast?.[3] !== newLast?.[3]
            || oldLast?.[4] !== newLast?.[4]
          if (!changed) continue
          localStorage.setItem(chartCacheKey(instrument.token, interval), JSON.stringify(updatedCandles))
          if (interval === chartInterval) activeIntervalCandles[instrument.name] = updatedCandles
          setChartCacheError('')
        } catch (error) {
          setChartCacheError(error instanceof Error ? `Unable to update ${instrument.name} chart locally: ${error.message}` : `Unable to update ${instrument.name} chart locally.`)
        }
      }
    }
    setChartCandles((current) => {
      let changed = false
      const next = { ...current }
      for (const instrument of trackedInstruments) {
        const updated = activeIntervalCandles[instrument.name]
        if (!updated || !current[instrument.name]?.length) continue
        const previous = current[instrument.name][current[instrument.name].length - 1]
        const latest = updated[updated.length - 1]
        if (previous?.[0] !== latest?.[0] || previous?.[4] !== latest?.[4] || previous?.[2] !== latest?.[2] || previous?.[3] !== latest?.[3]) {
          next[instrument.name] = updated
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [streamTicks, chartInterval])

  async function fetchAngelProfile() {
    let token = localStorage.getItem('angelone_jwt_token')
    const refreshToken = localStorage.getItem('angelone_refresh_token')
    if (!token && !refreshToken) return

    setProfileLoading(true)
    setProfileError('')
    try {
      if (!token && refreshToken) {
        const refreshed = await refreshAngelOneToken('', refreshToken)
        token = refreshed.data?.jwtToken || null
        if (refreshed.data?.refreshToken) localStorage.setItem('angelone_refresh_token', refreshed.data.refreshToken)
        if (refreshed.data?.feedToken) localStorage.setItem('angelone_feed_token', refreshed.data.feedToken)
        if (token) localStorage.setItem('angelone_jwt_token', token)
      }

      if (!token) throw new Error('Angel One session expired. Please log in again.')

      let result
      try {
        result = await getAngelOneProfile(token)
      } catch (error) {
        if (!(error instanceof Error) || !refreshToken) throw error
        const refreshed = await refreshAngelOneToken(token, refreshToken)
        token = refreshed.data?.jwtToken || null
        if (refreshed.data?.refreshToken) localStorage.setItem('angelone_refresh_token', refreshed.data.refreshToken)
        if (refreshed.data?.feedToken) localStorage.setItem('angelone_feed_token', refreshed.data.feedToken)
        if (token) localStorage.setItem('angelone_jwt_token', token)
        if (!token) throw new Error('Angel One session expired. Please log in again.')
        result = await getAngelOneProfile(token)
      }
      if (!result.data) throw new Error(result.message || 'Profile data was not returned.')
      setAngelProfile(result.data)
      await loadGttRules(token)
      try {
        const rmsResult = await getAngelOneRms(token)
        if (!rmsResult.data) throw new Error(rmsResult.message || 'RMS data was not returned.')
        setAngelRms(rmsResult.data)
      } catch (error) {
        setRmsError(error instanceof Error ? error.message : 'Unable to load Angel One RMS limits.')
      }

    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Unable to load Angel One profile.')
    } finally {
      setProfileLoading(false)
    }
  }

  async function fetchInstrumentQuotes() {
    const token = localStorage.getItem('angelone_jwt_token')
    if (!token) return
    setInstrumentLoading(true)
    setInstrumentError('')
    try {
      const master = await getInstrumentMaster()
      await Promise.all(trackedInstruments.map(async (tracked) => {
        const instrument = master.find((item) => item.token === tracked.token)
          || { token: tracked.token, symbol: tracked.symbol, exch_seg: tracked.exchange === 'BSE' ? 'bse_cm' : 'nse_cm' }
        await getAngelOneLtp(token, instrument)
      }))
    } catch (error) {
      setInstrumentError(error instanceof Error ? error.message : 'Unable to load index quotes from Angel One.')
    } finally {
      setInstrumentLoading(false)
    }

  }

  async function fetchHistoricalData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const token = localStorage.getItem('angelone_jwt_token')
    if (!token) {
      setHistoricalError('Please log in to view historical data.')
      return
    }

    setHistoricalLoading(true)
    setHistoricalError('')
    try {
      const body = { ...historicalForm, fromdate: historicalForm.fromdate.replace('T', ' '), todate: historicalForm.todate.replace('T', ' ') }
      const result = historicalMode === 'candles' ? await getHistoricalCandles(token, body) : await getHistoricalOi(token, body)
      setHistoricalData(Array.isArray(result.data) ? result.data : [])
    } catch (error) {
      setHistoricalError(error instanceof Error ? error.message : 'Unable to load historical data.')
    } finally {
      setHistoricalLoading(false)
    }
  }

  function sendStreamSubscription(action: 1 | 0) {
    if (!streamSocket || streamSocket.readyState !== WebSocket.OPEN) {
      setStreamStatus('Streaming connection is not open.')
      return
    }
    streamSocket.send(JSON.stringify({
      correlationID: 'indices01',
      action,
      params: {
        mode: 1,
        tokenList: [
          { exchangeType: 1, tokens: ['99926000', '99926009'] },
          { exchangeType: 3, tokens: ['99919000'] },
        ],
      },
    }))
  }

  async function loadGttRules(token = localStorage.getItem('angelone_jwt_token')) {
    if (!token) return
    try {
      const result = await listGttRules(token, ['NEW', 'CANCELLED', 'ACTIVE', 'SENTTOEXCHANGE', 'FORALL'])
      setGttRules(Array.isArray(result.data) ? result.data : [])
    } catch (error) {
      setGttError(error instanceof Error ? error.message : 'Unable to load GTT rules.')
    }
  }

  async function submitGtt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const token = localStorage.getItem('angelone_jwt_token')
    if (!token) {
      setGttError('Please log in to manage GTT rules.')
      return
    }
    setGttError('')
    setGttMessage('')
    try {
      const result = gttForm.id ? await modifyGttRule(token, gttForm) : await createGttRule(token, gttForm)
      setGttMessage(result.message || 'GTT rule saved successfully.')
      setGttForm((current) => ({ ...current, id: '' }))
      await loadGttRules(token)
    } catch (error) {
      setGttError(error instanceof Error ? error.message : 'Unable to save GTT rule.')
    }
  }

  async function inspectGtt(id: string) {
    const token = localStorage.getItem('angelone_jwt_token')
    if (!token) return
    try {
      const result = await getGttRuleDetails(token, id)
      if (result.data && !Array.isArray(result.data) && typeof result.data !== 'string') {
        setGttForm((current) => ({ ...current, ...result.data as AngelOneGttRule }))
      }
    } catch (error) {
      setGttError(error instanceof Error ? error.message : 'Unable to load GTT details.')
    }
  }

  async function cancelGtt(rule: AngelOneGttRule) {
    const token = localStorage.getItem('angelone_jwt_token')
    if (!token || !rule.id) return
    try {
      await cancelGttRule(token, { id: rule.id, symboltoken: rule.symboltoken, exchange: rule.exchange })
      setGttMessage('GTT rule cancelled successfully.')
      await loadGttRules(token)
    } catch (error) {
      setGttError(error instanceof Error ? error.message : 'Unable to cancel GTT rule.')
    }
  }

  return (
    <div className="prediction-page" style={{ minHeight: '100vh', background: 'var(--bg)', paddingBottom: 40 }}>
      <PredictionNotifications events={predictionNotifications} earlyExit={pendingEarlyExit} onDismiss={dismissPredictionEvent} onAcknowledge={id => {
        acknowledgeEarlyExit(id)
        setPredictionNotifications(current => current.filter(event => event.recordId !== id || event.reason !== 'Early exit'))
      }} />
      <ErrorToast message={errorToast?.message || ''} notificationId={errorToast?.id} onDismiss={() => setErrorToast(null)} />
      <PredictionHeader>
        <div className="container prediction-page-container">
          <div className="prediction-heading-row">
            <div className="prediction-heading-primary">
              <div className="prediction-tabs" role="tablist" aria-label="Prediction views">
                <button type="button" id="live-tab" role="tab" aria-selected={activeTab === 'live'} aria-controls="live-panel" onClick={() => setActiveTab('live')}>Live prediction</button>
                <button type="button" id="history-tab" role="tab" aria-selected={activeTab === 'history'} aria-controls="history-panel" onClick={() => setActiveTab('history')}>History <span>{predictionRecords.length}</span></button>
              </div>
            </div>
            <div className="prediction-heading-actions">
              <label className="prediction-index-selector">
                <select aria-label="Index" value={selectedIndexToken} onChange={(event) => setSelectedIndexToken(event.target.value)} aria-controls="live-index-candle-chart">
                  {trackedInstruments.map((instrument) => <option key={instrument.token} value={instrument.token}>{instrument.name}</option>)}
                </select>
              </label>
              <button type="button" className="prediction-refresh" onClick={fetchInstrumentQuotes} disabled={instrumentLoading} aria-label="Refresh Live Data" title="Refresh Live Data" aria-busy={instrumentLoading}>
                <svg className={instrumentLoading ? 'refresh-spinning' : undefined} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 7v5h-5M4 17v-5h5" />
                  <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
                </svg>
              </button>
              <ConnectionStatus label="WebSocket stream" status={streamStatus} />
              <ConnectionStatus label="Order updates" status={orderStatus} />
            </div>
          </div>
          <p className="prediction-header-description" style={{ color: 'rgba(255,255,255,0.9)', fontSize: 14, maxWidth: 700, lineHeight: 1.7 }}>
            Live Nifty 50, Sensex, and Bank Nifty prices from Angel One SmartAPI.
          </p>
        </div>
      </PredictionHeader>

      {gttMessage && <div className="container" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16, borderRadius: 18, background: '#D1FAE5', color: '#065F46' }}>{gttMessage}</div>
      </div>}

      <div className="container prediction-page-container" style={{ paddingBottom: 40 }}>
        <div id="history-panel" role="tabpanel" aria-labelledby="history-tab" hidden={activeTab !== 'history'}>
          <PredictionHistory records={predictionRecords} storageError={historyStorageError} now={heartbeat} onExitEarly={exitEarly} />
        </div>
        <div id="live-panel" role="tabpanel" aria-labelledby="live-tab" hidden={activeTab !== 'live'}>
          <div ref={chartSectionRef} id="live-index-candle-chart" className="live-index-chart-section" style={{ marginBottom: 18 }}>
            {chartLoading && <div style={{ color: 'var(--text-secondary)', marginBottom: 14 }}>Loading {intervalLabel(chartInterval)} candles…</div>}
            <div style={{ display: 'grid', gap: 16 }}>
              {trackedInstruments.filter((instrument) => instrument.token === selectedIndexToken).map((instrument) => (
                <div key={instrument.name}>
                  <CandleChart
                    name={instrument.name}
                    key={`${instrument.name}-${chartInterval}`}
                    intervalLabel={intervalLabel(chartInterval)}
                    timeframeControl={
                      <select
                        className="candle-timeframe-select"
                        aria-label="Timeframe"
                        value={chartInterval}
                        disabled={chartLoading}
                        onChange={(event) => fetchChartCandles(event.target.value as ChartInterval)}
                      >
                        <option value="FIVE_MINUTE">5 minutes</option>
                        <option value="FIFTEEN_MINUTE">15 minutes</option>
                        <option value="ONE_HOUR">1 hour</option>
                      </select>
                    }
                    savedCandleCount={chartCandles[instrument.name]?.length || 0}
                    marketHeartbeat={(() => {
                      const tick = streamTicks[instrument.token]
                      if (!tick) return 'Waiting for market heartbeat'
                      const currentTimestamp = tickTimestamp(tick)
                      const nextFormationTime = candleBucket(currentTimestamp, chartInterval) + intervalMilliseconds(chartInterval)
                      const updated = new Date(tick.timestamp < 1_000_000_000_000 ? tick.timestamp * 1000 : tick.timestamp).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      return `Live ${tick.ltp?.toFixed(2) ?? '–'} · Next candle ${formatCountdown(nextFormationTime - heartbeat)} · Updated ${updated} IST`
                    })()}
                    tick={streamTicks[instrument.token]}
                    candles={applyLiveTick(
                      chartCandles[instrument.name] || [],
                      streamTicks[instrument.token],
                      chartInterval,
                    )}
                  />
                </div>
              ))}
              {trackedInstruments.map(instrument => (
                <div key={`monitor-${instrument.token}`} hidden={instrument.token !== selectedIndexToken}>
                  <PriceActionAgent
                    key={`agent-${instrument.name}-${chartInterval}`}
                    onError={showErrorToast}
                    onPrediction={recordPrediction}
                    instrument={instrument.name}
                    candles={chartCandles[instrument.name] || []}
                    interval={chartInterval}
                    now={heartbeat}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '8px 0 16px', flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>Live index stream</h2>
              <div className="live-stream-status">
                <span>Heartbeat every 30 seconds · Auto-subscribed to LTP</span>
                <span aria-hidden="true">{' · '}</span>
                {orderUpdates.length === 0 ? <span className="live-order-waiting" role="status">Orders: Waiting for order updates…</span> : <details className="live-order-updates">
                  <summary>Orders: {orderUpdates[0]['order-status'] || orderUpdates[0]['status-code'] || 'Update'} · {String(orderUpdates[0].orderData?.tradingsymbol || '')} ({orderUpdates.length})</summary>
                  <ul>{orderUpdates.map((update, index) => <li key={`${update.orderData?.orderid || 'update'}-${index}`}>
                    <strong>{update['order-status'] || update['status-code'] || 'Update'}</strong> {String(update.orderData?.tradingsymbol || '')} {String(update.orderData?.transactiontype || '')}
                    <small>{String(update.orderData?.orderid || '')} {String(update.orderData?.text || update['error-message'] || '')}</small>
                  </li>)}</ul>
                </details>}
              </div>
            </div>
            <div className="live-stream-controls">
              <button type="button" onClick={() => sendStreamSubscription(1)} disabled={streamStatus !== 'Connected'}>Subscribe</button>
              <button type="button" onClick={() => sendStreamSubscription(0)} disabled={streamStatus !== 'Connected'}>Unsubscribe</button>
              {(chartError && !isInvalidToken(chartError) || chartCacheError) && <div className="live-stream-errors">
                {chartError && !isInvalidToken(chartError) && <div role="alert" className="live-stream-error">{chartError}</div>}
                {chartCacheError && <div role="alert" className="live-stream-warning">{chartCacheError}</div>}
              </div>}
            </div>
          </div>
          <details className="card card-disclosure" style={{ marginBottom: 18 }}>
            <summary>
              <div>
                <div className="card-disclosure-kicker">Historical API</div>
                <h2>Historical {historicalMode === 'candles' ? 'Candles' : 'Open Interest'}</h2>
              </div>
              <svg className="card-disclosure-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </summary>
            <div className="card-disclosure-content">
            <form onSubmit={fetchHistoricalData} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 10 }}>
              <label>Data<select value={historicalMode} onChange={(event) => setHistoricalMode(event.target.value as 'candles' | 'oi')}><option value="candles">Candle data</option><option value="oi">OI data</option></select></label>
              <label>Exchange<select value={historicalForm.exchange} onChange={(event) => setHistoricalForm({ ...historicalForm, exchange: event.target.value })}><option>NSE</option><option>BSE</option><option>NFO</option><option>BFO</option><option>MCX</option></select></label>
              <label>Symbol token<input required value={historicalForm.symboltoken} onChange={(event) => setHistoricalForm({ ...historicalForm, symboltoken: event.target.value })} /></label>
              <label>Interval<select value={historicalForm.interval} onChange={(event) => setHistoricalForm({ ...historicalForm, interval: event.target.value })}>{['ONE_MINUTE', 'THREE_MINUTE', 'FIVE_MINUTE', 'TEN_MINUTE', 'FIFTEEN_MINUTE', 'THIRTY_MINUTE', 'ONE_HOUR', 'ONE_DAY'].map((interval) => <option key={interval}>{interval}</option>)}</select></label>
              <label>From<input required type="datetime-local" value={historicalForm.fromdate} onChange={(event) => setHistoricalForm({ ...historicalForm, fromdate: event.target.value })} /></label>
              <label>To<input required type="datetime-local" value={historicalForm.todate} onChange={(event) => setHistoricalForm({ ...historicalForm, todate: event.target.value })} /></label>
              <button type="submit" disabled={historicalLoading}>{historicalLoading ? 'Loading…' : 'Fetch history'}</button>
            </form>
            {historicalData.length > 0 && <div style={{ overflowX: 'auto', marginTop: 18 }}><table><thead><tr>{historicalMode === 'candles' ? <><th>Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th></> : <><th>Time</th><th>Open interest</th></>}</tr></thead><tbody>{historicalData.map((row, index) => historicalMode === 'candles' && Array.isArray(row) ? <tr key={index}>{row.map((value, cellIndex) => <td key={cellIndex}>{String(value)}</td>)}</tr> : <tr key={index}><td>{String((row as { time?: string }).time || '')}</td><td>{String((row as { oi?: number }).oi ?? '')}</td></tr>)}</tbody></table></div>}
            {!historicalLoading && historicalData.length === 0 && <div style={{ marginTop: 16, color: 'var(--text-secondary)' }}>No historical records loaded.</div>}
            </div>
          </details>
        {profileLoading && (
          <div className="card" style={{ padding: 20, marginBottom: 18 }}>Loading Angel One profile…</div>
        )}
        {angelProfile && (
          <details className="card card-disclosure" style={{ marginBottom: 18 }}>
            <summary>
              <div>
                <div className="card-disclosure-kicker">Angel One Profile</div>
                <h2>{angelProfile.name || 'Investor'}</h2>
              </div>
              <svg className="card-disclosure-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </summary>
            <div className="card-disclosure-content">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: 'var(--text-secondary)' }}>Client code: {angelProfile.clientcode || 'Not available'}</div>
              </div>
              <div style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                <div>{angelProfile.email || 'Email not available'}</div>
                <div>{angelProfile.mobileno || 'Mobile not available'}</div>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 6, marginTop: 16, color: 'var(--text-secondary)', fontSize: 14 }}>
              <div><strong>Exchanges:</strong> {formatProfileList(angelProfile.exchanges)}</div>
              <div><strong>Products:</strong> {formatProfileList(angelProfile.products)}</div>
              <div><strong>Last login:</strong> {angelProfile.lastlogintime || 'Not available'}</div>
              <div><strong>Broker:</strong> {angelProfile.brokerid || 'Not available'}</div>
            </div>
            </div>
          </details>
        )}
        {angelRms && (
          <details className="card card-disclosure" style={{ marginBottom: 18 }}>
            <summary>
              <div>
                <div className="card-disclosure-kicker">Risk Management & Funds</div>
                <h2>RMS Limits</h2>
              </div>
              <svg className="card-disclosure-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </summary>
            <div className="card-disclosure-content" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12 }}>
              {[
                ['Net', 'net'],
                ['Available cash', 'availablecash'],
                ['Intraday pay-in', 'availableintradaypayin'],
                ['Limit margin', 'availablelimitmargin'],
                ['Collateral', 'collateral'],
                ['Unrealized M2M', 'm2munrealized'],
                ['Realized M2M', 'm2mrealized'],
                ['Utilized debits', 'utiliseddebits'],
                ['Utilized span', 'utilisedspan'],
                ['Option premium', 'utilisedoptionpremium'],
                ['Utilized exposure', 'utilisedexposure'],
                ['Utilized payout', 'utilisedpayout'],
              ].map(([label, key]) => (
                <div key={key} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>{label}</div>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{angelRms[key] ?? '0'}</div>
                </div>
              ))}
            </div>
          </details>
        )}
        <details className="card card-disclosure" style={{ marginBottom: 18 }}>
          <summary>
            <div>
              <div className="card-disclosure-kicker">Good Till Triggered</div>
              <h2>GTT Rule Management</h2>
            </div>
            <svg className="card-disclosure-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </summary>
          <div className="card-disclosure-content">
          <form onSubmit={submitGtt} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 10, marginBottom: 20 }}>
            {([['tradingsymbol', 'Trading symbol'], ['symboltoken', 'Symbol token'], ['price', 'Price'], ['qty', 'Quantity'], ['triggerprice', 'Trigger price'], ['disclosedqty', 'Disclosed qty']] as const).map(([key, label]) => (
              <label key={key} style={{ fontSize: 12 }}>{label}<input required={key !== 'disclosedqty'} value={gttForm[key]} onChange={(event) => setGttForm({ ...gttForm, [key]: event.target.value })} /></label>
            ))}
            <label style={{ fontSize: 12 }}>Exchange<select value={gttForm.exchange} onChange={(event) => setGttForm({ ...gttForm, exchange: event.target.value })}><option>NSE</option><option>BSE</option></select></label>
            <label style={{ fontSize: 12 }}>Side<select value={gttForm.transactiontype} onChange={(event) => setGttForm({ ...gttForm, transactiontype: event.target.value })}><option>BUY</option><option>SELL</option></select></label>
            <label style={{ fontSize: 12 }}>Product<select value={gttForm.producttype} onChange={(event) => setGttForm({ ...gttForm, producttype: event.target.value })}><option>DELIVERY</option><option>MARGIN</option></select></label>
            {gttForm.id && <label style={{ fontSize: 12 }}>Rule ID<input value={gttForm.id} readOnly /></label>}
            <button type="submit" style={{ border: 0, borderRadius: 10, background: '#6C63FF', color: '#fff', fontWeight: 700 }}>{gttForm.id ? 'Modify Rule' : 'Create Rule'}</button>
          </form>
          <div style={{ display: 'grid', gap: 10 }}>
            {gttRules.map((rule) => (
              <div key={rule.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <span><strong>#{rule.id}</strong> {rule.tradingsymbol || ''} {rule.transactiontype || ''} — {rule.status || 'UNKNOWN'}</span>
                <span style={{ display: 'flex', gap: 8 }}><button type="button" onClick={() => inspectGtt(rule.id || '')}>Details / Edit</button><button type="button" onClick={() => cancelGtt(rule)}>Cancel</button></span>
              </div>
            ))}
            {!gttRules.length && <div style={{ color: 'var(--text-secondary)' }}>No GTT rules found.</div>}
          </div>
          </div>
        </details>
        </div>
      </div>
    </div>
  )
}
