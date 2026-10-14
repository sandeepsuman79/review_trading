import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { connectAngelOneOrderStream, connectAngelOneStream, getAngelOneLtp, getAngelOneProfile, getHistoricalCandles, getInstrumentMaster } from '../api/angelOne'
import { isAngelOneAuthError, recoverAngelOneSession } from '../api/angelOneSession'
import type { AngelOneOrderUpdate } from '../api/angelOne'
import type { AngelOneStreamTick } from '../api/angelOne'
import type { AngelOneCandle, AngelOneProfile } from '../api/angelOne'
import { getAiPriceAction, type AiPriceAction } from '../api/ai'
import { analyzePriceAction, type PriceActionAnalysis } from '../analysis/priceAction'
import { candleBucketTime, isFreshTick, normalizeCandles, tickTimestamp } from '../analysis/candleData'
import { abortableWait, formatHistoricalDate, historyRetryDelay, historySyncRange, prioritizeHistoryJobs } from '../analysis/historySync'
import { useCompletedCandles } from '../hooks/useCompletedCandles'
import { LiveCandleBook } from '../analysis/liveCandleBook'
import { resolveIndiaVixInstrument, type IndiaVixInstrument } from '../analysis/indiaVix'
import MarketContextPanel from '../components/MarketContextPanel'
import { useNewsAssessment } from '../hooks/useNewsAssessment'
import { useMarketContext } from '../hooks/useMarketContext'
import { useIndiaVix } from '../hooks/useIndiaVix'
import ErrorToast from '../components/ErrorToast'
import AgentTradeCard from '../components/AgentTradeCard'
import ConfirmedTrades from '../components/ConfirmedTrades'
import { buildEarlyPrediction, type EarlyPrediction, type PredictionPlan } from '../analysis/earlyPrediction'
import { usePredictionHistory } from '../hooks/usePredictionHistory'
import PredictionHeader from '../components/PredictionHeader'
import PredictionNotifications from '../components/PredictionNotifications'
import type { PredictionEvent } from '../analysis/predictionEvents'
import { canEnterConfirmedPrediction, type PredictionRecord } from '../analysis/predictionHistory'
import { analyzeTradingEvidence } from '../analysis/tradingEvidence'
import type { IndiaVixSnapshot } from '../api/marketContext'
import { useInstitutionalFlows } from '../hooks/useInstitutionalFlows'

const CandleChart = lazy(() => import('../components/CandleChart'))

function isInvalidToken(message: string) {
  return /invalid[\s_-]*token|token[\s_-]*invalid/i.test(message)
}

