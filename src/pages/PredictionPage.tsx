import { writeChartCache } from '../storage/chartCache'
import { useTimeframeTrajectories } from '../hooks/useTimeframeTrajectories'
import SessionReview from '../components/SessionReview'
import { useAtmVwap } from '../hooks/useAtmVwap'
import { contractExpiryNotice } from '../analysis/agentMonitoring'
import { recordIntrabarTick } from '../analysis/intrabarContext'
import { analyzeMultiTimeframe, revalidateMultiTimeframeAssessment, selectReversalPlan, type MultiTimeframeAssessment, type AgentTimeframe } from '../analysis/multiTimeframe'
import type { ProtectionAssessment } from '../analysis/tradeProtection'
import MultiTimeframePanel from '../components/MultiTimeframePanel'
import { cachedHistoricalOutcomes } from '../analysis/historicalOutcomes'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { connectAngelOneOrderStream, connectAngelOneStream, getAngelOneLtp, getAngelOneProfile, getHistoricalCandles, getInstrumentMaster } from '../api/angelOne'
import { isAngelOneAuthError, recoverAngelOneSession } from '../api/angelOneSession'
import type { AngelOneOrderUpdate } from '../api/angelOne'
import type { AngelOneStreamTick } from '../api/angelOne'
import type { AngelOneCandle, AngelOneProfile, AngelOneInstrument } from '../api/angelOne'
import { getAiPriceAction, type AiPriceAction } from '../api/ai'
import { type PriceActionAnalysis, type PriceActionInterval } from '../analysis/priceAction'
import { candleBucketTime, isFreshTick, normalizeCandles, tickTimestamp } from '../analysis/candleData'
import { abortableWait, formatHistoricalDate, historyRefreshDue, historyRetryDelay, historySyncRange, prioritizeHistoryJobs, runHistoricalRequest } from '../analysis/historySync'
import { useCompletedCandles } from '../hooks/useCompletedCandles'
import { LiveCandleBook } from '../analysis/liveCandleBook'
import { defaultChartInterval, historyIntervals, timeframeInfo } from '../analysis/timeframes'
import { resolveIndiaVixInstrument, type IndiaVixInstrument } from '../analysis/indiaVix'
import MarketContextPanel from '../components/MarketContextPanel'
import { useNewsAssessment } from '../hooks/useNewsAssessment'
import { useMarketContext } from '../hooks/useMarketContext'
import { useIndiaVix } from '../hooks/useIndiaVix'
import ErrorToast from '../components/ErrorToast'
import AgentTradeCard from '../components/AgentTradeCard'
import ConfirmedTrades from '../components/ConfirmedTrades'
import { type EarlyPrediction, type PredictionPlan } from '../analysis/earlyPrediction'
import { usePredictionHistory } from '../hooks/usePredictionHistory'
import PredictionHeader from '../components/PredictionHeader'
import PredictionNotifications from '../components/PredictionNotifications'
import type { PredictionEvent } from '../analysis/predictionEvents'
import { canEnterConfirmedPrediction, type PredictionRecord } from '../analysis/predictionHistory'
import { analyzeTradingEvidence } from '../analysis/tradingEvidence'
import type { IndiaVixSnapshot } from '../api/marketContext'
import { useInstitutionalFlows } from '../hooks/useInstitutionalFlows'
import { useGapOutlook } from '../hooks/useGapOutlook'
import GapOutlookCard from '../components/GapOutlookCard'
import { commoditySpecs, mcxSession, resolveCommodityContracts, validCommodityContract, isCommodity, type CommodityContract } from '../analysis/commodities'

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

type MarketInstrument = { name: string; exchange: string; exchangeType: number; symbol: string; token: string; expiry?: string; expiresAt?: number; lotSize?: number }
const trackedInstruments: MarketInstrument[] = [
  { name: 'Nifty 50', exchange: 'NSE', exchangeType: 1, symbol: 'Nifty 50', token: '99926000' },
  { name: 'Sensex', exchange: 'BSE', exchangeType: 3, symbol: 'SENSEX', token: '99919000' },
  { name: 'Bank Nifty', exchange: 'NSE', exchangeType: 1, symbol: 'Nifty Bank', token: '99926009' },
]
type ChartHistoryJob = { token: string; interval: ChartInterval; cursor?: number }
type HistoryQueue = { jobs: ChartHistoryJob[]; scheduled: Set<string> }

function readCommodityMaster(): AngelOneInstrument[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('angelone_commodity_instruments_v1') || '[]')
    return Array.isArray(saved) ? saved.filter(item => item && typeof item === 'object' && typeof item.name === 'string' && typeof item.symbol === 'string' && typeof item.token === 'string' && typeof item.expiry === 'string') : []
  } catch { return [] }
}

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

type ChartInterval = AgentTimeframe
const chartCacheVersion = 1

function chartCacheKey(token: string, interval: PriceActionInterval) {
  return `angelone_chart_v${chartCacheVersion}_${token}_${interval}`
}

