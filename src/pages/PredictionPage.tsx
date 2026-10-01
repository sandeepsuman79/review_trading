import { FormEvent, WheelEvent as ReactWheelEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { connectAngelOneOrderStream, connectAngelOneStream, createGttRule, getAngelOneLtp, getAngelOneProfile, getAngelOneRms, getGttRuleDetails, getHistoricalCandles, getHistoricalOi, getInstrumentMaster, listGttRules, modifyGttRule, cancelGttRule, refreshAngelOneToken } from '../api/angelOne'
import type { AngelOneOrderUpdate } from '../api/angelOne'
import type { AngelOneStreamTick } from '../api/angelOne'
import type { AngelOneCandle, AngelOneGttRule, AngelOneProfile, AngelOneRms } from '../api/angelOne'
import { getAiPriceAction, type AiPriceAction } from '../api/ai'
import { analyzePriceAction, type PriceActionAnalysis } from '../analysis/priceAction'

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

function liveTickTimestamp(tick: AngelOneStreamTick, now: number) {
  const exchangeTimestamp = tick.timestamp < 1_000_000_000_000 ? tick.timestamp * 1000 : tick.timestamp
  return Math.max(exchangeTimestamp, now)
}

function addInProgressCandle(candles: AngelOneCandle[], tick: AngelOneStreamTick | undefined, interval: ChartInterval, now: number) {
  if (!tick?.ltp) return candles
  const bucketTime = candleBucket(liveTickTimestamp(tick, now), interval)
  const last = candles[candles.length - 1]
  if (last && candleBucket(new Date(last[0]).getTime(), interval) === bucketTime) {
    const updatedCandle: AngelOneCandle = [last[0], last[1], Math.max(last[2], tick.ltp), Math.min(last[3], tick.ltp), tick.ltp, tick.volume ?? last[5]]
    return [...candles.slice(0, -1), updatedCandle]
  }
  const inProgressCandle: AngelOneCandle = [new Date(bucketTime).toISOString(), tick.ltp, tick.ltp, tick.ltp, tick.ltp, tick.volume ?? 0]
  return [...candles, inProgressCandle]
}

function CandleChart({ candles, name, interval, tick }: { candles: AngelOneCandle[]; name: string; interval: ChartInterval; tick?: AngelOneStreamTick }) {
  const rightGutter = 32
  const axisWidth = 100
  const minVisibleWidth = 900
  const candleSpacing = 14
  const width = Math.max(minVisibleWidth, candles.length * candleSpacing + rightGutter)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const initialPositionedRef = useRef(false)

  const getMaxScrollLeft = () => {
    const viewport = scrollRef.current
    if (!viewport) return 0
    return Math.max(0, viewport.scrollWidth - viewport.clientWidth)
  }

  const positionAtLatest = () => {
    const viewport = scrollRef.current
    if (!viewport) return
    viewport.scrollLeft = getMaxScrollLeft()
  }

  const handleScroll = () => {
    const viewport = scrollRef.current
    if (!viewport) return
    const maxScrollLeft = getMaxScrollLeft()
    const distanceFromLatest = maxScrollLeft - viewport.scrollLeft
    // If the user manually moves away from the latest edge, stop following live candles.
    // Returning to the right edge re-enables live auto-follow.
    followLatestRef.current = distanceFromLatest <= 24
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.shiftKey ? event.deltaY : 0
    if (horizontalDelta === 0) return

    event.preventDefault()
    event.stopPropagation()
    const viewport = scrollRef.current
    if (viewport) viewport.scrollLeft += horizontalDelta
  }

  // Initial load / timeframe change: always show the current/latest date at the right.
  useLayoutEffect(() => {
    initialPositionedRef.current = false
    followLatestRef.current = true

    let firstFrame = 0
    let secondFrame = 0
    const position = () => {
      if (!followLatestRef.current) return
      positionAtLatest()
      firstFrame = window.requestAnimationFrame(() => {
        if (!followLatestRef.current) return
        positionAtLatest()
        secondFrame = window.requestAnimationFrame(() => {
          if (!followLatestRef.current) return
          positionAtLatest()
          initialPositionedRef.current = true
        })
      })
    }

    position()
    const retry = window.setTimeout(position, 250)
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      window.clearTimeout(retry)
    }
  }, [interval, width])

  // When a NEW candle is appended, keep the latest candle visible only if the
  // user was already following the latest edge. If they are reading history,
  // their horizontal position is preserved.
  useLayoutEffect(() => {
    if (!initialPositionedRef.current || !followLatestRef.current) return
    positionAtLatest()
  }, [candles.length])

  // A live tick updates the current candle every second, but should not yank a
  // user back to today/latest when they have intentionally scrolled left.
  useLayoutEffect(() => {
    if (followLatestRef.current) positionAtLatest()
  }, [tick?.timestamp])

  if (!candles.length) return <div style={{ color: 'var(--text-secondary)', padding: 24 }}>No candle data returned.</div>

  const height = 460
  const padding = { top: 18, bottom: 34, left: 58 }
  const candleValues = candles.flatMap((candle) => [candle[2], candle[3]])
  const rawMinimum = Math.min(...candleValues, tick?.ltp ?? Number.POSITIVE_INFINITY)
  const rawMaximum = Math.max(...candleValues, tick?.ltp ?? Number.NEGATIVE_INFINITY)
  const rawRange = rawMaximum - rawMinimum || Math.max(rawMaximum * 0.002, 1)
  const scalePadding = rawRange * 0.05
  const minimum = rawMinimum - scalePadding
  const maximum = rawMaximum + scalePadding
  const range = maximum - minimum
  const chartWidth = width - padding.left - rightGutter
  const chartHeight = height - padding.top - padding.bottom
  const xStep = chartWidth / Math.max(candles.length, 1)
  const candleWidth = Math.max(4, Math.min(10, xStep * 0.58))
  const y = (value: number) => padding.top + ((maximum - value) / range) * chartHeight
  const labelStep = Math.max(1, Math.ceil(candles.length / 8))
  const labelIndexes = candles.map((_, index) => index).filter((index) => index % labelStep === 0 || index === candles.length - 1)
  const livePriceY = tick?.ltp == null ? undefined : y(tick.ltp)
  const liveCandle = candles[candles.length - 1]
  const livePriceColor = liveCandle && liveCandle[4] >= liveCandle[1] ? '#16A34A' : '#DC2626'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${axisWidth}px`, width: '100%', height: 490, overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        style={{
          width: '100%',
          minWidth: 0,
          height: 490,
          overflowX: 'auto',
          overflowY: 'hidden',
          overscrollBehavior: 'contain',
          touchAction: 'pan-x pan-y',
          scrollbarGutter: 'stable',
          WebkitOverflowScrolling: 'touch',
        }}
      >
      <div style={{ position: 'relative', width: `${width}px`, minWidth: `${width}px`, height: 490, boxSizing: 'border-box' }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${name} ${intervalLabel(interval)} candlestick chart`}
          style={{ width: `${width}px`, maxWidth: 'none', height: `${height}px`, display: 'block' }}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const lineY = padding.top + chartHeight * fraction
            return <line key={fraction} x1={padding.left} x2={width - rightGutter} y1={lineY} y2={lineY} stroke="var(--border)" strokeDasharray="3 4" />
          })}

          {livePriceY !== undefined && (
            <line
              x1={padding.left}
              x2={width - rightGutter}
              y1={livePriceY}
              y2={livePriceY}
              stroke={livePriceColor}
              strokeDasharray="4 3"
              strokeWidth="1"
            />
          )}

          {candles.map((candle, index) => {
            const [timestamp, open, high, low, close] = candle
            const centerX = padding.left + index * xStep + xStep / 2
            const bullish = close >= open
            const color = bullish ? '#16A34A' : '#DC2626'
            const bodyTop = y(Math.max(open, close))
            const bodyHeight = Math.max(4, Math.abs(y(open) - y(close)))
            return (
              <g key={`${timestamp}-${index}`}>
                <title>{`${new Date(timestamp).toLocaleString()} | Open: ${open.toFixed(2)} | High: ${high.toFixed(2)} | Low: ${low.toFixed(2)} | Close: ${close.toFixed(2)} | Volume: ${candle[5]}`}</title>
                <line x1={centerX} x2={centerX} y1={y(high)} y2={y(low)} stroke={color} strokeWidth="1.5" />
                <rect
                  x={centerX - candleWidth / 2}
                  y={bodyTop}
                  width={candleWidth}
                  height={bodyHeight}
                  fill={color}
                  stroke={color}
                  strokeWidth={0.5}
                  rx="0"
                />
              </g>
            )
          })}
        </svg>

        <div style={{ position: 'sticky', left: 0, bottom: 0, zIndex: 2, width: `${width}px`, background: 'var(--card)' }}>
          <div style={{ height: 28, display: 'flex', alignItems: 'center', paddingLeft: padding.left, borderTop: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 10 }}>
            {labelIndexes.map((index) => {
              const candle = candles[index]
              const centerX = padding.left + index * xStep + xStep / 2
              return (
                <span key={`${candle[0]}-label`} style={{ position: 'absolute', left: `${centerX}px`, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>
                  {new Date(candle[0]).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
              )
            })}
          </div>

        </div>
      </div>
      </div>
      <div style={{ position: 'relative', width: axisWidth, height: height, boxSizing: 'border-box', background: 'var(--card)', borderLeft: '1px solid var(--border)', zIndex: 2, pointerEvents: 'none' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const value = maximum - range * fraction
          const lineY = padding.top + chartHeight * fraction
          return <div key={fraction} style={{ position: 'absolute', top: `${lineY - 6}px`, right: 8, fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{value.toFixed(2)}</div>
        })}
        {tick?.ltp != null && livePriceY !== undefined && (
          <div style={{
            position: 'absolute',
            top: `${Math.max(padding.top, Math.min(height - padding.bottom - 20, livePriceY - 10))}px`,
            left: 4,
            right: 4,
            padding: '3px 4px',
            borderRadius: 3,
            background: livePriceColor,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: '16px',
            textAlign: 'center',
            whiteSpace: 'nowrap',
          }}>
            {tick.ltp.toFixed(2)}
          </div>
        )}
      </div>
    </div>
  )
}

function PriceActionAgent({ candles, interval, now, instrument }: { candles: AngelOneCandle[]; interval: ChartInterval; now: number; instrument: string }) {
  const analysis: PriceActionAnalysis = analyzePriceAction(candles, interval, now)
  const [aiAnalysis, setAiAnalysis] = useState<AiPriceAction | null>(null)
  const [aiError, setAiError] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const requestController = useRef<AbortController | null>(null)
  const requestAiRef = useRef<() => Promise<void>>(async () => {})
  requestAiRef.current = async () => {
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    setAiLoading(true)
    setAiError('')
    try {
      const result = await getAiPriceAction(instrument, interval, candles, analysis, controller.signal)
      setAiAnalysis(result)
      setAiError('')
    } catch (error) {
      if (!controller.signal.aborted) {
        setAiError(error instanceof Error ? error.message : 'AI analysis failed.')
      }
    } finally {
      if (!controller.signal.aborted) setAiLoading(false)
    }
  }

  useEffect(() => {
    if (analysis.latestCandleTime) void requestAiRef.current()
    return () => requestController.current?.abort()
  }, [instrument, interval, analysis.latestCandleTime])

  const color = analysis.side === 'CALL' ? '#15803D' : analysis.side === 'PUT' ? '#B91C1C' : '#92400E'
  const background = analysis.side === 'CALL' ? '#DCFCE7' : analysis.side === 'PUT' ? '#FEE2E2' : '#FEF3C7'
  const formatPrice = (value?: number) => value === undefined ? '—' : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const details = [
    ['Structure', analysis.structure],
    ['Location', analysis.location],
    ['Last closed candle', analysis.candleBehavior],
    ['Setup', analysis.setup],
  ]

  return (
    <section aria-label="Candle price-action agent" style={{ marginTop: 14, padding: 14, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div>
          <strong style={{ fontSize: 15 }}>Candle Price-Action Agent</strong>
          <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>OHLC-only · {intervalLabel(interval)} · {analysis.analyzedCandles} completed candles</div>
        </div>
        <span style={{ padding: '5px 10px', borderRadius: 999, color, background, fontSize: 12, fontWeight: 700 }}>
          {analysis.side === 'WAIT' ? 'WAIT — NO TRADE' : analysis.side === 'CALL' ? 'BULLISH — CALL SETUP' : 'BEARISH — PUT SETUP'}
        </span>
      </div>
      <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--card)', fontSize: 12, lineHeight: 1.7 }}>
        <strong>Early outlook: {analysis.earlyStage} {analysis.earlyBias}</strong>
        <div>Bullish score: {analysis.bullishScore}/100 · Bearish score: {analysis.bearishScore}/100 <span style={{ color: 'var(--text-secondary)' }}>(heuristic evidence score, not probability)</span></div>
        {(analysis.bullishTrigger !== undefined || analysis.bearishTrigger !== undefined) && (
          <div style={{ color: 'var(--text-secondary)' }}>
            {analysis.bullishTrigger !== undefined && <>Upside trigger: {formatPrice(analysis.bullishTrigger)} · invalidation: {formatPrice(analysis.bullishInvalidation)}{analysis.bearishTrigger !== undefined ? ' | ' : ''}</>}
            {analysis.bearishTrigger !== undefined && <>Downside trigger: {formatPrice(analysis.bearishTrigger)} · invalidation: {formatPrice(analysis.bearishInvalidation)}</>}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px 14px', marginBottom: 10 }}>
        {details.map(([label, value]) => (
          <div key={label} style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{label}: </span><strong>{value}</strong>
          </div>
        ))}
      </div>
      {analysis.side !== 'WAIT' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '10px 12px', borderRadius: 8, background, color, fontSize: 13, fontWeight: 600 }}>
          <span>Index entry: {formatPrice(analysis.entry)}</span>
          <span>Target: {formatPrice(analysis.target)}</span>
          <span>Stop loss: {formatPrice(analysis.stopLoss)}</span>
          <span>Reward:risk: {analysis.riskReward?.toFixed(2)}:1</span>
        </div>
      )}
      <p style={{ marginTop: 9, color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>{analysis.reason}</p>
      {analysis.warnings.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>
          {analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--card)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Gemini AI second opinion</strong>
          <button type="button" onClick={() => void requestAiRef.current()} disabled={aiLoading || !analysis.latestCandleTime}>
            {aiLoading ? 'Analyzing…' : aiAnalysis ? 'Re-analyze' : 'Analyze with Gemini AI'}
          </button>
        </div>
        {aiLoading && !aiAnalysis && <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>Requesting a second opinion from Gemini…</p>}
        {aiError && <p role="alert" style={{ margin: '8px 0 0', color: '#B91C1C', fontSize: 12 }}>{aiError}</p>}
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
        <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11 }}>Experimental AI commentary only. Candle data is sent to Google Gemini. It does not set trade levels or override the rule-based decision.</div>
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
  const [instrumentQuotes, setInstrumentQuotes] = useState<Record<string, { ltp?: string; open?: string; high?: string; low?: string; close?: string }>>({})
  const [instrumentError, setInstrumentError] = useState('')
  const [instrumentLoading, setInstrumentLoading] = useState(false)
  const [historicalMode, setHistoricalMode] = useState<'candles' | 'oi'>('candles')
  const [historicalForm, setHistoricalForm] = useState({ exchange: 'NSE', symboltoken: '99926000', interval: 'ONE_DAY', fromdate: '', todate: '' })
  const [historicalData, setHistoricalData] = useState<Array<unknown>>([])
  const [historicalError, setHistoricalError] = useState('')
  const [historicalLoading, setHistoricalLoading] = useState(false)
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
  const [heartbeat, setHeartbeat] = useState(Date.now())
  const chartInitialised = useRef(false)

  useEffect(() => {
    fetchAngelProfile()
    fetchInstrumentQuotes()
    if (!chartInitialised.current) {
      chartInitialised.current = true
      fetchChartCandles('FIVE_MINUTE')
    }
    const socket = connectAngelOneStream((tick) => setStreamTicks((current) => ({ ...current, [tick.token]: tick })), setStreamStatus)
    if (socket) setStreamSocket(socket)
    const orderSocket = connectAngelOneOrderStream((update) => setOrderUpdates((current) => [update, ...current].slice(0, 20)), setOrderStatus)
    return () => {
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
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault()
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
      const missing = trackedInstruments.filter((instrument) => !cachedCandles.get(instrument.name))
      if (!missing.length) {
        setChartError('')
        return
      }

      const token = localStorage.getItem('angelone_jwt_token')
      if (!token) {
        setChartError(`Showing saved chart data. Log in to load ${missing.map((item) => item.name).join(', ')} for this timeframe.`)
        return
      }

      const to = new Date()
      const from = new Date(to)
      from.setDate(from.getDate() - chartHistoryWindowDays(interval))
      const errors: string[] = []
      for (const [index, instrument] of missing.entries()) {
        if (index > 0) await wait(2500)
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
            setChartCandles((current) => ({ ...current, [instrument.name]: candles }))
            if (!candles.length) errors.push(`${instrument.name}: no candles returned.`)
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
    const now = Date.now()
    const activeIntervalCandles: Record<string, AngelOneCandle[]> = {}
    for (const instrument of trackedInstruments) {
      const tick = tickByToken[instrument.token]
      if (!tick?.ltp) continue
      for (const interval of chartIntervals) {
        try {
          const savedCandles = readChartCache(instrument.token, interval)
          if (!savedCandles?.length) continue
          const updatedCandles = addInProgressCandle(savedCandles, tick, interval, now)
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
      const quotes = await Promise.all(trackedInstruments.map(async (tracked) => {
        const instrument = master.find((item) => item.token === tracked.token)
          || { token: tracked.token, symbol: tracked.symbol, exch_seg: tracked.exchange === 'BSE' ? 'bse_cm' : 'nse_cm' }
        const result = await getAngelOneLtp(token, instrument)
        const quote = Array.isArray(result.data) ? result.data[0] : undefined
        return [tracked.name, quote || {}] as const
      }))
      setInstrumentQuotes(Object.fromEntries(quotes))
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
    <div style={{ minHeight: '100vh', background: 'var(--bg)', paddingBottom: 40 }}>
      <div style={{ background: 'linear-gradient(135deg,#6C63FF,#FF6584)', padding: '32px 0 28px', marginBottom: 24 }}>
        <div className="container">
          <h1 style={{ color: '#fff', fontSize: 28, fontWeight: 700, marginBottom: 6 }}>Traders Prediction</h1>
          <p style={{ color: 'rgba(255,255,255,0.9)', fontSize: 14, maxWidth: 700, lineHeight: 1.7 }}>
            Live Nifty 50, Sensex, and Bank Nifty prices from Angel One SmartAPI.
          </p>
        </div>
      </div>

      <div className="container" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button type="button" onClick={fetchInstrumentQuotes} disabled={instrumentLoading}>
            {instrumentLoading ? 'Refreshing…' : 'Refresh Live Data'}
          </button>
        </div>
        <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
          {profileError && (
            <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{profileError}</div>
          )}
          {rmsError && (
            <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{rmsError}</div>
          )}
          {gttError && <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{gttError}</div>}
          {gttMessage && <div style={{ padding: 16, borderRadius: 18, background: '#D1FAE5', color: '#065F46' }}>{gttMessage}</div>}
          {instrumentError && <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{instrumentError}</div>}
          {historicalError && <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{historicalError}</div>}
          <div style={{ padding: 16, borderRadius: 18, background: streamStatus === 'Connected' ? '#D1FAE5' : '#FEF3C7', color: '#92400E' }}>WebSocket stream: <strong>{streamStatus}</strong></div>
          <div style={{ padding: 16, borderRadius: 18, background: orderStatus === 'Connected' ? '#D1FAE5' : '#FEF3C7', color: '#92400E' }}>Order updates: <strong>{orderStatus}</strong></div>
        </div>
      </div>

      <div className="container" style={{ paddingBottom: 40 }}>
        <div className="card" style={{ padding: 24, marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Angel One Instruments</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '8px 0 16px' }}>
            <h2 style={{ margin: 0 }}>Nifty, Sensex & Bank Nifty</h2>
            <button type="button" onClick={fetchInstrumentQuotes} disabled={instrumentLoading}>{instrumentLoading ? 'Refreshing…' : 'Refresh'}</button>
          </div>
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>WebSocket Order Status</div>
            <h2 style={{ margin: '8px 0 16px' }}>Recent order updates</h2>
            {orderUpdates.length === 0 ? <div style={{ color: 'var(--text-secondary)' }}>Waiting for order updates…</div> : (
              <div style={{ display: 'grid', gap: 10 }}>
                {orderUpdates.map((update, index) => (
                  <div key={`${update.orderData?.orderid || 'update'}-${index}`} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                    <strong>{update['order-status'] || update['status-code'] || 'Update'}</strong>
                    <span style={{ marginLeft: 12 }}>{String(update.orderData?.tradingsymbol || '')} {String(update.orderData?.transactiontype || '')}</span>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{String(update.orderData?.orderid || '')} {String(update.orderData?.text || update['error-message'] || '')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>WebSocket Streaming 2.0</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '8px 0 16px', flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>Live index stream</h2>
              <span style={{ color: 'var(--text-secondary)' }}>Heartbeat every 30 seconds · Auto-subscribed to LTP</span>
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <button type="button" onClick={() => sendStreamSubscription(1)} disabled={streamStatus !== 'Connected'}>Subscribe</button>
              <button type="button" onClick={() => sendStreamSubscription(0)} disabled={streamStatus !== 'Connected'}>Unsubscribe</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
              {trackedInstruments.map((item) => {
                const tick = streamTicks[item.token]
                return <div key={item.name} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: 14 }}>
                  <strong>{item.name}</strong>
                  <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{tick?.ltp != null ? tick.ltp.toFixed(2) : 'Waiting…'}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{tick ? new Date(tick.timestamp).toLocaleTimeString() : 'Subscribe to receive ticks'}</div>
                </div>
              })}
            </div>
          </div>
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Angel One Historical API</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '8px 0 16px', flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ margin: 0 }}>Live index candle charts</h2>
                <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 5 }}>Charts load from this browser&apos;s saved history; Angel One history is requested only when a timeframe has no local data.</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => fetchChartCandles('FIVE_MINUTE')} disabled={chartLoading || chartInterval === 'FIVE_MINUTE'}>5 minutes</button>
                <button type="button" onClick={() => fetchChartCandles('FIFTEEN_MINUTE')} disabled={chartLoading || chartInterval === 'FIFTEEN_MINUTE'}>15 minutes</button>
                <button type="button" onClick={() => fetchChartCandles('ONE_HOUR')} disabled={chartLoading || chartInterval === 'ONE_HOUR'}>1 hour</button>
              </div>
            </div>
            {chartError && <div style={{ padding: 12, borderRadius: 12, background: '#FECACA', color: '#991B1B', marginBottom: 14 }}>{chartError}</div>}
            {chartCacheError && <div style={{ padding: 12, borderRadius: 12, background: '#FEF3C7', color: '#92400E', marginBottom: 14 }}>{chartCacheError}</div>}
            {chartLoading && <div style={{ color: 'var(--text-secondary)', marginBottom: 14 }}>Loading {intervalLabel(chartInterval)} candles…</div>}
            <div style={{ display: 'grid', gap: 16 }}>
              {trackedInstruments.map((instrument) => (
                <div key={instrument.name} style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                    <strong>{instrument.name}</strong>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                      {chartCandles[instrument.name]?.length || 0} candles · {streamTicks[instrument.token] ? 'Live' : 'Waiting for live tick'}
                      {chartCandles[instrument.name]?.length ? ' · Saved locally' : ''}
                    </span>
                  </div>
                  {streamTicks[instrument.token] && (() => {
                    const tick = streamTicks[instrument.token]
                    const currentTimestamp = liveTickTimestamp(tick, heartbeat)
                    const formationTime = candleBucket(currentTimestamp, chartInterval)
                    const nextFormationTime = formationTime + intervalMilliseconds(chartInterval)
                    return (
                      <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--bg)', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>
                        <strong style={{ color: 'var(--text-primary)' }}>Candle formation heartbeat:</strong>{' '}
                        {new Date(formationTime).toLocaleString()} · Live {tick.ltp?.toFixed(2) || '–'} · O {tick.open?.toFixed(2) || '–'} H {tick.high?.toFixed(2) || '–'} L {tick.low?.toFixed(2) || '–'} · Next candle in {formatCountdown(nextFormationTime - heartbeat)} · Updated {new Date(currentTimestamp).toLocaleTimeString()}
                      </div>
                    )
                  })()}
                  <CandleChart
                    name={instrument.name}
                    interval={chartInterval}
                    tick={streamTicks[instrument.token]}
                    candles={addInProgressCandle(
                      chartCandles[instrument.name] || [],
                      streamTicks[instrument.token],
                      chartInterval,
                      heartbeat,
                    )}
                  />
                  <PriceActionAgent
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
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Historical API</div>
            <h2 style={{ margin: '8px 0 16px' }}>Historical {historicalMode === 'candles' ? 'Candles' : 'Open Interest'}</h2>
            <form onSubmit={fetchHistoricalData} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
            {trackedInstruments.map((item) => {
              const quote = instrumentQuotes[item.name]
              return <div key={item.name} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: 14 }}>
                <strong>{item.name}</strong>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{quote?.ltp || 'N/A'}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Open {quote?.open || '–'} · High {quote?.high || '–'} · Low {quote?.low || '–'}</div>
              </div>
            })}
          </div>
        </div>
        {profileLoading && (
          <div className="card" style={{ padding: 20, marginBottom: 18 }}>Loading Angel One profile…</div>
        )}
        {angelProfile && (
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Angel One Profile</div>
                <h2 style={{ margin: '8px 0 4px' }}>{angelProfile.name || 'Investor'}</h2>
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
        )}
        {angelRms && (
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Risk Management & Funds</div>
            <h2 style={{ margin: '8px 0 16px' }}>RMS Limits</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
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
          </div>
        )}
        <div className="card" style={{ padding: 24, marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Good Till Triggered</div>
          <h2 style={{ margin: '8px 0 16px' }}>GTT Rule Management</h2>
          <form onSubmit={submitGtt} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 20 }}>
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
      </div>
    </div>
  )
}