function ConnectionStatus({ label, status }: { label: string; status: string }) {
  const connected = status === 'Connected'
  const connection = connected ? 'Connected' : 'Disconnected'
  return (
    <span className="prediction-connection" role="status" aria-label={`${label}: ${connection}`} title={`${label}: ${status}`}>
      <span className={`connection-dot ${connected ? 'is-connected' : 'is-disconnected'}`} aria-hidden="true" />
      <span className="prediction-connection-label">{label === 'WebSocket stream' ? 'Stream' : 'Orders'}</span>
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
  const normalized = normalizeCandles(candles)
  return normalized.length ? normalized : null
}

function intervalLabel(interval: ChartInterval) {
  return interval === 'FIVE_MINUTE' ? '5-minute' : interval === 'FIFTEEN_MINUTE' ? '15-minute' : '1-hour'
}

function intervalMilliseconds(interval: ChartInterval) {
  return interval === 'FIVE_MINUTE' ? 5 * 60 * 1000 : interval === 'FIFTEEN_MINUTE' ? 15 * 60 * 1000 : 60 * 60 * 1000
}

function formatCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function PriceActionAgent({ candles, openingCandles, interval, now, instrument, activeTrade, pendingTrade, tick, streamConnected, indiaVix, visible, onLevels, onError, onPrediction, onConfirmation }: { candles: AngelOneCandle[]; openingCandles: AngelOneCandle[]; interval: ChartInterval; now: number; instrument: string; activeTrade?: PredictionRecord; pendingTrade?: PredictionRecord; tick?: AngelOneStreamTick; streamConnected: boolean; indiaVix?: IndiaVixSnapshot; visible: boolean; onLevels: (instrument: string, support?: number, resistance?: number) => void; onError: (message: string) => void; onPrediction: (plan: PredictionPlan) => void; onConfirmation: (instrument: string, plan: PredictionPlan | undefined, now: number) => void }) {
  const market = useMarketContext(instrument)
  useEffect(() => { if (market.error) onError(market.error) }, [market.error, onError])
  const news = useNewsAssessment(market.context, now)
  const { history: flowHistory } = useInstitutionalFlows(market.context?.inputs?.institutional)
  const snapshot = useCompletedCandles(candles, interval, now)
  const analysis: PriceActionAnalysis = useMemo(() => analyzePriceAction(snapshot, interval, Date.now()), [snapshot, interval])
  useEffect(() => onLevels(instrument, analysis.support, analysis.resistance), [instrument, analysis.support, analysis.resistance, onLevels])
  const snapshotKey = useMemo(() => JSON.stringify(snapshot), [snapshot])
  const chartCurrent = Boolean(analysis.latestCandleTime && now - Date.parse(analysis.latestCandleTime) <= 2 * intervalMilliseconds(interval))
  const [aiAnalysis, setAiAnalysis] = useState<AiPriceAction | null>(null)
  const [aiError, setAiError] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [assessedSnapshot, setAssessedSnapshot] = useState('')
  const assessmentKey = `${instrument}:${interval}:${snapshotKey}`
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
      const preliminaryEvidence = analyzeTradingEvidence({ analysis, candles: snapshot, interval, instrument, context: market.context, indiaVix, flowHistory, now })
      const result = await getAiPriceAction(instrument, interval, snapshot, analysis, controller.signal, false, preliminaryEvidence)
      if (result.asOf !== analysis.latestCandleTime) throw new Error('AI analysis returned a different chart timestamp. Using the current chart only.')
      if (!controller.signal.aborted) { setAiAnalysis(result); setAssessedSnapshot(assessmentKey); setAiError('') }
    } catch (error) {
      if (!controller.signal.aborted || timedOut) {
        setAiError(timedOut ? 'Optional AI commentary timed out. Technical evaluation continues.' : error instanceof Error ? error.message : 'AI analysis failed.')
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
    setAssessedSnapshot('')
    return () => requestController.current?.abort()
  }, [instrument, interval, snapshotKey])

  const ready = !aiLoading && assessedSnapshot === assessmentKey && Boolean(aiAnalysis || aiError)
  const displayContext = market.context
  const aiStatus = ready ? aiAnalysis?.providerStatus ?? news.providerStatus : news.providerStatus
  const aiCoolingDown = Boolean(aiStatus?.retryAt && Date.parse(aiStatus.retryAt) > now)
  const aiMessage = aiError || aiStatus?.message || news.message
  const evidence = analyzeTradingEvidence({ analysis, candles: snapshot, interval, instrument, context: displayContext, outlook: news.outlook, indiaVix, flowHistory, now, historicalReference: visible })
  const prediction: EarlyPrediction = buildEarlyPrediction(analysis, instrument, interval, now, displayContext, news.outlook, evidence)
  const signalPlan = 'plan' in prediction ? prediction.plan : undefined
  useLayoutEffect(() => {
    onConfirmation(instrument, streamConnected && signalPlan?.stage === 'CONFIRMED' ? signalPlan : undefined, now)
    return () => onConfirmation(instrument, undefined, now)
  }, [instrument, signalPlan, streamConnected, now, onConfirmation])
  const planRef = useRef(signalPlan)
  planRef.current = signalPlan
  useEffect(() => {
    if (!activeTrade && planRef.current?.stage === 'CONFIRMED') onPrediction(planRef.current)
  }, [signalPlan?.id, signalPlan?.stage, signalPlan?.entry, signalPlan?.stopLoss, signalPlan?.target, signalPlan?.bullishScore, signalPlan?.bearishScore, signalPlan?.evidenceSummary?.coverage, activeTrade, onPrediction])
  const formatPrice = (value?: number) => value === undefined ? '—' : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  if (!visible) return null
  return (
    <section aria-label="Candle price-action agent" className="price-action-agent">
      <AgentTradeCard analysis={evidence.selectedAnalysis ?? analysis} evidence={evidence} prediction={prediction} activeTrade={activeTrade} pendingTrade={pendingTrade} instrument={instrument} interval={interval} now={now} tick={tick} streamConnected={streamConnected} />
      <MarketContextPanel context={displayContext} loading={market.loading} refresh={() => void market.refresh()} outlook={news.outlook} chartCurrent={chartCurrent} analysis={evidence.selectedAnalysis ?? analysis} candles={snapshot} openingCandles={openingCandles} now={now}>
        <section className="agent-analysis-tile agent-ai-tile" aria-label="Gemini AI second opinion">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>Gemini AI second opinion · Optional</strong>
            <button type="button" onClick={() => void requestAiRef.current()} disabled={aiLoading || aiCoolingDown || analysis.analyzedCandles < 25}>
              {aiLoading ? 'Analyzing…' : aiCoolingDown ? 'Cooling down' : aiAnalysis ? 'Re-analyze' : 'Analyze with Gemini AI'}
            </button>
          </div>
          {aiLoading && !aiAnalysis && <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>Requesting a second opinion from Gemini…</p>}
          {aiMessage && <p className={`ai-status-message${aiError || aiStatus?.state === 'COOLDOWN' || aiStatus?.state === 'UNAVAILABLE' ? ' is-error' : ''}`} role="status">{aiMessage}{aiCoolingDown && aiStatus?.retryAt ? ` Retry after ${new Date(aiStatus.retryAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST.` : ''}</p>}
          {aiAnalysis && (!aiAnalysis.providerStatus || ['AVAILABLE', 'CACHED'].includes(aiAnalysis.providerStatus.state)) && (
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
          <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11 }}>Technical analysis confirms trades using completed chart setups, indicators, OI/PCR and ATR/VIX risk checks. FII/DII, news, global markets and PCR provide a separate sentiment reference. Gemini analysis does not delay, confirm or veto entries.</div>
        </section>
      </MarketContextPanel>
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
  const [instrumentError, setInstrumentError] = useState('')
  const [instrumentLoading, setInstrumentLoading] = useState(false)
  const [selectedIndexToken, setSelectedIndexToken] = useState(trackedInstruments[0].token)
  const chartSectionRef = useRef<HTMLDivElement>(null)
  const [chartInterval, setChartInterval] = useState<ChartInterval>('FIVE_MINUTE')
  const [candleBook] = useState(() => new LiveCandleBook((token, interval) => {
    try { return readChartCache(token, interval) || [] }
    catch { return [] }
  }))
  const [chartCandles, setChartCandles] = useState<Record<string, AngelOneCandle[]>>(() => Object.fromEntries(trackedInstruments.map(instrument => [instrument.name, candleBook.get(instrument.token, 'FIVE_MINUTE')])))
  const [structureLevels, setStructureLevels] = useState<Record<string, { support?: number; resistance?: number }>>({})
  const updateStructureLevels = useCallback((instrument: string, support?: number, resistance?: number) => {
    setStructureLevels(existing => existing[instrument]?.support === support && existing[instrument]?.resistance === resistance ? existing : { ...existing, [instrument]: { support, resistance } })
  }, [])
  const [chartLoading, setChartLoading] = useState(false)
  const [syncProgress, setSyncProgress] = useState('')
  const [chartError, setChartError] = useState('')
  const [chartCacheError, setChartCacheError] = useState('')
  const [streamStatus, setStreamStatus] = useState('Disconnected')
  const [streamTicks, setStreamTicks] = useState<Record<string, AngelOneStreamTick>>({})
  const [streamSession, setStreamSession] = useState(0)
  const [historySyncSession, setHistorySyncSession] = useState(0)
  const streamRetryRef = useRef(0)
  const [orderStatus, setOrderStatus] = useState('Disconnected')
  const [orderUpdates, setOrderUpdates] = useState<AngelOneOrderUpdate[]>([])
  const [errorToast, setErrorToast] = useState<{ message: string; id: number } | null>(null)
  const showErrorToast = useCallback((message: string) => setErrorToast({ message, id: Date.now() }), [])
  const [predictionNotifications, setPredictionNotifications] = useState<PredictionEvent[]>([])
  const showPredictionEvents = useCallback((events: PredictionEvent[]) => {
    setPredictionNotifications(current => [...current, ...events.filter(event => !current.some(item => item.id === event.id))])
  }, [])
  const dismissPredictionEvent = useCallback((id: string) => setPredictionNotifications(current => current.filter(event => event.id !== id)), [])
  const { records: predictionRecords, storageError: tradeStorageError, recordPrediction, sync: syncPredictions, syncTick } = usePredictionHistory(showErrorToast, showPredictionEvents)
  const confirmations = useRef<Record<string, { plan?: PredictionPlan; checkedAt: number }>>({})
  const updateConfirmation = useCallback((instrument: string, plan: PredictionPlan | undefined, checkedAt: number) => {
    confirmations.current[instrument] = { plan, checkedAt }
  }, [])
  const getEntryConfirmation = useCallback((record: PredictionRecord) => {
    const confirmation = confirmations.current[record.instrument]
    return confirmation && canEnterConfirmedPrediction(record, confirmation.plan, confirmation.checkedAt, Date.now()) ? confirmation.plan : undefined
  }, [])
  const chartTradeLevels = useMemo(() => Object.fromEntries(predictionRecords.filter(record => record.status === 'ACTIVE')
    .map(record => [record.instrument, { entry: record.entryPrice!, target: record.target, stopLoss: record.stopLoss }])), [predictionRecords])
  const [heartbeat, setHeartbeat] = useState(Date.now())
  const [indiaVixInstrument, setIndiaVixInstrument] = useState<IndiaVixInstrument>()
  const { snapshot: indiaVix, loading: indiaVixLoading, refresh: refreshIndiaVix } = useIndiaVix(indiaVixInstrument)
  const chartIntervalRef = useRef(chartInterval)
  chartIntervalRef.current = chartInterval
  const selectedIndexRef = useRef(selectedIndexToken)
  selectedIndexRef.current = selectedIndexToken
  const chartRequestRef = useRef(0)
  const historyController = useRef<AbortController | null>(null)
  const consumeTickRef = useRef<(tick: AngelOneStreamTick) => void>(() => {})
  consumeTickRef.current = tick => {
    const instrument = trackedInstruments.find(item => item.token === tick.token)
    if (!instrument || !Number.isFinite(tickTimestamp(tick))) return
    syncTick(instrument.name, tick, record => {
      return candleBook.get(instrument.token, record.interval)
    }, Date.now(), getEntryConfirmation)
  }
  const saveChartCandles = useCallback((limit = Infinity) => {
    try {
      const remaining = candleBook.flush((token, interval, candles) => localStorage.setItem(chartCacheKey(token, interval), JSON.stringify(candles)), limit)
      setChartCacheError('')
      return remaining
    } catch (error) {
      setChartCacheError(error instanceof Error ? `Unable to save chart locally: ${error.message}` : 'Unable to save chart locally.')
    }
  }, [candleBook])
  const loadSessionRef = useRef<(isActive: () => boolean) => Promise<void>>(async () => {})
  loadSessionRef.current = async isActive => {
    await fetchAngelProfile()
    if (!isActive()) return
    void fetchInstrumentQuotes()
    void synchronizeChartHistory()
  }

  // Login/page refresh and the refresh button synchronize all saved timeframes once.
  // Chart selection and socket reconnects only read/update the local candle book.
  useEffect(() => {
    let active = true
    void loadSessionRef.current(() => active)
    return () => { active = false; chartRequestRef.current += 1; historyController.current?.abort() }
  }, [historySyncSession])

  useEffect(() => {
    const cache = new Map<string, AngelOneCandle[]>()
    syncPredictions(record => {
      const instrument = trackedInstruments.find(item => item.name === record.instrument)!
      const key = `${instrument.token}:${record.interval}`
      if (!cache.has(key)) {
        try { cache.set(key, candleBook.get(instrument.token, record.interval)) }
        catch { cache.set(key, []) }
      }
      return { candles: cache.get(key)!, tick: streamTicks[instrument.token] }
    }, heartbeat, getEntryConfirmation)
  }, [heartbeat, streamTicks, chartCandles, chartInterval, candleBook, syncPredictions, getEntryConfirmation])

  const previousErrors = useRef<string[]>([])
  useEffect(() => {
    const errors = [profileError, instrumentError, chartError, streamStatus, orderStatus]
    const toastErrors = errors.filter((message, index) => message && (index < 2 || isInvalidToken(message)))
    const hasNewError = errors.some((message, index) => message && (index < 2 || isInvalidToken(message)) && message !== previousErrors.current[index])
    previousErrors.current = errors
    if (hasNewError) setErrorToast({ message: [...new Set(toastErrors)].join(' · '), id: Date.now() })
  }, [profileError, instrumentError, chartError, streamStatus, orderStatus])


  useEffect(() => {
    let active = true
    let reconnectTimer: number | undefined
    let stableTimer: number | undefined
    let displayTimer: number | undefined
    let pendingTicks: Record<string, AngelOneStreamTick> = {}
    const publishTicks = () => {
      displayTimer = undefined
      const ticks = pendingTicks
      pendingTicks = {}
      setChartCandles(current => {
        const next = { ...current }
        for (const instrument of trackedInstruments) if (ticks[instrument.token]) next[instrument.name] = candleBook.get(instrument.token, chartIntervalRef.current)
        return next
      })
      setStreamTicks(current => ({ ...current, ...ticks }))
    }
    const socket = connectAngelOneStream((tick) => {
      if (!active) return
      const instrument = trackedInstruments.find(item => item.token === tick.token)
      if (!instrument || !candleBook.accept(tick)) return
      // Record every exchange quote before React batches chart updates, preserving stop/target ordering.
      consumeTickRef.current(tick)
      pendingTicks[tick.token] = tick
      if (displayTimer === undefined) displayTimer = window.setTimeout(publishTicks, 250)
    }, status => {
      if (!active) return
      setStreamStatus(status)
      if (status === 'Connected') {
        window.clearTimeout(stableTimer)
        stableTimer = window.setTimeout(() => { streamRetryRef.current = 0 }, 30_000)
      } else if (status === 'Disconnected') {
        window.clearTimeout(stableTimer)
        if (streamRetryRef.current < 5 && reconnectTimer === undefined) {
          const delay = Math.min(30_000, 1000 * 2 ** ++streamRetryRef.current)
          reconnectTimer = window.setTimeout(() => setStreamSession(current => current + 1), delay)
        }
      }
    })
    const orderSocket = connectAngelOneOrderStream((update) => { if (active) setOrderUpdates((current) => [update, ...current].slice(0, 20)) }, status => { if (active) setOrderStatus(status) })
    const synchronizeAfterLogin = (event: Event) => {
      streamRetryRef.current = 0
      setStreamSession(current => current + 1)
      if (!(event instanceof CustomEvent && event.detail?.reason === 'token-refresh')) {
        setHistorySyncSession(current => current + 1)
      }
    }
    window.addEventListener('angelone-auth-changed', synchronizeAfterLogin)
    return () => {
      active = false
      window.clearTimeout(reconnectTimer)
      window.clearTimeout(stableTimer)
      window.clearTimeout(displayTimer)
      window.removeEventListener('angelone-auth-changed', synchronizeAfterLogin)
      socket?.close()
      orderSocket?.close()
    }
  }, [streamSession, candleBook])

  useEffect(() => {
    const timer = window.setInterval(() => setHeartbeat(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const preventHorizontalHistorySwipe = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('.chart-indicator-metrics')) return
      if (event.target instanceof Element && event.target.closest('.candle-chart') && Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault()
    }
    window.addEventListener('wheel', preventHorizontalHistorySwipe, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', preventHorizontalHistorySwipe, true)
  }, [])

  function selectChartInterval(interval: ChartInterval) {
    chartIntervalRef.current = interval
    setChartInterval(interval)
    setChartCandles(Object.fromEntries(trackedInstruments.map(instrument => [instrument.name, candleBook.get(instrument.token, interval)])))
  }

  async function synchronizeChartHistory() {
    historyController.current?.abort()
    const controller = new AbortController()
    historyController.current = controller
    const request = ++chartRequestRef.current
    const current = () => request === chartRequestRef.current && !controller.signal.aborted
    setChartLoading(true)
    setChartError('')
    try {
      const token = localStorage.getItem('angelone_jwt_token')
      if (!token) { setChartError('Showing saved chart data. Log in to synchronize the latest candles.'); return }
      const end = Date.now()
      const errors: string[] = []
      const jobs: Array<{ token: string; interval: ChartInterval; cursor?: number }> = chartIntervals.flatMap(interval => trackedInstruments.map(instrument => ({ interval, token: instrument.token })))
      let completed = 0
      while (jobs.length && current()) {
        const job = prioritizeHistoryJobs(jobs, selectedIndexRef.current, chartIntervalRef.current)[0]
        jobs.splice(jobs.indexOf(job), 1)
        const instrument = trackedInstruments.find(item => item.token === job.token)!
        const cached = candleBook.get(job.token, job.interval)
        const range = historySyncRange(cached, job.interval, end)
        if (job.cursor !== undefined) {
          range.from = job.cursor
          const limit = job.interval === 'FIVE_MINUTE' ? 99 : job.interval === 'FIFTEEN_MINUTE' ? 199 : 399
          range.to = Math.min(end, range.from + limit * 86_400_000)
        }
        setSyncProgress(`Syncing ${instrument.name} · ${intervalLabel(job.interval)} · ${completed}/9 completed`)
        if (range.from >= range.to) { completed++; continue }
        let loaded = false
        for (let attempt = 0; attempt < 3 && current(); attempt++) {
          const timeout = window.setTimeout(() => controller.abort(), 60_000)
          try {
            const result = await getHistoricalCandles(token, {
              exchange: instrument.exchange, symboltoken: job.token, interval: job.interval,
              fromdate: formatHistoricalDate(range.from), todate: formatHistoricalDate(range.to),
            }, controller.signal)
            if (!current()) return
            const candles = normalizeCandles(result.data || [])
            if (candles.length) {
              const merged = candleBook.mergeHistory(job.token, job.interval, candles, Math.floor(range.to / 60_000) * 60_000)
              if (chartIntervalRef.current === job.interval) setChartCandles(existing => ({ ...existing, [instrument.name]: merged }))
            } else if (!cached.length) {
              errors.push(`${instrument.name} (${intervalLabel(job.interval)}): Angel One returned no candles. Saved data will appear when available.`)
            }
            loaded = true
            break
          } catch (error) {
            if (!current()) {
              if (request === chartRequestRef.current) setChartError('History sync timed out. Saved candles and live updates remain available; refresh to retry.')
              return
            }
            const delay = historyRetryDelay(error, attempt)
            if (delay !== undefined && attempt < 2) {
              setSyncProgress(`Retrying ${instrument.name} · ${intervalLabel(job.interval)} in ${Math.ceil(delay / 1000)}s · Showing saved candles`)
              window.clearTimeout(timeout)
              await abortableWait(delay, controller.signal)
            } else {
              errors.push(`${instrument.name} (${intervalLabel(job.interval)}): ${error instanceof Error ? error.message : 'request failed'}`)
              // Expired credentials cannot succeed for the remaining jobs.
              if ([401, 403].includes((error as { status?: number }).status ?? 0) || /invalid.*token|token.*invalid|expired|AG800[12]/i.test(String(error))) jobs.length = 0
              break
            }
          } finally { window.clearTimeout(timeout) }
        }
        if (loaded && range.to < end) jobs.push({ ...job, cursor: range.to - intervalMilliseconds(job.interval) })
        else completed++
        if (jobs.length && current()) await abortableWait(1200, controller.signal)
      }
      if (current() && errors.length) setChartError(`Historical sync incomplete. ${errors.join(' ')}`)
    } catch (error) {
      if (current()) setChartError(error instanceof Error ? error.message : 'Unable to synchronize chart data.')
    } finally {
      if (request === chartRequestRef.current) { setChartLoading(false); setSyncProgress('') }
    }
  }

  useEffect(() => {
    // Save one dirty timeframe per idle turn, away from chart gestures and tick processing.
    let idle: number | undefined, fallback: number | undefined
    let stopped = false
    const persist = () => {
      idle = undefined; fallback = undefined
      if (!stopped && saveChartCandles(1)) schedule()
    }
    const schedule = () => {
      if (stopped || idle !== undefined || fallback !== undefined) return
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(persist, { timeout: 2000 })
      else fallback = window.setTimeout(persist, 100)
    }
    const flush = () => saveChartCandles()
    const hidden = () => { if (document.visibilityState === 'hidden') flush() }
    const timer = window.setInterval(schedule, 5000)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      stopped = true; window.clearInterval(timer); window.clearTimeout(fallback)
      if (idle !== undefined) window.cancelIdleCallback(idle)
      window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); flush()
    }
  }, [saveChartCandles])

  async function fetchAngelProfile() {
    let token = localStorage.getItem('angelone_jwt_token')
    const refreshToken = localStorage.getItem('angelone_refresh_token')
    if (!token && !refreshToken) return

    setProfileLoading(true)
    setProfileError('')
    try {
      if (!token && refreshToken) {
        token = await recoverAngelOneSession('')
      }

      if (!token) throw new Error('Angel One session expired. Please log in again.')

      let result
      try {
        result = await getAngelOneProfile(token)
      } catch (error) {
        if (!(error instanceof Error) || !isAngelOneAuthError(error) || !refreshToken) throw error
        token = await recoverAngelOneSession(token)
        if (!token) throw new Error('Angel One session expired. Please log in again.')
        result = await getAngelOneProfile(token)
      }
      if (!result.data) throw new Error(result.message || 'Profile data was not returned.')
      setAngelProfile(result.data)
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
      const master = await getInstrumentMaster('indices')
      const vix = resolveIndiaVixInstrument(master)
      setIndiaVixInstrument(current => current?.token === vix?.token && current?.symbol === vix?.symbol ? current : vix)
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

  return (
    <div className="prediction-page" style={{ minHeight: '100vh', background: 'var(--bg)', paddingBottom: 40 }}>
      <PredictionNotifications events={predictionNotifications} onDismiss={dismissPredictionEvent} />
      <ErrorToast message={errorToast?.message || ''} notificationId={errorToast?.id} onDismiss={() => setErrorToast(null)} />
      <PredictionHeader>
        <div className="container prediction-page-container">
          <div className="prediction-heading-row">
            <div className="prediction-heading-primary">
              <span className="prediction-live-label">Live prediction</span>
              <label className="prediction-timeframe-selector">
                <select aria-label="Timeframe" value={chartInterval} onChange={(event) => selectChartInterval(event.target.value as ChartInterval)} aria-controls="live-index-candle-chart">
                  <option value="FIVE_MINUTE">5 minutes</option>
                  <option value="FIFTEEN_MINUTE">15 minutes</option>
                  <option value="ONE_HOUR">1 hour</option>
                </select>
              </label>
            </div>
            <div className="prediction-heading-actions">
              <label className="prediction-index-selector">
                <select aria-label="Index" value={selectedIndexToken} onChange={(event) => setSelectedIndexToken(event.target.value)} aria-controls="live-index-candle-chart">
                  {trackedInstruments.map((instrument) => <option key={instrument.token} value={instrument.token}>{instrument.name}</option>)}
                </select>
              </label>
              <button type="button" className="prediction-refresh" onClick={() => { void refreshIndiaVix(); setHistorySyncSession(current => current + 1) }} disabled={instrumentLoading || chartLoading || profileLoading} aria-label="Refresh Live Data" title="Refresh Live Data" aria-busy={instrumentLoading || chartLoading || profileLoading}>
                <svg className={instrumentLoading || chartLoading || profileLoading ? 'refresh-spinning' : undefined} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 7v5h-5M4 17v-5h5" />
                  <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
                </svg>
              </button>
              <ConnectionStatus label="WebSocket stream" status={streamStatus} />
              <ConnectionStatus label="Order updates" status={orderStatus} />
            </div>
          </div>
          <div className="prediction-header-status">
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
      </PredictionHeader>

      <div className="container prediction-page-container" style={{ paddingBottom: 40 }}>
        <div ref={chartSectionRef} id="live-index-candle-chart" className="live-index-chart-section" style={{ marginBottom: 18 }}>
          {chartLoading && <div role="status" style={{ color: 'var(--text-secondary)', fontSize: 11, marginBottom: 8 }}>{syncProgress || 'Preparing background candle sync…'}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
            {trackedInstruments.filter((instrument) => instrument.token === selectedIndexToken).map((instrument) => (
              <div key={instrument.name}>
                <Suspense fallback={<div role="status" style={{ minHeight: 440, padding: 12 }}>Loading candle chart…</div>}>
                <CandleChart
                  name={instrument.name}
                  key={`${instrument.name}-${chartInterval}`}
                  intervalLabel={intervalLabel(chartInterval)}
                  savedCandleCount={chartCandles[instrument.name]?.length || 0}
                  spotIndex
                  levels={structureLevels[instrument.name]}
                  trade={chartTradeLevels[instrument.name]}
                  indiaVix={indiaVix}
                  indiaVixLoading={indiaVixLoading}
                  now={heartbeat}
                  isLive={streamStatus === 'Connected' && isFreshTick(streamTicks[instrument.token], heartbeat)}
                  marketHeartbeat={(() => {
                    const tick = streamTicks[instrument.token]
                    if (!tick) return 'Waiting for market heartbeat'
                    const currentTimestamp = tickTimestamp(tick)
                    const nextFormationTime = candleBucketTime(currentTimestamp, chartInterval) + intervalMilliseconds(chartInterval)
                    const updated = new Date(tick.timestamp < 1_000_000_000_000 ? tick.timestamp * 1000 : tick.timestamp).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    const live = streamStatus === 'Connected' && isFreshTick(tick, heartbeat)
                    return `${live ? 'Live' : 'Last quote'} ${tick.ltp?.toFixed(2) ?? '–'} · ${live ? `Next candle ${formatCountdown(nextFormationTime - heartbeat)}` : 'Waiting for live tick'} · Updated ${updated} IST`
                  })()}
                  tick={streamTicks[instrument.token]}
                  candles={chartCandles[instrument.name] || []}
                />
                </Suspense>
              </div>
            ))}
            {trackedInstruments.map(instrument => (
              <div key={`monitor-${instrument.token}`} hidden={instrument.token !== selectedIndexToken}>
                <PriceActionAgent
                  key={`agent-${instrument.name}-${chartInterval}`}
                  visible={instrument.token === selectedIndexToken}
                  onLevels={updateStructureLevels}
                  onError={showErrorToast}
                  onPrediction={recordPrediction}
                  onConfirmation={updateConfirmation}
                  instrument={instrument.name}
                  pendingTrade={predictionRecords.find(record => record.instrument === instrument.name && record.status === 'PENDING')}
                  activeTrade={predictionRecords.find(record => record.instrument === instrument.name && record.status === 'ACTIVE')}
                  tick={streamTicks[instrument.token]}
                  streamConnected={streamStatus === 'Connected'}
                  indiaVix={indiaVix}
                  candles={chartCandles[instrument.name] || []}
                  openingCandles={candleBook.get(instrument.token, 'FIVE_MINUTE')}
                  interval={chartInterval}
                  now={heartbeat}
                />
              </div>
            ))}
          </div>
        </div>
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
        <ConfirmedTrades records={predictionRecords} now={heartbeat} streamConnected={streamStatus === 'Connected'} storageError={tradeStorageError} />
        {(chartError && !isInvalidToken(chartError) || chartCacheError) && <div className="prediction-sync-errors" aria-label="Chart sync messages">
          {chartError && !isInvalidToken(chartError) && <div role="alert" className="prediction-sync-error">{chartError}</div>}
          {chartCacheError && <div role="alert" className="prediction-sync-warning">{chartCacheError}</div>}
        </div>}
      </div>
    </div>
  )
}