function readChartCache(token: string, interval: PriceActionInterval): AngelOneCandle[] | null {
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

function intervalLabel(interval: PriceActionInterval) {
  return timeframeInfo[interval].label
}

function intervalMilliseconds(interval: PriceActionInterval) {
  return timeframeInfo[interval].milliseconds
}

function formatCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function CommodityContractInfo({ instrument, tick, lastQuote, connected, now }: { instrument: MarketInstrument; tick?: AngelOneStreamTick; lastQuote?: { price: number; receivedAt: number }; connected: boolean; now: number }) {
  const session = mcxSession(now), live = connected && isFreshTick(tick, now)
  const expiry = validCommodityContract(instrument, instrument.name) ? contractExpiryNotice(instrument, now) : undefined
  const useRest = !live && lastQuote && (!tick || lastQuote.receivedAt > tickTimestamp(tick))
  const value = useRest ? lastQuote.price : tick?.ltp ?? lastQuote?.price
  const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })
  const quoteLabel = live ? 'Live Angel One quote' : useRest ? `Last REST quote received ${time(lastQuote.receivedAt)} IST` : tick ? `Last trade ${time(tickTimestamp(tick))} IST` : 'Waiting for an Angel One quote'
  return <div className="commodity-contract-info" aria-label={`${instrument.name} MCX contract`}>
    <div><strong>{instrument.name} · ₹{value?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}</strong><span>MCX futures · {instrument.symbol} · Expiry {instrument.expiry}{instrument.lotSize ? ` · Lot ${instrument.lotSize}` : ''}</span></div>
    <p><a href="https://www.mcxindia.com/market-operations/trading-surveillance" target="_blank" rel="noopener noreferrer">Regular MCX session</a>: Mon–Fri 09:00–{session.closeLabel} IST · {session.regularSession ? 'Within regular hours' : 'Outside regular hours'} · Exchange holidays / special sessions may differ.</p>
    <small>{quoteLabel} · Live volume is partial until historical sync.</small>
    {expiry && <p role="status">{expiry}</p>}
  </div>
}

