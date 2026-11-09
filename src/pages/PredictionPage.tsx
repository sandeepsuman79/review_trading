import { canMonitorInstrument, monitoringReconnectDelay, validMonitoringAuth, type MonitoringAccess } from '../analysis/monitoringSession'
import { instrumentSession } from '../analysis/tradingSession'
import { candleProtectionReview, currentTradeTarget } from '../analysis/tradeTargets'
import { writeChartCache } from '../storage/chartCache'
import { contractExpiryNotice } from '../analysis/agentMonitoring'
import { recordIntrabarTick } from '../analysis/intrabarContext'
import type { AgentTimeframe } from '../analysis/multiTimeframe'
import { analyzeCandleAgent, type CandleAssessment } from '../analysis/candleAgent'
import { candleAgentDecisions } from '../analysis/candleAgentDiagnostics'
import { recordTradeDiagnostics } from '../analysis/tradeDecision'
import { currentSetupPrediction } from '../analysis/setupTiming'
import { analyzeTradingEvidence } from '../analysis/tradingEvidence'
import CandleAgentCard from '../components/CandleAgentCard'
import type { ProtectionAssessment } from '../analysis/tradeProtection'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { connectAngelOneOrderStream, connectAngelOneStream, getAngelOneLtp, getAngelOneProfile, getHistoricalCandles, getInstrumentMaster } from '../api/angelOne'
import { isAngelOneAuthError, recoverAngelOneSession, reportAngelOneSessionExpired } from '../api/angelOneSession'
import type { AngelOneOrderUpdate } from '../api/angelOne'
import type { AngelOneStreamTick } from '../api/angelOne'
import type { AngelOneCandle, AngelOneProfile, AngelOneInstrument } from '../api/angelOne'
import { analyzePriceAction, type PriceActionInterval } from '../analysis/priceAction'
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
import ConfirmedTrades from '../components/ConfirmedTrades'
import { type PredictionPlan } from '../analysis/earlyPrediction'
import { usePredictionHistory } from '../hooks/usePredictionHistory'
import PredictionHeader from '../components/PredictionHeader'
import PredictionNotifications from '../components/PredictionNotifications'
import type { PredictionEvent } from '../analysis/predictionEvents'
import { canEnterConfirmedPrediction, type PredictionRecord } from '../analysis/predictionHistory'
import type { IndiaVixSnapshot } from '../api/marketContext'
import { useInstitutionalFlows } from '../hooks/useInstitutionalFlows'
import { useGapOutlook } from '../hooks/useGapOutlook'
import GapOutlookCard from '../components/GapOutlookCard'
import { commoditySpecs, mcxSession, resolveCommodityContracts, validCommodityContract, isCommodity, type CommodityContract } from '../analysis/commodities'

const CandleChart = lazy(() => import('../components/IndexOptionChart'))

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
    <p><a href={session.source ?? 'https://www.mcxindia.com/market-operations/trading-surveillance'} target="_blank" rel="noopener noreferrer">{session.special ? session.label : 'Regular MCX session'}</a>: {session.special ? session.date : 'Mon–Fri'} {session.openLabel}–{session.closeLabel} IST · {session.regularSession ? 'Within trading hours' : 'Outside trading hours'}</p>
    <small>{quoteLabel} · Live volume is partial until historical sync.</small>
    {expiry && <p role="status">{expiry}</p>}
  </div>
}

