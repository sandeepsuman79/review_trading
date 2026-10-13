import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { connectAngelOneOrderStream, connectAngelOneStream, getAngelOneLtp, getAngelOneProfile, getHistoricalCandles, getInstrumentMaster, refreshAngelOneToken } from '../api/angelOne'
import type { AngelOneOrderUpdate } from '../api/angelOne'
import type { AngelOneStreamTick } from '../api/angelOne'
import type { AngelOneCandle, AngelOneProfile } from '../api/angelOne'
import { getAiPriceAction, type AiPriceAction } from '../api/ai'
import { analyzePriceAction, type PriceActionAnalysis } from '../analysis/priceAction'
import { candleBucketTime, completedCandles, historicalCandleRequestStart, isFreshTick, normalizeCandles, tickTimestamp } from '../analysis/candleData'
import { LiveCandleBook } from '../analysis/liveCandleBook'
import { resolveIndiaVixInstrument, type IndiaVixInstrument } from '../analysis/indiaVix'
import MarketContextPanel from '../components/MarketContextPanel'
import { useNewsAssessment } from '../hooks/useNewsAssessment'
import { useMarketContext } from '../hooks/useMarketContext'
import { useIndiaVix } from '../hooks/useIndiaVix'
import ErrorToast from '../components/ErrorToast'
import CandleChart from '../components/CandleChart'
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