function PriceActionAgent({ candlesByInterval, chartInterval, trackLevels, onAssessment, openingCandles, now, instrument, contract, setupRecords, activeTrade, pendingTrade, tick, activeTick, streamConnected, indiaVix, visible, onLevels, onError, onPrediction }: {
  candlesByInterval: Record<AgentTimeframe, AngelOneCandle[]>; chartInterval: AgentTimeframe; trackLevels: boolean
  onAssessment: (key: string, assessment: MultiTimeframeAssessment | undefined) => void
  openingCandles: AngelOneCandle[]; now: number; instrument: string; contract?: CommodityContract; setupRecords: PredictionRecord[]
  activeTrade?: PredictionRecord; pendingTrade?: PredictionRecord; tick?: AngelOneStreamTick; activeTick?: AngelOneStreamTick
  streamConnected: boolean; indiaVix?: IndiaVixSnapshot; visible: boolean; onLevels: (instrument: string, support?: number, resistance?: number) => void
  onError: (message: string) => void; onPrediction: (plan: PredictionPlan) => void
}) {
  const commodity = isCommodity(instrument), instrumentKey = contract?.token ?? instrument
  const market = useMarketContext(instrument)
  useEffect(() => { if (market.error) onError(market.error) }, [market.error, onError])
  const news = useNewsAssessment(market.context, now)
  const { history: flowHistory } = useInstitutionalFlows(market.context?.inputs?.institutional)
  const sessionOpenMinute = commodity ? 540 : 555
  const five = useCompletedCandles(candlesByInterval.FIVE_MINUTE, 'FIVE_MINUTE', now, sessionOpenMinute)
  const fifteen = useCompletedCandles(candlesByInterval.FIFTEEN_MINUTE, 'FIFTEEN_MINUTE', now, sessionOpenMinute)
  const hourly = useCompletedCandles(candlesByInterval.ONE_HOUR, 'ONE_HOUR', now, sessionOpenMinute)
  // Refresh source-age checks each minute; strategy inputs remain 5/15/60-minute candles.
  const atm = useAtmVwap(instrument, tick?.ltp ?? five[five.length - 1]?.[4], now, !commodity)
  const assessmentMinute = Math.floor(now / 60_000)
  const base = useMemo(() => analyzeMultiTimeframe({ candlesByInterval: { FIVE_MINUTE: five, FIFTEEN_MINUTE: fifteen, ONE_HOUR: hourly }, instrument, now: Math.max(assessmentMinute * 60_000, Date.now()), contract, context: market.context, outlook: news.outlook, indiaVix, flowHistory, atmVwap: atm.data }), [five, fifteen, hourly, instrument, contract, market.context, news.outlook, indiaVix, flowHistory, assessmentMinute, atm.data])
  const assessment = revalidateMultiTimeframeAssessment(base, { candlesByInterval, records: setupRecords, now })
  const review = assessment.displayReview, interval = review.interval
  const snapshot = interval === 'FIVE_MINUTE' ? five : interval === 'FIFTEEN_MINUTE' ? fifteen : hourly
  const analysis: PriceActionAnalysis = review.analysis
  const evidence = { ...review.evidence, historicalOutcomes: visible ? cachedHistoricalOutcomes(snapshot, interval, now, instrument) : undefined }
  const trajectories = useTimeframeTrajectories(assessment, contract?.token, { FIVE_MINUTE: five, FIFTEEN_MINUTE: fifteen, ONE_HOUR: hourly })
  const prediction: EarlyPrediction = review.prediction
  const levels = assessment.reviews.find(item => item.interval === chartInterval)!.analysis
  useEffect(() => { if (trackLevels) onLevels(instrument, levels.support, levels.resistance) }, [instrument, levels.support, levels.resistance, onLevels, trackLevels])
  const snapshotKey = useMemo(() => JSON.stringify(snapshot), [snapshot])
  const chartCurrent = review.current
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
      const preliminaryEvidence = analyzeTradingEvidence({ analysis, candles: snapshot, interval, instrument, context: market.context, indiaVix, flowHistory, atmVwap: atm.data, now })
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
  const gapReview = assessment.reviews.find(item => item.interval === 'FIVE_MINUTE')!
  const gapOutlook = useGapOutlook(instrument, gapReview.evidence, now)
  const signalPlan = assessment.selectedPlan
  useLayoutEffect(() => {
    onAssessment(instrumentKey, streamConnected ? assessment : undefined)
    return () => onAssessment(instrumentKey, undefined)
  }, [instrumentKey, assessment, streamConnected, onAssessment])
  const planRef = useRef(signalPlan)
  planRef.current = signalPlan
  useEffect(() => {
    if (!activeTrade && planRef.current?.stage === 'CONFIRMED') onPrediction(planRef.current)
  }, [signalPlan?.id, signalPlan?.stage, signalPlan?.entry, signalPlan?.stopLoss, signalPlan?.target, signalPlan?.bullishScore, signalPlan?.bearishScore, signalPlan?.evidenceSummary?.coverage, activeTrade, onPrediction])
  const formatPrice = (value?: number) => value === undefined ? '—' : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  if (!visible) return null
  return (
    <section aria-label="Candle price-action agent" className="price-action-agent">
      <MultiTimeframePanel trajectories={trajectories} assessment={assessment} activeTrade={activeTrade} connected={streamConnected} now={now} />
      <SessionReview instrument={instrument} records={setupRecords} candles={five} now={now} contractToken={contract?.token} />
      <AgentTradeCard replayCandles={five} records={setupRecords} frontContract={contract} analysis={evidence.selectedAnalysis ?? analysis} evidence={evidence} prediction={prediction} activeTrade={activeTrade} pendingTrade={pendingTrade} instrument={instrument} interval={interval} now={now} tick={activeTrade?.contract ? activeTick : tick} streamConnected={streamConnected} />
      {!commodity && <GapOutlookCard instrument={instrument} outlook={gapOutlook.outlook} error={gapOutlook.error} now={now} />}
      <MarketContextPanel instrument={instrument} context={displayContext} loading={market.loading} refresh={() => void market.refresh()} outlook={news.outlook} chartCurrent={chartCurrent} analysis={evidence.selectedAnalysis ?? analysis} candles={snapshot} openingCandles={openingCandles} now={now}>
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
          <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11 }}>{commodity ? 'RSI level, momentum and swing structure (25%) plus futures VWAP (25%) supply half the technical score for setups and confirmed reversal exits. Chart patterns, other indicators and ATR complete the checks. Commodity news and global benchmarks provide sentiment reference; missing commodity OI/PCR stays unavailable.' : 'RSI level, momentum and HH/HL/LH/LL structure (25%) plus selected-index ATM CE/PE VWAP (25%) supply half the technical score for setups and confirmed reversal exits. Chart patterns, other indicators, OI/PCR and ATR/VIX complete the checks. FII/DII, news, global markets and PCR provide a separate sentiment reference.'} Gemini analysis does not delay, confirm or veto entries.</div>
        </section>
      </MarketContextPanel>
      {(analysis.support !== undefined || analysis.resistance !== undefined) && (
        <div style={{ marginTop: 5, color: 'var(--text-secondary)', fontSize: 12 }}>
          Support {formatPrice(analysis.support)} · Resistance {formatPrice(analysis.resistance)}
        </div>
      )}
      <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5 }}>
        {commodity ? 'LONG/SHORT tracks the displayed MCX futures contract. Profit/loss is recorded in price points, not rupees or broker fills. No orders are submitted.' : 'CALL/PUT is directional guidance on the index, not an options-contract recommendation or an order. Analysis is rule-based and not financial advice.'}
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
  const [optionExpiries, setOptionExpiries] = useState<Record<string, string>>({})
  const [heartbeat, setHeartbeat] = useState(Date.now())
  const [commodityMaster, setCommodityMaster] = useState<AngelOneInstrument[]>(readCommodityMaster)
  const [commodityError, setCommodityError] = useState('')
  const [restQuotes, setRestQuotes] = useState<Record<string, { price: number; receivedAt: number }>>({})
  const contractMinute = Math.floor(heartbeat / 60_000) * 60_000
  const commodities = useMemo(() => resolveCommodityContracts(commodityMaster, contractMinute), [commodityMaster, contractMinute])
  const marketInstruments = useMemo<MarketInstrument[]>(() => [...trackedInstruments, ...commodities], [commodities])
  const instrumentsRef = useRef(marketInstruments)
  instrumentsRef.current = marketInstruments
  const [selectedIndexToken, setSelectedIndexToken] = useState(trackedInstruments[0].token)
  const chartSectionRef = useRef<HTMLDivElement>(null)
  const [chartInterval, setChartInterval] = useState<ChartInterval>(defaultChartInterval)
  const [candleBook] = useState(() => new LiveCandleBook((token, interval) => {
    try { return readChartCache(token, interval) || [] }
    catch { return [] }
  }, token => trackedInstruments.some(item => item.token === token) ? 555 : 540, tick => tick.exchangeType === 5))
  const [chartCandles, setChartCandles] = useState<Record<string, AngelOneCandle[]>>(() => Object.fromEntries(trackedInstruments.map(instrument => [instrument.token, candleBook.get(instrument.token, defaultChartInterval)])))
  const [structureLevels, setStructureLevels] = useState<Record<string, { support?: number; resistance?: number }>>({})
  const updateStructureLevels = useCallback((instrument: string, support?: number, resistance?: number) => {
    setStructureLevels(existing => existing[instrument]?.support === support && existing[instrument]?.resistance === resistance ? existing : { ...existing, [instrument]: { support, resistance } })
  }, [])
  const [chartLoading, setChartLoading] = useState(false)
  const [syncProgress, setSyncProgress] = useState('')
  const [historyUpdates, setHistoryUpdates] = useState<Record<string, { receivedAt: number; through: number }>>({})
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
  const monitoredInstruments = useMemo<MarketInstrument[]>(() => {
    const existing = new Set(marketInstruments.map(item => item.token))
    const previousContracts = predictionRecords.filter(record => record.contract && ['PENDING', 'ACTIVE'].includes(record.status) && !existing.has(record.contract.token)).map(record => record.contract!)
    return [...marketInstruments, ...previousContracts]
  }, [marketInstruments, predictionRecords])
  instrumentsRef.current = monitoredInstruments
  const commodityStreamKey = monitoredInstruments.filter(item => item.exchange === 'MCX').map(item => item.token).sort().join(',')
  const assessments = useRef<Record<string, MultiTimeframeAssessment | undefined>>({})
  const updateAssessment = useCallback((key: string, assessment: MultiTimeframeAssessment | undefined) => { assessments.current[key] = assessment }, [])
  const getEntryConfirmation = useCallback((record: PredictionRecord) => {
    const current = assessments.current[record.contract?.token ?? record.instrument]
    return current && canEnterConfirmedPrediction(record, current.selectedPlan, current.reviewedAt, Date.now()) ? current.selectedPlan : undefined
  }, [])
  const getReversalConfirmation = useCallback((record: PredictionRecord) => {
    const current = assessments.current[record.contract?.token ?? record.instrument]
    return current ? selectReversalPlan(record, current.reviews, Date.now()) : undefined
  }, [])
  const getProtectionAssessment = useCallback((record: PredictionRecord): ProtectionAssessment | undefined => {
    const current = assessments.current[record.contract?.token ?? record.instrument]
    const review = current?.reviews.find(item => item.interval === record.interval && item.current && item.evidence.atr14)
      ?? current?.reviews.find(item => item.interval === defaultChartInterval && item.current && item.evidence.atr14)
      ?? current?.reviews.find(item => item.current && item.evidence.atr14)
    return review?.asOf ? { instrument: review.instrument, contractToken: review.contractToken, interval: review.interval, asOf: review.asOf, reviewedAt: review.reviewedAt, atr: review.evidence.atr14 } : undefined
  }, [])
  const chartTradeLevels = useMemo(() => Object.fromEntries(predictionRecords.filter(record => record.status === 'ACTIVE' && (!record.contract || marketInstruments.some(item => item.token === record.contract!.token)))
    .map(record => [record.instrument, { entry: record.entryPrice!, target: record.target, stopLoss: record.stopLoss }])), [predictionRecords, marketInstruments])
  const [indiaVixInstrument, setIndiaVixInstrument] = useState<IndiaVixInstrument>()
  const { snapshot: indiaVix, loading: indiaVixLoading, refresh: refreshIndiaVix } = useIndiaVix(indiaVixInstrument)
  const chartIntervalRef = useRef(chartInterval)
  chartIntervalRef.current = chartInterval
  const selectedIndexRef = useRef(selectedIndexToken)
  selectedIndexRef.current = selectedIndexToken
  const chartRequestRef = useRef(0)
  const historyController = useRef<AbortController | null>(null)
  const historyQueue = useRef<HistoryQueue | null>(null)
  const historyStarted = useRef(false)
  const historySyncedThrough = useRef(new Map<string, number>())
  const historyAttemptedAt = useRef(new Map<string, number>())
  const historyAuthBlocked = useRef(false)
  const synchronizeHistoryRef = useRef<(instruments?: MarketInstrument[], jobs?: ChartHistoryJob[]) => Promise<void>>(async () => {})
  const commodityHistoryRef = useRef<(instruments: MarketInstrument[]) => void>(() => {})
  commodityHistoryRef.current = instruments => {
    if (!historyStarted.current) return // The initial pass will include cached contracts.
    const queue = historyQueue.current
    if (!queue) { void synchronizeChartHistory(instruments); return }
    for (const instrument of instruments) for (const interval of historyIntervals) {
      const key = `${instrument.token}:${interval}`
      if (!queue.scheduled.has(key)) { queue.jobs.push({ token: instrument.token, interval }); queue.scheduled.add(key) }
    }
  }
  const previousCommodities = useRef(commodities)
  useEffect(() => {
    const selected = previousCommodities.current.find(item => item.token === selectedIndexRef.current)
    if (selected) {
      const next = instrumentsRef.current.find(item => item.name === selected.name)
      setSelectedIndexToken(next?.token || `commodity:${selected.root}`)
    }
    const next = instrumentsRef.current.filter(item => item.exchange === 'MCX')
    setChartCandles(existing => ({ ...existing, ...Object.fromEntries(next.map(item => [item.token, candleBook.get(item.token, chartIntervalRef.current)])) }))
    commodityHistoryRef.current(next)
    previousCommodities.current = commodities
    // Contract tokens, rather than the once-per-second clock, define rollover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commodityStreamKey, candleBook])
  const consumeTickRef = useRef<(tick: AngelOneStreamTick) => void>(() => {})
  consumeTickRef.current = tick => {
    const instrument = instrumentsRef.current.find(item => item.token === tick.token && item.exchangeType === tick.exchangeType)
    if (!instrument || !Number.isFinite(tickTimestamp(tick))) return
    recordIntrabarTick(tick, Date.now())
    syncTick(instrument.name, tick, record => {
      return candleBook.get(instrument.token, record.interval)
    }, Date.now(), getEntryConfirmation, getReversalConfirmation, getProtectionAssessment)
  }
  const saveChartCandles = useCallback((limit = Infinity) => {
    try {
      let saved = true
      const remaining = candleBook.flush((token, interval, candles) => {
        if (!writeChartCache(localStorage, chartCacheKey(token, interval), candles, selectedIndexRef.current)) saved = false
      }, limit)
      setChartCacheError(saved ? '' : 'Chart cache is full; live analysis continues. Candle history will be fetched again after reload.')
      return remaining
    } catch (error) {
      setChartCacheError(error instanceof Error ? `Unable to save chart locally: ${error.message}` : 'Unable to save chart locally.')
    }
  }, [candleBook])
  const loadSessionRef = useRef<(isActive: () => boolean) => Promise<void>>(async () => {})
  loadSessionRef.current = async isActive => {
    await Promise.resolve()
    if (!isActive()) return
    const profile = fetchAngelProfile()
    void synchronizeChartHistory()
    void fetchInstrumentQuotes()
    await profile
  }

  // Initial/manual sync warms saved history. The periodic scheduler below then
  // reconciles completed candles without resetting the live candle book.
  useEffect(() => {
    let active = true
    void loadSessionRef.current(() => active)
    return () => { active = false; chartRequestRef.current += 1; historyController.current?.abort() }
  }, [historySyncSession])

  useEffect(() => {
    const cache = new Map<string, AngelOneCandle[]>()
    syncPredictions(record => {
      const instrument = record.contract ?? trackedInstruments.find(item => item.name === record.instrument)
      if (!instrument) return { candles: [], tick: undefined }
      const key = `${instrument.token}:${record.interval}`
      if (!cache.has(key)) {
        try { cache.set(key, candleBook.get(instrument.token, record.interval)) }
        catch { cache.set(key, []) }
      }
      return { candles: cache.get(key)!, tick: streamTicks[instrument.token] }
    }, heartbeat, getEntryConfirmation, getReversalConfirmation, getProtectionAssessment)
  }, [heartbeat, streamTicks, chartCandles, chartInterval, candleBook, syncPredictions, getEntryConfirmation, getReversalConfirmation, getProtectionAssessment])

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
        for (const instrument of instrumentsRef.current) if (ticks[instrument.token]) next[instrument.token] = candleBook.get(instrument.token, chartIntervalRef.current)
        return next
      })
      setStreamTicks(current => ({ ...current, ...ticks }))
    }
    const socket = connectAngelOneStream((tick) => {
      if (!active) return
      const instrument = instrumentsRef.current.find(item => item.token === tick.token && item.exchangeType === tick.exchangeType)
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
    }, [
      { mode: 1, tokenList: [{ exchangeType: 1, tokens: ['99926000', '99926009'] }, { exchangeType: 3, tokens: ['99919000'] }] },
      ...(commodityStreamKey ? [{ mode: 2 as const, tokenList: [{ exchangeType: 5, tokens: commodityStreamKey.split(',') }] }] : []),
    ])
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
  }, [streamSession, candleBook, commodityStreamKey])

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
    setChartCandles(Object.fromEntries(instrumentsRef.current.map(instrument => [instrument.token, candleBook.get(instrument.token, interval)])))
  }

  synchronizeHistoryRef.current = synchronizeChartHistory
  async function synchronizeChartHistory(requestedInstruments = instrumentsRef.current, requestedJobs?: ChartHistoryJob[]) {
    if (!requestedJobs) historyAuthBlocked.current = false
    historyController.current?.abort()
    const controller = new AbortController()
    historyController.current = controller
    const request = ++chartRequestRef.current
    const queue: HistoryQueue = { jobs: requestedJobs ?? historyIntervals.flatMap(interval => requestedInstruments.map(instrument => ({ interval, token: instrument.token }))), scheduled: new Set() }
    for (const job of queue.jobs) queue.scheduled.add(`${job.token}:${job.interval}`)
    historyQueue.current = queue
    historyStarted.current = true
    const current = () => request === chartRequestRef.current && !controller.signal.aborted
    setChartLoading(true)
    setChartError('')
    try {
      let token = localStorage.getItem('angelone_jwt_token')
      if (!token && localStorage.getItem('angelone_refresh_token')) token = await recoverAngelOneSession('')
      if (!current()) return
      if (!token) { historyAuthBlocked.current = true; setChartError('Showing saved chart data. Log in to synchronize the latest candles.'); return }
      const errors: string[] = []
      const jobs = queue.jobs
      let completed = 0
      while (jobs.length && current()) {
        const job = prioritizeHistoryJobs(jobs, selectedIndexRef.current, chartIntervalRef.current)[0]
        jobs.splice(jobs.indexOf(job), 1)
        const instrument = instrumentsRef.current.find(item => item.token === job.token)
        if (!instrument) { completed++; continue } // An expired commodity contract rolled over while queued.
        const end = Date.now(), jobKey = `${job.token}:${job.interval}`
        historyAttemptedAt.current.set(jobKey, end)
        const cached = candleBook.get(job.token, job.interval)
        const range = historySyncRange(cached, job.interval, end, instrument.exchange === 'MCX' ? 540 : 555, historySyncedThrough.current.get(jobKey))
        if (job.cursor !== undefined) {
          range.from = job.cursor
          const limit = timeframeInfo[job.interval].requestDays
          range.to = Math.min(end, range.from + limit * 86_400_000)
        }
        setSyncProgress(`Syncing ${instrument.name} · ${intervalLabel(job.interval)} · ${completed}/${queue.scheduled.size} completed`)
        if (range.from >= range.to) { completed++; continue }
        let loaded = false, renewedSession = false
        for (let attempt = 0; attempt < 3 && current(); attempt++) {
          try {
            token = localStorage.getItem('angelone_jwt_token') || token
            const result = await runHistoricalRequest(signal => getHistoricalCandles(token!, {
              exchange: instrument.exchange, symboltoken: job.token, interval: job.interval,
              fromdate: formatHistoricalDate(range.from), todate: formatHistoricalDate(range.to),
            }, signal), controller.signal)
            if (!current()) return
            const candles = normalizeCandles(result.data || [])
            if (candles.length) {
              const through = Math.min(range.to, Date.parse(candles[candles.length - 1][0]) + intervalMilliseconds(job.interval))
              historySyncedThrough.current.set(jobKey, through)
              setHistoryUpdates(previous => ({ ...previous, [jobKey]: { receivedAt: Date.now(), through } }))
              const merged = candleBook.mergeHistory(job.token, job.interval, candles, Math.floor(range.to / 60_000) * 60_000)
              if (chartIntervalRef.current === job.interval) setChartCandles(existing => ({ ...existing, [instrument.token]: merged }))
            } else if (!cached.length) {
              errors.push(`${instrument.name} (${intervalLabel(job.interval)}): Angel One returned no candles. Saved data will appear when available.`)
            }
            loaded = true
            break
          } catch (error) {
            if (!current()) {
              return
            }
            if (error instanceof Error && isAngelOneAuthError(error) && !renewedSession) {
              renewedSession = true
              setSyncProgress(`Renewing Angel One session · ${instrument.name} · ${intervalLabel(job.interval)}`)
              token = await recoverAngelOneSession(token)
              if (!current()) return
              attempt-- // Token rotation does not consume the bounded transient retry budget.
              continue
            }
            const delay = historyRetryDelay(error, attempt)
            if (delay !== undefined && attempt < 2) {
              setSyncProgress(`Retrying ${instrument.name} · ${intervalLabel(job.interval)} in ${Math.ceil(delay / 1000)}s · Showing saved candles`)
              await abortableWait(delay, controller.signal)
            } else {
              errors.push(`${instrument.name} (${intervalLabel(job.interval)}): ${error instanceof Error ? error.message : 'request failed'}`)
              // Expired credentials cannot succeed for the remaining jobs.
              if ([401, 403].includes((error as { status?: number }).status ?? 0) || error instanceof Error && isAngelOneAuthError(error)) { historyAuthBlocked.current = true; jobs.length = 0 }
              break
            }
          }
        }
        historyAttemptedAt.current.set(jobKey, Date.now())
        if (loaded && range.to < end) jobs.push({ ...job, cursor: range.to - intervalMilliseconds(job.interval) })
        else completed++
        if (jobs.length && current()) await abortableWait(1200, controller.signal)
      }
      if (current() && errors.length) setChartError(`Historical sync incomplete. ${errors.join(' ')}`)
    } catch (error) {
      if (current()) {
        if (error instanceof Error && isAngelOneAuthError(error)) historyAuthBlocked.current = true
        setChartError(error instanceof Error ? error.message : 'Unable to synchronize chart data.')
      }
    } finally {
      if (request === chartRequestRef.current) { historyQueue.current = null; setChartLoading(false); setSyncProgress('') }
    }
  }

  useEffect(() => {
    const refresh = () => {
      if (document.hidden || !historyStarted.current || historyQueue.current || historyAuthBlocked.current) return
      const now = Date.now(), instruments = instrumentsRef.current
      const jobs = historyIntervals.flatMap(interval => instruments.filter(instrument => {
        const key = `${instrument.token}:${interval}`
        return historyRefreshDue(interval, instrument.name, now, historySyncedThrough.current.get(key), historyAttemptedAt.current.get(key))
      }).map(instrument => ({ token: instrument.token, interval })))
      if (jobs.length) void synchronizeHistoryRef.current(instruments, jobs)
    }
    const authChanged = () => { historyAuthBlocked.current = false; refresh() }
    const timer = window.setInterval(refresh, 15_000)
    window.addEventListener('online', refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('angelone-auth-changed', authChanged)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('angelone-auth-changed', authChanged)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

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
    setInstrumentLoading(true)
    setInstrumentError('')
    setCommodityError('')
    const quote = async (instrument: AngelOneInstrument, commodity = false) => {
      let token = localStorage.getItem('angelone_jwt_token')
      if (!token) return
      let result
      try { result = await getAngelOneLtp(token, instrument, AbortSignal.timeout(20_000)) }
      catch (error) {
        if (!(error instanceof Error) || !isAngelOneAuthError(error)) throw error
        token = await recoverAngelOneSession(token)
        result = await getAngelOneLtp(token, instrument, AbortSignal.timeout(20_000))
      }
      const value = Array.isArray(result.data) ? result.data.find(item => String(item.symboltoken) === instrument.token) : result.data
      const price = Number(value?.ltp)
      // REST LTP has no exchange trade timestamp; display it as a last quote, never create a candle with it.
      if (commodity && Number.isFinite(price) && price > 0) setRestQuotes(existing => ({ ...existing, [instrument.token]: { price, receivedAt: Date.now() } }))
    }
    const results = await Promise.allSettled([(async () => {
      const master = await getInstrumentMaster('indices')
      setOptionExpiries(Object.fromEntries(trackedInstruments.map(instrument => [instrument.name, master.find(item => String(item.token) === instrument.token)?.optionExpiry || ''])))
      const vix = resolveIndiaVixInstrument(master)
      setIndiaVixInstrument(current => !vix || current?.token === vix.token && current?.symbol === vix.symbol ? current : vix)
      await Promise.all(trackedInstruments.map(async (tracked) => {
        const instrument = master.find((item) => item.token === tracked.token)
          || { token: tracked.token, symbol: tracked.symbol, exch_seg: tracked.exchange === 'BSE' ? 'bse_cm' : 'nse_cm' }
        await quote(instrument)
      }))
    })(), (async () => {
      const master = await getInstrumentMaster('commodities').catch(error => {
        const saved = readCommodityMaster()
        if (resolveCommodityContracts(saved, Date.now()).length) return saved
        throw error
      })
      setCommodityMaster(master)
      try { localStorage.setItem('angelone_commodity_instruments_v1', JSON.stringify(master)) }
      catch { setChartCacheError('Commodity contracts could not be saved locally.') }
      const contracts = resolveCommodityContracts(master, Date.now())
      const errors: string[] = []
      for (const contract of contracts) {
        try { await quote({ ...contract, exch_seg: 'MCX' }, true) }
        catch (error) { errors.push(`${contract.name}: ${error instanceof Error ? error.message : 'quote unavailable'}`) }
      }
      if (!contracts.length) throw new Error('Angel One returned no current MCX futures for Natural Gas, Crude Oil, Silver or Gold.')
      if (errors.length) throw new Error(errors.join(' · '))
    })()])
    for (const [index, result] of results.entries()) if (result.status === 'rejected') {
      const message = result.reason instanceof Error ? result.reason.message : 'Unable to load Angel One instruments.'
      if (index === 0) setInstrumentError(message)
      else setCommodityError(message)
    }
    setInstrumentLoading(false)
  }

  return (
    <div className="prediction-page" style={{ minHeight: '100vh', background: 'var(--bg)', paddingBottom: 40 }}>
      <PredictionNotifications events={predictionNotifications} onDismiss={dismissPredictionEvent} />
      <ErrorToast message={errorToast?.message || ''} notificationId={errorToast?.id} onDismiss={() => setErrorToast(null)} />
      <PredictionHeader>
        <div className="container prediction-page-container">
          <div className="prediction-heading-row">
            <div className="prediction-heading-primary">
              <span className="prediction-live-label">{commodities.some(item => item.token === selectedIndexToken) ? 'Live market' : 'Live prediction'}</span>
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
                  {commoditySpecs.map(spec => {
                    const contract = commodities.find(item => item.root === spec.root)
                    return <option key={spec.root} value={contract?.token || `commodity:${spec.root}`} disabled={!contract}>{spec.name}{!contract ? instrumentLoading ? ' · Loading…' : ' · Unavailable' : ''}</option>
                  })}
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
          {selectedIndexToken.startsWith('commodity:') && <p role="status">The current commodity contract is unavailable. Refresh to load Angel One’s latest instruments.</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
            {marketInstruments.filter((instrument) => instrument.token === selectedIndexToken).map((instrument) => (
              <div key={instrument.token}>
                {instrument.exchange === 'MCX' && <CommodityContractInfo instrument={instrument} tick={streamTicks[instrument.token]} lastQuote={restQuotes[instrument.token]} connected={streamStatus === 'Connected'} now={heartbeat} />}
                <p className="agent-score-note" role="status">Historical candles · {historyUpdates[`${instrument.token}:${chartInterval}`]
                  ? `Last synced ${new Date(historyUpdates[`${instrument.token}:${chartInterval}`].receivedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST · Candles through ${new Date(historyUpdates[`${instrument.token}:${chartInterval}`].through).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST · Auto refresh after candle close`
                  : 'Waiting for broker history sync'}</p>
                <Suspense fallback={<div role="status" style={{ minHeight: 440, padding: 12 }}>Loading candle chart…</div>}>
                <CandleChart
                  name={instrument.name}
                  key={`${instrument.token}-${chartInterval}`}
                  intervalLabel={intervalLabel(chartInterval)}
                  savedCandleCount={chartCandles[instrument.token]?.length || 0}
                  spotIndex={instrument.exchange !== 'MCX'}
                  showIndexContext={instrument.exchange !== 'MCX'}
                  showTradeContext
                  optionExpiry={optionExpiries[instrument.name]}
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
                    const nextFormationTime = candleBucketTime(currentTimestamp, chartInterval, instrument.exchange === 'MCX' ? 540 : 555) + intervalMilliseconds(chartInterval)
                    const updated = new Date(tick.timestamp < 1_000_000_000_000 ? tick.timestamp * 1000 : tick.timestamp).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    const live = streamStatus === 'Connected' && isFreshTick(tick, heartbeat)
                    return `${live ? 'Live' : 'Last quote'} ${tick.ltp?.toFixed(2) ?? '–'} · ${live ? `Next candle ${formatCountdown(nextFormationTime - heartbeat)}` : 'Waiting for live tick'} · Updated ${updated} IST`
                  })()}
                  tick={streamTicks[instrument.token]}
                  candles={chartCandles[instrument.token] || []}
                />
                </Suspense>
              </div>
            ))}
            {monitoredInstruments.map(instrument => (
              <div key={`monitor-${instrument.token}`} hidden={instrument.token !== selectedIndexToken}>
                <PriceActionAgent
                  key={`agent-${instrument.name}-${instrument.token}`}
                  visible={instrument.token === selectedIndexToken}
                  onLevels={updateStructureLevels}
                  onError={showErrorToast}
                  onPrediction={recordPrediction}
                  onAssessment={updateAssessment}
                  trackLevels={marketInstruments.some(item => item.token === instrument.token)}
                  candlesByInterval={{ FIVE_MINUTE: candleBook.get(instrument.token, 'FIVE_MINUTE'), FIFTEEN_MINUTE: candleBook.get(instrument.token, 'FIFTEEN_MINUTE'), ONE_HOUR: candleBook.get(instrument.token, 'ONE_HOUR') }}
                  chartInterval={chartInterval}
                  instrument={instrument.name}
                  contract={validCommodityContract(instrument, instrument.name) ? instrument : undefined}
                  setupRecords={predictionRecords}
                  pendingTrade={predictionRecords.find(record => record.instrument === instrument.name && record.status === 'PENDING')}
                  activeTrade={predictionRecords.find(record => record.instrument === instrument.name && record.status === 'ACTIVE')}
                  tick={streamTicks[instrument.token]}
                  activeTick={streamTicks[predictionRecords.find(record => record.instrument === instrument.name && record.status === 'ACTIVE')?.contract?.token || instrument.token]}
                  streamConnected={streamStatus === 'Connected'}
                  indiaVix={indiaVix}
                  openingCandles={candleBook.get(instrument.token, 'FIVE_MINUTE')}
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
        {(chartError && !isInvalidToken(chartError) || chartCacheError || commodityError) && <div className="prediction-sync-errors" aria-label="Chart sync messages">
          {commodityError && <div role="alert" className="prediction-sync-error">{commodityError}</div>}
          {chartError && !isInvalidToken(chartError) && <div role="alert" className="prediction-sync-error">{chartError}</div>}
          {chartCacheError && <div role="alert" className="prediction-sync-warning">{chartCacheError}</div>}
        </div>}
      </div>
    </div>
  )
}