function PriceActionAgent({ candlesByInterval, trackLevels, onAssessment, openingCandles, now, instrument, contract, setupRecords, activeTrade, pendingTrade, tick, activeTick, streamConnected, indiaVix, visible, referenceEnabled, onLevels, onError, onPrediction }: {
  candlesByInterval: Record<AgentTimeframe, AngelOneCandle[]>; chartInterval: AgentTimeframe; trackLevels: boolean
  onAssessment: (key: string, assessment: CandleAssessment | undefined) => void
  openingCandles: AngelOneCandle[]; now: number; instrument: string; contract?: CommodityContract; setupRecords: PredictionRecord[]
  activeTrade?: PredictionRecord; pendingTrade?: PredictionRecord; tick?: AngelOneStreamTick; activeTick?: AngelOneStreamTick
  streamConnected: boolean; indiaVix?: IndiaVixSnapshot; visible: boolean; referenceEnabled: boolean; onLevels: (instrument: string, support?: number, resistance?: number) => void
  onError: (message: string) => void; onPrediction: (plan: PredictionPlan) => void
}) {
  const instrumentKey = contract?.token ?? instrument
  const five = useCompletedCandles(candlesByInterval.FIVE_MINUTE, 'FIVE_MINUTE', now, instrumentSession(now, instrument).openMinute)
  const minute = Math.floor(now / 60000)
  const base = useMemo(() => analyzeCandleAgent({ candles: five, instrument, contract, now: Math.max(minute * 60000, Date.now()) }), [five, instrument, contract, minute])
  const candidate = base.plan ? currentSetupPrediction({ side: base.plan.side, reason: base.reason, plan: { ...base.plan, generatedAt: now } }, setupRecords, candlesByInterval.FIVE_MINUTE, now) : undefined
  const plan = candidate && 'plan' in candidate ? candidate.plan : undefined
  const assessment = useMemo<CandleAssessment>(() => ({ ...base, reviewedAt: now, signal: base.signal ? { ...base.signal, reviewedAt: now } : undefined, plan, ...(base.plan && !plan ? { state: 'WAIT', reason: candidate?.reason ?? 'Setup ended; waiting for a new completed candle.' } : {}) }), [base, now, plan, candidate?.reason])
  useEffect(() => { recordTradeDiagnostics(instrument, 'FIVE_MINUTE', assessment.asOf, now, candleAgentDecisions(assessment)) }, [instrument, assessment, now])
  useLayoutEffect(() => { onAssessment(instrumentKey, streamConnected ? assessment : undefined); return () => onAssessment(instrumentKey, undefined) }, [instrumentKey, streamConnected, assessment, onAssessment])
  useEffect(() => { if (trackLevels) onLevels(instrument, base.support, base.resistance) }, [instrument, trackLevels, base.support, base.resistance, onLevels])
  const planRef = useRef(plan); planRef.current = plan
  useEffect(() => { if (!activeTrade && planRef.current && streamConnected) onPrediction(planRef.current) }, [plan?.id, plan?.entry, plan?.stopLoss, plan?.target, activeTrade, streamConnected, onPrediction])
  if (!visible) return null
  return <section aria-label="Candle price-action agent" className="price-action-agent">
    <CandleAgentCard assessment={assessment} active={activeTrade} pending={pendingTrade} records={setupRecords} candles={five}
      tick={activeTrade?.contract ? activeTick : tick} connected={streamConnected} now={now} contract={contract} />
    {referenceEnabled && <AgentMarketReference instrument={instrument} five={five} openingCandles={openingCandles} now={now} indiaVix={indiaVix} current={base.current} onError={onError} />}
  </section>
}

function AgentMarketReference({ instrument, five, openingCandles, now, indiaVix, current, onError }: {
  instrument: string; five: AngelOneCandle[]; openingCandles: AngelOneCandle[]; now: number; indiaVix?: IndiaVixSnapshot; current: boolean; onError: (message: string) => void
}) {
  const minute = Math.floor(now / 60000)
  const market = useMarketContext(instrument), news = useNewsAssessment(market.context, now)
  const { history: flowHistory } = useInstitutionalFlows(market.context?.inputs?.institutional)
  useEffect(() => { if (market.error) onError(market.error) }, [market.error, onError])
  const referenceAnalysis = useMemo(() => analyzePriceAction(five, 'FIVE_MINUTE', minute * 60000, instrument), [five, minute, instrument])
  const referenceEvidence = useMemo(() => analyzeTradingEvidence({ analysis: referenceAnalysis, candles: five, interval: 'FIVE_MINUTE', instrument,
    now: minute * 60000, context: market.context, outlook: news.outlook, flowHistory, indiaVix, confirmationContext: {}, recordDiagnostics: false }), [referenceAnalysis, five, instrument, minute, market.context, news.outlook, flowHistory, indiaVix])
  const gap = useGapOutlook(instrument, referenceEvidence, now)
  return <>
    {!isCommodity(instrument) && <GapOutlookCard instrument={instrument} outlook={gap.outlook} error={gap.error} now={now} />}
    <details><summary>Market reference · Independent of candlestick confirmation</summary>
      <MarketContextPanel instrument={instrument} context={market.context} loading={market.loading} refresh={() => void market.refresh()} outlook={news.outlook}
        chartCurrent={current} analysis={referenceAnalysis} candles={five} openingCandles={openingCandles} now={now} />
    </details>
  </>
}