function formatHistoricalDate(date: Date) {
  const ist = new Date(date.getTime() + 330 * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`
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
  const normalized = normalizeCandles(candles)
  return normalized.length ? normalized : null
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

function formatCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function PriceActionAgent({ candles, openingCandles, interval, now, instrument, activeTrade, tick, streamConnected, indiaVix, onError, onPrediction, onConfirmation }: { candles: AngelOneCandle[]; openingCandles: AngelOneCandle[]; interval: ChartInterval; now: number; instrument: string; activeTrade?: PredictionRecord; tick?: AngelOneStreamTick; streamConnected: boolean; indiaVix?: IndiaVixSnapshot; onError: (message: string) => void; onPrediction: (plan: PredictionPlan) => void; onConfirmation: (instrument: string, plan: PredictionPlan | undefined, now: number) => void }) {
  const market = useMarketContext(instrument)
  useEffect(() => { if (market.error) onError(market.error) }, [market.error, onError])
  const news = useNewsAssessment(market.context, now)
  const { history: flowHistory } = useInstitutionalFlows(market.context?.inputs?.institutional)
  const snapshot = completedCandles(candles, interval, now)
  const analysis: PriceActionAnalysis = analyzePriceAction(snapshot, interval, now)
  const snapshotKey = JSON.stringify(snapshot)
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
  const evidence = analyzeTradingEvidence({ analysis, candles: snapshot, interval, instrument, context: displayContext, outlook: news.outlook, indiaVix, flowHistory, now })
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

  return (
    <section aria-label="Candle price-action agent" className="price-action-agent">
      <AgentTradeCard analysis={analysis} evidence={evidence} prediction={prediction} activeTrade={activeTrade} instrument={instrument} interval={interval} now={now} tick={tick} streamConnected={streamConnected} />
      <MarketContextPanel context={displayContext} loading={market.loading} refresh={() => void market.refresh()} outlook={news.outlook} chartCurrent={chartCurrent} analysis={analysis} candles={snapshot} openingCandles={openingCandles} now={now} />
      <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--card)' }}>
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
  const [instrumentError, setInstrumentError] = useState('')
  const [instrumentLoading, setInstrumentLoading] = useState(false)
  const [selectedIndexToken, setSelectedIndexToken] = useState(trackedInstruments[0].token)
  const chartSectionRef = useRef<HTMLDivElement>(null)
  const [chartInterval, setChartInterval] = useState<ChartInterval>('FIVE_MINUTE')
  const [chartCandles, setChartCandles] = useState<Record<string, AngelOneCandle[]>>(() => getInitialChartCandles('FIVE_MINUTE'))
  const [chartLoading, setChartLoading] = useState(false)
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
  const chartRequestRef = useRef(0)
  const [candleBook] = useState(() => new LiveCandleBook((token, interval) => {
    try { return readChartCache(token, interval) || [] }
    catch { return [] }
  }))
  const consumeTickRef = useRef<(tick: AngelOneStreamTick) => void>(() => {})
  consumeTickRef.current = tick => {
    const instrument = trackedInstruments.find(item => item.token === tick.token)
    if (!instrument || !Number.isFinite(tickTimestamp(tick))) return
    syncTick(instrument.name, tick, record => {
      return candleBook.get(instrument.token, record.interval)
    }, Date.now(), getEntryConfirmation)
  }
  const saveChartCandles = useCallback(() => {
    try {
      candleBook.flush((token, interval, candles) => localStorage.setItem(chartCacheKey(token, interval), JSON.stringify(candles)))
      setChartCacheError('')
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
    return () => { active = false; chartRequestRef.current += 1 }
  }, [historySyncSession])

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
    }, heartbeat, getEntryConfirmation)
  }, [heartbeat, streamTicks, chartCandles, chartInterval, syncPredictions, getEntryConfirmation])

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
    const socket = connectAngelOneStream((tick) => {
      if (!active) return
      const instrument = trackedInstruments.find(item => item.token === tick.token)
      if (!instrument || !candleBook.accept(tick)) return
      // Record every exchange quote before React batches chart updates, preserving stop/target ordering.
      consumeTickRef.current(tick)
      const candles = candleBook.get(instrument.token, chartIntervalRef.current)
      setChartCandles(current => current[instrument.name] === candles ? current : { ...current, [instrument.name]: candles })
      setStreamTicks(current => ({ ...current, [tick.token]: tick }))
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
    const request = ++chartRequestRef.current
    setChartLoading(true)
    setChartError('')
    try {
      const token = localStorage.getItem('angelone_jwt_token')
      if (!token) {
        setChartError('Showing saved chart data. Log in to synchronize the latest candles.')
        return
      }

      const to = new Date()
      const errors: string[] = []
      const selectedInterval = chartIntervalRef.current
      const intervals = [selectedInterval, ...chartIntervals.filter(interval => interval !== selectedInterval)]
      const requests = intervals.flatMap(interval => trackedInstruments.map(instrument => ({ interval, instrument })))
      for (const [index, { interval, instrument }] of requests.entries()) {
        if (index > 0) await wait(2500)
        if (request !== chartRequestRef.current) return
        const cached = candleBook.get(instrument.token, interval)
        const from = new Date(historicalCandleRequestStart(cached, interval, to.getTime()))
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
            if (request !== chartRequestRef.current) return
            const candles = Array.isArray(result.data) ? normalizeCandles(result.data) : []
            if (!candles.length) {
              errors.push(`${instrument.name} (${intervalLabel(interval)}): no candles returned for the requested sync range.`)
            } else {
              // The broker's todate has minute precision; preserve quotes newer than that cutoff.
              const merged = candleBook.mergeHistory(instrument.token, interval, candles, Math.floor(to.getTime() / 60_000) * 60_000)
              saveChartCandles()
              if (chartIntervalRef.current === interval) setChartCandles((current) => ({ ...current, [instrument.name]: merged }))
            }
            loaded = true
          } catch (error) {
            if (request !== chartRequestRef.current) return
            if (isHistoricalRateLimit(error) && attempt < 2) {
              await wait(3000 * (attempt + 1))
              continue
            }
            errors.push(`${instrument.name} (${intervalLabel(interval)}): ${error instanceof Error ? error.message : 'request failed'}`)
            break
          }
        }
      }
      if (errors.length) setChartError(`Some historical requests were rejected. ${errors.join(' ')}`)
    } catch (error) {
      if (request === chartRequestRef.current) setChartError(error instanceof Error ? error.message : 'Unable to load saved chart data.')
    } finally {
      if (request === chartRequestRef.current) setChartLoading(false)
    }
  }

  useEffect(() => {
    saveChartCandles()
  }, [saveChartCandles, chartCandles, streamTicks])

  async function fetchAngelProfile() {
    let token = localStorage.getItem('angelone_jwt_token')
    const previousToken = token
    const previousFeedToken = localStorage.getItem('angelone_feed_token')
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
      if (token !== previousToken || localStorage.getItem('angelone_feed_token') !== previousFeedToken) {
        window.dispatchEvent(new CustomEvent('angelone-auth-changed', { detail: { reason: 'token-refresh' } }))
      }
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
      const master = await getInstrumentMaster()
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
          {chartLoading && <div style={{ color: 'var(--text-secondary)', marginBottom: 14 }}>Syncing saved candles…</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
            {trackedInstruments.filter((instrument) => instrument.token === selectedIndexToken).map((instrument) => (
              <div key={instrument.name}>
                <CandleChart
                  name={instrument.name}
                  key={`${instrument.name}-${chartInterval}`}
                  intervalLabel={intervalLabel(chartInterval)}
                  savedCandleCount={chartCandles[instrument.name]?.length || 0}
                  spotIndex
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
              </div>
            ))}
            {trackedInstruments.map(instrument => (
              <div key={`monitor-${instrument.token}`} hidden={instrument.token !== selectedIndexToken}>
                <PriceActionAgent
                  key={`agent-${instrument.name}-${chartInterval}`}
                  onError={showErrorToast}
                  onPrediction={recordPrediction}
                  onConfirmation={updateConfirmation}
                  instrument={instrument.name}
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