export default function PredictionPage({ dashboardVisible = true, monitoringSession }: { dashboardVisible?: boolean; monitoringSession?: MonitoringAccess }) {
  const [angelProfile, setAngelProfile] = useState<AngelOneProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [instrumentError, setInstrumentError] = useState('')
  const [instrumentLoading, setInstrumentLoading] = useState(false)
  const [optionExpiries, setOptionExpiries] = useState<Record<string, string>>({})
  const [heartbeat, setHeartbeat] = useState(Date.now())
  const monitoringAccessRef = useRef(monitoringSession); monitoringAccessRef.current = monitoringSession
  const dashboardVisibleRef = useRef(dashboardVisible); dashboardVisibleRef.current = dashboardVisible
  const canObserve = useCallback((instrument?: string, closingQuotes = true) => {
    const access = monitoringAccessRef.current
    return access?.token === localStorage.getItem('angelone_jwt_token') && canMonitorInstrument(access, Date.now(), instrument, closingQuotes)
  }, [])
  const canFetchMarketData = useCallback(() => {
    const access = monitoringAccessRef.current
    return access?.token === localStorage.getItem('angelone_jwt_token') && validMonitoringAuth(access, Date.now()) && (dashboardVisibleRef.current || canObserve())
  }, [canObserve])
  const monitoringActive = canMonitorInstrument(monitoringSession, heartbeat)
  const marketDataAllowed = monitoringActive || dashboardVisible && validMonitoringAuth(monitoringSession, heartbeat)

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
  }, (token, time) => instrumentSession(time, trackedInstruments.find(item => item.token === token)?.name ?? 'Crude Oil').openMinute, tick => tick.exchangeType === 5))
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
  const submitPrediction = useCallback((plan: PredictionPlan) => { if (canObserve(plan.instrument, false)) recordPrediction(plan) }, [canObserve, recordPrediction])
  const monitoredInstruments = useMemo<MarketInstrument[]>(() => {
    const existing = new Set(marketInstruments.map(item => item.token))
    const previousContracts = predictionRecords.filter(record => record.contract && ['PENDING', 'ACTIVE'].includes(record.status) && !existing.has(record.contract.token)).map(record => record.contract!)
    return [...marketInstruments, ...previousContracts]
  }, [marketInstruments, predictionRecords])
  instrumentsRef.current = monitoredInstruments
  const commodityStreamKey = monitoredInstruments.filter(item => item.exchange === 'MCX').map(item => item.token).sort().join(',')
  const assessments = useRef<Record<string, CandleAssessment | undefined>>({})
  const updateAssessment = useCallback((key: string, assessment: CandleAssessment | undefined) => { assessments.current[key] = assessment }, [])
  const getEntryConfirmation = useCallback((record: PredictionRecord) => {
    if (!canObserve(record.instrument, false)) return undefined
    const current = assessments.current[record.contract?.token ?? record.instrument]
    return current && canEnterConfirmedPrediction(record, current.plan, current.reviewedAt, Date.now()) ? current.plan : undefined
  }, [canObserve])
  const getReversalConfirmation = useCallback((record: PredictionRecord) => {
    if (!canObserve(record.instrument)) return undefined
    const current = assessments.current[record.contract?.token ?? record.instrument]
    return current?.plan?.side !== record.side ? current?.plan : undefined
  }, [canObserve])
  const getProtectionAssessment = useCallback((record: PredictionRecord): ProtectionAssessment | undefined => {
    if (!canObserve(record.instrument)) return undefined
    const current = assessments.current[record.contract?.token ?? record.instrument]
    const instrument = instrumentsRef.current.find(item => item.token === record.contract?.token || !record.contract && item.name === record.instrument)
    return current && instrument ? candleProtectionReview(current, candleBook.get(instrument.token, 'FIVE_MINUTE')) : undefined
  }, [canObserve, candleBook])
  const getCandleExit = useCallback((record: PredictionRecord) => {
    if (!canObserve(record.instrument)) return undefined
    const current = assessments.current[record.contract?.token ?? record.instrument]
    return current?.current && Date.now() - current.reviewedAt <= 30000 ? current.signal : undefined
  }, [canObserve])
  const chartTradeLevels = useMemo(() => Object.fromEntries(predictionRecords.filter(record => record.status === 'ACTIVE' && (!record.contract || marketInstruments.some(item => item.token === record.contract!.token)))
    .map(record => [record.instrument, { entry: record.entryPrice!, target: currentTradeTarget(record), stopLoss: record.stopLoss, trailingStop: record.protection?.armed ? record.protection.stop : undefined }])), [predictionRecords, marketInstruments])
  const [indiaVixInstrument, setIndiaVixInstrument] = useState<IndiaVixInstrument>()
  const { snapshot: indiaVix, loading: indiaVixLoading, refresh: refreshIndiaVix } = useIndiaVix(indiaVixInstrument, dashboardVisible && marketDataAllowed)
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
    if (!canObserve()) return
    const instrument = instrumentsRef.current.find(item => item.token === tick.token && item.exchangeType === tick.exchangeType)
    if (!instrument || !canObserve(instrument.name) || !Number.isFinite(tickTimestamp(tick))) return
    recordIntrabarTick(tick, Date.now())
    syncTick(instrument.name, tick, record => {
      return candleBook.get(instrument.token, record.interval)
    }, Date.now(), getEntryConfirmation, getReversalConfirmation, getProtectionAssessment, getCandleExit)
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
    if (!isActive() || !canFetchMarketData()) return
    const profile = fetchAngelProfile()
    void synchronizeChartHistory()
    void fetchInstrumentQuotes()
    await profile
  }

  // Initial/manual sync warms saved history. The periodic scheduler below then
  // reconciles completed candles without resetting the live candle book.
  useEffect(() => {
    if (!marketDataAllowed) return
    let active = true
    void loadSessionRef.current(() => active)
    return () => { active = false; chartRequestRef.current += 1; historyController.current?.abort() }
  }, [historySyncSession, marketDataAllowed])

  useEffect(() => {
    if (!canObserve()) return
    const cache = new Map<string, AngelOneCandle[]>()
    syncPredictions(record => {
      if (!canObserve(record.instrument)) return { candles: [], tick: undefined }
      const instrument = record.contract ?? trackedInstruments.find(item => item.name === record.instrument)
      if (!instrument) return { candles: [], tick: undefined }
      const key = `${instrument.token}:${record.interval}`
      if (!cache.has(key)) {
        try { cache.set(key, candleBook.get(instrument.token, record.interval)) }
        catch { cache.set(key, []) }
      }
      return { candles: cache.get(key)!, tick: streamTicks[instrument.token] }
    }, heartbeat, getEntryConfirmation, getReversalConfirmation, getProtectionAssessment, getCandleExit)
  }, [heartbeat, streamTicks, chartCandles, chartInterval, candleBook, syncPredictions, canObserve, getEntryConfirmation, getReversalConfirmation, getProtectionAssessment, getCandleExit])

  const previousErrors = useRef<string[]>([])
  useEffect(() => {
    const errors = [profileError, instrumentError, chartError, streamStatus, orderStatus]
    const toastErrors = errors.filter((message, index) => message && (index < 2 || isInvalidToken(message)))
    const hasNewError = errors.some((message, index) => message && (index < 2 || isInvalidToken(message)) && message !== previousErrors.current[index])
    previousErrors.current = errors
    if (hasNewError) setErrorToast({ message: [...new Set(toastErrors)].join(' · '), id: Date.now() })
  }, [profileError, instrumentError, chartError, streamStatus, orderStatus])


  useEffect(() => {
    if (!monitoringActive) { setStreamStatus('Monitoring paused'); setOrderStatus('Monitoring paused'); return }
    let active = true
    let reconnectTimer: number | undefined
    let stableTimer: number | undefined
    let displayTimer: number | undefined
    let connectionStatus = 'Connecting'
    let pendingTicks: Record<string, AngelOneStreamTick> = {}
    const connectionToken = localStorage.getItem('angelone_jwt_token') || ''
    const reconnect = () => {
      if (!active || !canObserve() || connectionStatus === 'Connecting' || connectionStatus === 'Connected') return
      connectionStatus = 'Connecting'
      window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      setStreamSession(current => current + 1)
    }
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
      if (!active || !canObserve()) return
      const instrument = instrumentsRef.current.find(item => item.token === tick.token && item.exchangeType === tick.exchangeType)
      if (!instrument || !canObserve(instrument.name) || !candleBook.accept(tick)) return
      // Record every exchange quote before React batches chart updates, preserving stop/target ordering.
      consumeTickRef.current(tick)
      pendingTicks[tick.token] = tick
      if (displayTimer === undefined) displayTimer = window.setTimeout(publishTicks, 250)
    }, status => {
      if (!active) return
      connectionStatus = status
      setStreamStatus(status)
      if (isAngelOneAuthError({ message: status, errorcode: status.split(':')[0] })) reportAngelOneSessionExpired(connectionToken)
      if (status === 'Connected') {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        window.clearTimeout(stableTimer)
        stableTimer = window.setTimeout(() => { streamRetryRef.current = 0 }, 30_000)
      } else if (status === 'Disconnected') {
        window.clearTimeout(stableTimer)
        if (reconnectTimer === undefined) {
          const delay = monitoringReconnectDelay(++streamRetryRef.current)
          reconnectTimer = window.setTimeout(reconnect, delay)
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
    window.addEventListener('online', reconnect)
    window.addEventListener('focus', reconnect)
    document.addEventListener('visibilitychange', reconnect)
    return () => {
      active = false
      window.clearTimeout(reconnectTimer)
      window.clearTimeout(stableTimer)
      window.clearTimeout(displayTimer)
      window.removeEventListener('angelone-auth-changed', synchronizeAfterLogin)
      window.removeEventListener('online', reconnect)
      window.removeEventListener('focus', reconnect)
      document.removeEventListener('visibilitychange', reconnect)
      socket?.close()
      orderSocket?.close()
    }
  }, [streamSession, candleBook, commodityStreamKey, monitoringActive, canObserve])

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
    if (!canFetchMarketData()) return
    if (!requestedJobs) historyAuthBlocked.current = false
    historyController.current?.abort()
    const controller = new AbortController()
    historyController.current = controller
    const request = ++chartRequestRef.current
    const queue: HistoryQueue = { jobs: requestedJobs ?? historyIntervals.flatMap(interval => requestedInstruments.map(instrument => ({ interval, token: instrument.token }))), scheduled: new Set() }
    for (const job of queue.jobs) queue.scheduled.add(`${job.token}:${job.interval}`)
    historyQueue.current = queue
    historyStarted.current = true
    const current = () => request === chartRequestRef.current && !controller.signal.aborted && canFetchMarketData()
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
        const range = historySyncRange(cached, job.interval, end, instrumentSession(end, instrument.name).openMinute, historySyncedThrough.current.get(jobKey))
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
              if ([401, 403].includes((error as { status?: number }).status ?? 0) || error instanceof Error && isAngelOneAuthError(error)) {
                historyAuthBlocked.current = true; jobs.length = 0
                if (error instanceof Error && isAngelOneAuthError(error)) reportAngelOneSessionExpired(token)
              }
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
      if (!canObserve() || !historyStarted.current || historyQueue.current || historyAuthBlocked.current) return
      const now = Date.now(), instruments = instrumentsRef.current
      const jobs = historyIntervals.flatMap(interval => instruments.filter(instrument => {
        const key = `${instrument.token}:${interval}`
        return canObserve(instrument.name) && historyRefreshDue(interval, instrument.name, now, historySyncedThrough.current.get(key), historyAttemptedAt.current.get(key))
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
  }, [canObserve])

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
    if (!canFetchMarketData()) return
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
        if (!canFetchMarketData() || !(error instanceof Error) || !isAngelOneAuthError(error) || !refreshToken) throw error
        token = await recoverAngelOneSession(token)
        if (!canFetchMarketData()) return
        if (!token) throw new Error('Angel One session expired. Please log in again.')
        result = await getAngelOneProfile(token)
      }
      if (!result.data) throw new Error(result.message || 'Profile data was not returned.')
      setAngelProfile(result.data)
    } catch (error) {
      if (token && canFetchMarketData() && error instanceof Error && isAngelOneAuthError(error)) reportAngelOneSessionExpired(token)
      setProfileError(error instanceof Error ? error.message : 'Unable to load Angel One profile.')
    } finally {
      setProfileLoading(false)
    }
  }

  async function fetchInstrumentQuotes() {
    if (!canFetchMarketData()) return
    setInstrumentLoading(true)
    setInstrumentError('')
    setCommodityError('')
    const quote = async (instrument: AngelOneInstrument, commodity = false) => {
      if (!canFetchMarketData()) return
      let token = localStorage.getItem('angelone_jwt_token')
      if (!token) return
      let result
      try { result = await getAngelOneLtp(token, instrument, AbortSignal.timeout(20_000)) }
      catch (error) {
        if (!canFetchMarketData() || !(error instanceof Error) || !isAngelOneAuthError(error)) throw error
        token = await recoverAngelOneSession(token)
        if (!canFetchMarketData()) return
        try { result = await getAngelOneLtp(token, instrument, AbortSignal.timeout(20_000)) }
        catch (retryError) {
          if (retryError instanceof Error && isAngelOneAuthError(retryError)) reportAngelOneSessionExpired(token)
          throw retryError
        }
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
            {marketInstruments.filter((instrument) => dashboardVisible && instrument.token === selectedIndexToken).map((instrument) => (
              <div key={instrument.token}>
                {instrument.exchange === 'MCX' && <CommodityContractInfo instrument={instrument} tick={streamTicks[instrument.token]} lastQuote={restQuotes[instrument.token]} connected={streamStatus === 'Connected'} now={heartbeat} />}
                <p className="agent-score-note" role="status">Historical candles · {historyUpdates[`${instrument.token}:${chartInterval}`]
                  ? `Last synced ${new Date(historyUpdates[`${instrument.token}:${chartInterval}`].receivedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST · Candles through ${new Date(historyUpdates[`${instrument.token}:${chartInterval}`].through).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST · Auto refresh after candle close`
                  : 'Waiting for broker history sync'}</p>
                <Suspense fallback={<div role="status" style={{ minHeight: 440, padding: 12 }}>Loading candle chart…</div>}>
                <CandleChart interval={chartInterval}
                  priceTickSize={validCommodityContract(instrument, instrument.name) ? instrument.tickSize : .01}
                  name={instrument.name}
                  key={instrument.token}
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
                    const nextFormationTime = candleBucketTime(currentTimestamp, chartInterval, instrumentSession(currentTimestamp, instrument.name).openMinute) + intervalMilliseconds(chartInterval)
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
                  visible={dashboardVisible && instrument.token === selectedIndexToken}
                  referenceEnabled={marketDataAllowed}
                  onLevels={updateStructureLevels}
                  onError={showErrorToast}
                  onPrediction={submitPrediction}
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
                  streamConnected={monitoringActive && canObserve(instrument.name) && streamStatus === 'Connected'}
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
        {dashboardVisible && <ConfirmedTrades records={predictionRecords} now={heartbeat} streamConnected={streamStatus === 'Connected'} storageError={tradeStorageError} />}
        {(chartError && !isInvalidToken(chartError) || chartCacheError || commodityError) && <div className="prediction-sync-errors" aria-label="Chart sync messages">
          {commodityError && <div role="alert" className="prediction-sync-error">{commodityError}</div>}
          {chartError && !isInvalidToken(chartError) && <div role="alert" className="prediction-sync-error">{chartError}</div>}
          {chartCacheError && <div role="alert" className="prediction-sync-warning">{chartCacheError}</div>}
        </div>}
      </div>
    </div>
  )
}
