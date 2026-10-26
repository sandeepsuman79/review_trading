import CandleVolume from './CandleVolume'
import { useAtmVwap } from '../hooks/useAtmVwap'
import IndexPriceScale, { type ScaleBadge, type ScaleGeometry } from './IndexPriceScale'
import { indexPriceDomain, indexPriceLevels, type ScaleView } from '../analysis/indexPriceScale'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import ReactApexChart from 'react-apexcharts'
import type { ApexOptions } from 'apexcharts'
import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import type { IndiaVixSnapshot } from '../api/marketContext'
import { calculateMovingAverageSeries } from '../analysis/movingAverages'
import { normalizeCandles } from '../analysis/candleData'
import { buildSupertrendSegments } from '../analysis/supertrendChart'
import { calculateTechnicalIndicatorSeries } from '../analysis/technicalIndicators'
import { buildSessionVwapSeries, calculateSessionVwap } from '../analysis/vwap'
import ChartIndicators, { type ChartIndicator, type ChartIndicatorVisibility, type ChartTradeLevels } from './ChartIndicators'

const ApexPlot = memo(ReactApexChart)

type Range = { min: number; max: number }
export type CandleChartProps = {
  chartControls?: ReactNode
  onViewChange?: (view: ScaleView) => void
  candles: AngelOneCandle[]
  name: string
  intervalLabel: string
  tick?: AngelOneStreamTick
  quotePrice?: number
  historyLabel?: string
  priceStatusLabel?: string
  isLive: boolean
  savedCandleCount: number
  marketHeartbeat: string
  spotIndex?: boolean
  showIndexContext?: boolean
  showTradeContext?: boolean
  optionExpiry?: string
  trade?: ChartTradeLevels
  levels?: { support?: number; resistance?: number }
  indiaVix?: IndiaVixSnapshot
  indiaVixLoading?: boolean
  now: number
}

// ApexCharts expands its candle mask into the axis margins. Keep every series
// inside the actual grid, including when price panning moves values off screen.
function clipSeriesToGrid(chart: unknown) {
  if (!chart || typeof chart !== 'object' || !('el' in chart) || !(chart.el instanceof HTMLElement)) return
  const grid = chart.el.querySelector<SVGGraphicsElement>('.apexcharts-grid')
  const mask = chart.el.querySelector<SVGClipPathElement>('clipPath[id^="gridRectMask"]')
  if (!grid || !mask) return
  const bounds = grid.getBBox()
  for (const rect of chart.el.querySelectorAll('clipPath[id^="gridRect"] rect')) {
    rect.setAttribute('x', String(bounds.x))
    rect.setAttribute('y', String(bounds.y))
    rect.setAttribute('width', String(bounds.width))
    rect.setAttribute('height', String(bounds.height))
  }
  for (const series of chart.el.querySelectorAll('.apexcharts-plot-series')) {
    series.setAttribute('clip-path', `url(#${mask.id})`)
  }
  const plotBounds = grid.getBoundingClientRect()
  // Apex shifts annotations by candle padding. Keep every price badge on the scale at every zoom.
  for (const label of chart.el.querySelectorAll<SVGGraphicsElement>('text.live-index-price, text[class*="horizontal-price-"], text[class*="trade-level-"], text[class*="structure-level-"]')) {
    const id = [...label.classList].find(value => value === 'live-index-price' || value.startsWith('horizontal-price-') || value.startsWith('trade-level-') || value.startsWith('structure-level-'))
    const background = chart.el.querySelector<SVGRectElement>(`rect.${id}`)
    if (!background) continue
    const scale = label.getScreenCTM()?.a || 1
    const labelShift = (plotBounds.right + 4 - label.getBoundingClientRect().left) / scale
    label.setAttribute('x', String(Number(label.getAttribute('x')) + labelShift))
    const shift = (label.getBoundingClientRect().left - 2 - background.getBoundingClientRect().left) / scale
    background.setAttribute('x', String(Number(background.getAttribute('x')) + shift))
    if (id?.startsWith('horizontal-price-')) {
      background.setAttribute('role', 'button')
      background.setAttribute('tabindex', '0')
      background.setAttribute('aria-label', `Remove horizontal line at ${label.textContent}`)
      background.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          background.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
      }
    }
  }
  for (const line of chart.el.querySelectorAll<SVGLineElement>('line.live-index-price, line[class*="horizontal-price-"], line[class*="trade-level-"], line[class*="structure-level-"]')) {
    const scale = line.getScreenCTM()?.a || 1
    const lineBounds = line.getBoundingClientRect()
    line.setAttribute('x1', String(Number(line.getAttribute('x1')) + (plotBounds.left - lineBounds.left) / scale))
    line.setAttribute('x2', String(Number(line.getAttribute('x2')) + (plotBounds.right - lineBounds.right) / scale))
  }
  // Keep edge time labels readable without reserving a wide left/right gutter.
  for (const label of chart.el.querySelectorAll<SVGGraphicsElement>('.apexcharts-xaxis-label')) {
    const box = label.getBoundingClientRect()
    const shift = box.left < plotBounds.left + 2
      ? plotBounds.left + 2 - box.left
      : box.right > plotBounds.right - 2 ? plotBounds.right - 2 - box.right : 0
    if (box.width && shift) {
      const scale = label.getScreenCTM()?.a || 1
      label.setAttribute('transform', `${label.getAttribute('transform') || ''} translate(${shift / scale}, 0)`)
    }
  }
}

const price = (value: number) => value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const candleDate = (value: string) => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

function measureScale(values: number[], format = price, fallback = 56) {
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!context) return fallback
  context.font = '600 10px Helvetica, Arial, sans-serif'
  return Math.ceil(values.reduce((width, value) => Number.isFinite(value) ? Math.max(width, context.measureText(format(value)).width) : width, 0)) || fallback
}

const defaultIndicators: ChartIndicatorVisibility = { supertrend: true, vwap: true, ema20: true, ema50: true, sma20: false }
const indicatorPreferenceKey = 'traders_chart_indicators_v1'

function readIndicatorPreferences(): ChartIndicatorVisibility {
  try {
    const saved = JSON.parse(localStorage.getItem(indicatorPreferenceKey) || '{}') as Partial<ChartIndicatorVisibility> | null
    return Object.fromEntries(Object.entries(defaultIndicators).map(([key, value]) => [key, typeof saved?.[key as ChartIndicator] === 'boolean' ? saved[key as ChartIndicator] : value])) as ChartIndicatorVisibility
  } catch { return defaultIndicators }
}

export default function CandleChart({ candles: inputCandles, name, intervalLabel, tick, quotePrice, historyLabel = 'Saved locally', priceStatusLabel, isLive, savedCandleCount, marketHeartbeat, spotIndex = false, showIndexContext = true, showTradeContext = showIndexContext, trade, levels, indiaVix, indiaVixLoading, now, chartControls, onViewChange }: CandleChartProps) {
  const latestPrice = tick?.ltp ?? quotePrice
  const [scaleGeometry, setScaleGeometry] = useState<ScaleGeometry>()
  const candles = useMemo(() => normalizeCandles(inputCandles), [inputCandles])
  const [indicatorVisibility, setIndicatorVisibility] = useState(readIndicatorPreferences)
  // A null range follows the newest candles. A chosen historical range stays put on live ticks.
  const [horizontalLines, setHorizontalLines] = useState<Array<{ id: number; price: number }>>([])
  const nextLineId = useRef(1)
  const [range, setRange] = useState<Range | null>(null)
  const [marker, setMarker] = useState<{ x: number; y: number; left: number; top: number; width: number; height: number; price: number; time: string } | null>(null)
  const [selectedTime, setSelectedTime] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia('(max-width: 640px)').matches)
  const [visibleCount, setVisibleCount] = useState<number | null>(null)
  const [priceShift, setPriceShift] = useState(0)
  const [scrollWidth, setScrollWidth] = useState(() => typeof window === 'undefined' ? 1 : window.innerWidth)
  const compact = scrollWidth <= 640
  // Give each candle about 10px on phones; keep a chosen zoom when resizing or receiving ticks.
  const priceScaleReserve = Math.max(spotIndex ? 70 : 56, trade ? measureScale([trade.entry, trade.target, trade.stopLoss], value => `ENTRY ${price(value)}`) + 8 : 56, levels ? measureScale([levels.support, levels.resistance].filter((value): value is number => value !== undefined), value => `R ${price(value)}`) + 4 : 0)
  const defaultVisibleCount = compact ? Math.max(18, Math.floor((scrollWidth - priceScaleReserve - 20) / 10)) : 60
  const horizontalScrollRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<HTMLElement>(null)
  const verticalScrollRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const syncChartScale = useCallback((chart: unknown) => {
    clipSeriesToGrid(chart)
    const plot = plotRef.current, grid = plot?.querySelector('.apexcharts-grid')
    if (!plot || !grid) return
    const box = plot.getBoundingClientRect(), bounds = grid.getBoundingClientRect()
    const next = { left: bounds.right - box.left + 2, top: bounds.top - box.top, width: Math.max(1, box.right - bounds.right - 2), height: bounds.height }
    setScaleGeometry(current => current && Object.keys(next).every(key => Math.abs(current[key as keyof ScaleGeometry] - next[key as keyof ScaleGeometry]) < .5) ? current : next)
  }, [])
  const dragRef = useRef<{ x: number; y: number; min: number; max: number; shift: number; width: number; height: number } | null>(null)
  const wheelDelta = useRef({ x: 0, y: 0, zoom: 1 })
  const interactionFrame = useRef<number>()
  const pendingInteraction = useRef<(() => void) | null>(null)
  const scheduleInteraction = useCallback((update: () => void) => {
    pendingInteraction.current = update
    if (interactionFrame.current !== undefined) return
    interactionFrame.current = requestAnimationFrame(() => {
      interactionFrame.current = undefined
      const apply = pendingInteraction.current
      pendingInteraction.current = null
      apply?.()
    })
  }, [])
  const cancelInteraction = useCallback(() => {
    if (interactionFrame.current !== undefined) cancelAnimationFrame(interactionFrame.current)
    interactionFrame.current = undefined
    pendingInteraction.current = null
    wheelDelta.current = { x: 0, y: 0, zoom: 1 }
  }, [])
  useEffect(() => cancelInteraction, [cancelInteraction])
  const hasCandles = candles.length > 0
  const latest = candles.length - 1
  // Leave room beyond the final candle so its body and live price never touch the clipping edge.
  const rightEdge = latest + 2.5
  const totalSpan = Math.max(1, candles.length + 2)
  const min = range?.min ?? Math.max(-0.5, rightEdge - (visibleCount ?? defaultVisibleCount))
  const max = range?.max ?? rightEdge
  const span = max - min

  useEffect(() => {
    try { localStorage.setItem(indicatorPreferenceKey, JSON.stringify(indicatorVisibility)) } catch { /* Drawing preferences do not affect saved candles or trades. */ }
  }, [indicatorVisibility])

  useEffect(() => {
    const dismissInspection = (event: Event) => {
      if (event.target instanceof Node && !chartRef.current?.contains(event.target)) {
        setMarker(null)
        setSelectedTime(null)
        dragRef.current = null
      }
    }
    document.addEventListener('pointerdown', dismissInspection, true)
    return () => document.removeEventListener('pointerdown', dismissInspection, true)
  }, [])

  const panTo = useCallback((start: number, width: number) => {
    setMarker(null)
    const boundedWidth = Math.max(1, Math.min(totalSpan, width))
    const boundedStart = Math.max(-0.5, Math.min(rightEdge - boundedWidth, start))
    setVisibleCount(boundedWidth)
    setRange(boundedStart + boundedWidth >= rightEdge - 0.01 ? null : { min: boundedStart, max: boundedStart + boundedWidth })
  }, [rightEdge, totalSpan])

  const zoom = useCallback((factor: number) => {
    const width = Math.min(totalSpan, Math.max(Math.min(5, totalSpan), span * factor))
    const atLatest = max >= rightEdge - 0.01
    panTo(atLatest ? rightEdge - width : (min + max - width) / 2, width)
  }, [min, max, span, totalSpan, rightEdge, panTo])

  useLayoutEffect(() => {
    const scroll = horizontalScrollRef.current
    if (!scroll) return
    const observer = new ResizeObserver(() => setScrollWidth(scroll.clientWidth || 1))
    observer.observe(scroll)
    setScrollWidth(scroll.clientWidth || 1)
    return () => observer.disconnect()
  }, [hasCandles])

  useLayoutEffect(() => {
    const scroll = horizontalScrollRef.current
    if (scroll) scroll.scrollLeft = ((min + 0.5) / Math.max(1, totalSpan - span)) * (scroll.scrollWidth - scroll.clientWidth)
  }, [min, span, totalSpan, scrollWidth])

  useLayoutEffect(() => {
    const scroll = verticalScrollRef.current
    if (scroll) scroll.scrollTop = (2 - priceShift) * scroll.clientHeight
  }, [priceShift, hasCandles])

  useEffect(() => {
    const plot = plotRef.current
    if (!plot) return
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('.chart-scale-ladder')) return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) wheelDelta.current.zoom *= event.deltaY < 0 ? 1 / 1.2 : 1.2
      else {
        wheelDelta.current.x += event.shiftKey ? event.deltaY : event.deltaX
        if (!event.shiftKey) wheelDelta.current.y += event.deltaY
      }
      scheduleInteraction(() => {
        const motion = wheelDelta.current
        wheelDelta.current = { x: 0, y: 0, zoom: 1 }
        if (motion.zoom !== 1) { zoom(motion.zoom); return }
        if (motion.x) panTo(min + motion.x / Math.max(1, plot.clientWidth) * span, span)
        if (motion.y) { setMarker(null); setPriceShift(current => Math.max(-2, Math.min(2, current - motion.y / 360))) }
      })
    }
    plot.addEventListener('wheel', wheel, { passive: false })
    return () => plot.removeEventListener('wheel', wheel)
  }, [min, span, zoom, panTo, hasCandles, scheduleInteraction])
  const inspectedIndex = selectedTime ? candles.findIndex(candle => candle[0] === selectedTime) : -1
  const selectedIndex = inspectedIndex >= 0 ? inspectedIndex : latest
  const selected = candles[selectedIndex]

  const averages = useMemo(() => calculateMovingAverageSeries(candles.map(candle => candle[4])), [candles])
  const indicators = useMemo(() => calculateTechnicalIndicatorSeries(candles.map(candle => candle[2]), candles.map(candle => candle[3]), candles.map(candle => candle[4])), [candles])
  const atm = useAtmVwap(name, latestPrice ?? candles[candles.length - 1]?.[4], now, spotIndex)
  const vwap = useMemo(() => calculateSessionVwap(candles), [candles])
  const hasVwap = vwap.some(value => value !== undefined)

  // Calculate indicators with the full history, but draw only the viewport and two edge bars.
  const firstDrawn = Math.max(0, Math.floor(min) - 2)
  const lastDrawn = Math.min(candles.length, Math.ceil(max) + 3)
  const supertrendSegments = useMemo(() => buildSupertrendSegments(indicators), [indicators])
  const vwapSessions = useMemo(() => buildSessionVwapSeries(candles, vwap), [candles, vwap])
  const series = useMemo(() => {
    const visible = candles.slice(firstDrawn, lastDrawn)
    const windowPoints = <T extends { x: number }>(points: T[]) => points.filter(point => point.x >= firstDrawn && point.x < lastDrawn)
    return [
      { name: 'OHLC', type: 'candlestick', data: visible.map((candle, index) => ({ x: firstDrawn + index, y: candle.slice(1, 5) })) },
      ...(indicatorVisibility.sma20 ? [{ name: 'SMA(20)', type: 'line', data: visible.map((_, index) => ({ x: firstDrawn + index, y: averages[firstDrawn + index].sma20 ?? null })) }] : []),
      ...(indicatorVisibility.ema20 ? [{ name: 'EMA(20)', type: 'line', data: visible.map((_, index) => ({ x: firstDrawn + index, y: averages[firstDrawn + index].ema20 ?? null })) }] : []),
      ...(indicatorVisibility.ema50 ? [{ name: 'EMA(50)', type: 'line', data: visible.map((_, index) => ({ x: firstDrawn + index, y: averages[firstDrawn + index].ema50 ?? null })) }] : []),
      ...(indicatorVisibility.vwap ? vwapSessions.map(line => ({ ...line, data: windowPoints(line.data) })).filter(line => line.data.length > 0) : []),
      ...(indicatorVisibility.supertrend ? supertrendSegments.map(segment => ({ name: segment.direction === 'UP' ? 'Supertrend up' : 'Supertrend down', type: 'line', data: windowPoints(segment.data) })).filter(line => line.data.length > 0) : []),
    ]
  }, [candles, averages, supertrendSegments, vwapSessions, indicatorVisibility, firstDrawn, lastDrawn])

  const options = useMemo<ApexOptions>(() => {
    const tooltip = ({ seriesIndex, dataPointIndex }: { seriesIndex: number; dataPointIndex: number }) => {
      const index = series[seriesIndex]?.data[dataPointIndex]?.x
      const candle = index === undefined ? undefined : candles[index]
      const element = document.createElement('div')
      element.className = 'candle-chart-tooltip'
      if (candle) element.textContent = `${candleDate(candle[0])} IST\nOpen: ${price(candle[1])}\nHigh: ${price(candle[2])}\nLow: ${price(candle[3])}\nClose: ${price(candle[4])}\n${spotIndex ? 'Spot volume: unavailable; see ATM options below' : `Volume: ${candle[5].toLocaleString('en-IN')}`}`
      return element
    }
    const visible = candles.slice(Math.max(0, Math.ceil(min)), Math.min(candles.length, Math.floor(max) + 1))
    const values = visible.flatMap((candle) => [candle[2], candle[3]])
    series.slice(1).forEach((line) => line.data.forEach((point) => {
      if (point.x >= min && point.x <= max && typeof point.y === 'number') values.push(point.y)
    }))
    if (max >= candles.length - 1) {
      if (latestPrice !== undefined) values.push(latestPrice)
      if (trade) values.push(trade.entry, trade.stopLoss, trade.target)
    }
    const low = values.reduce((result, value) => Math.min(result, value), Infinity)
    const high = values.reduce((result, value) => Math.max(result, value), -Infinity)
    const padding = Math.max((high - low) * 0.04, Math.abs(high) * 0.0002, 1)
    const shift = (high - low + padding * 2) * priceShift
    const domain = spotIndex ? indexPriceDomain(low - padding + shift, high + padding + shift, name) : { min: low - padding + shift, max: high + padding + shift }
    // Reserve only the width of the full prices, including the bold live marker.
    const axisLabelWidth = Math.max(spotIndex ? 70 : 0, measureScale([domain.min, domain.max, latestPrice ?? high, ...horizontalLines.map(line => line.price)]), trade || levels ? priceScaleReserve : 0)
    return {
      chart: {
        type: 'candlestick', background: 'transparent', foreColor: '#6B7280',
        animations: { enabled: false }, parentHeightOffset: 0,
        zoom: { enabled: false }, toolbar: { show: false },
        events: { mounted: syncChartScale, updated: syncChartScale },
      },
      plotOptions: { candlestick: { colors: { upward: '#16A34A', downward: '#DC2626' } } },
      colors: series.map(line => ({ 'OHLC': '#6C63FF', 'SMA(20)': '#64748B', 'EMA(20)': '#0EA5E9', 'EMA(50)': '#F59E0B', 'VWAP': '#A855F7', 'Supertrend up': '#16A34A', 'Supertrend down': '#DC2626' })[line.name] ?? '#64748B'),
      stroke: { width: series.map((_, index) => index === 0 ? 1 : 2), curve: 'straight' },
      markers: { size: 0 }, dataLabels: { enabled: false }, legend: { show: false },
      grid: { borderColor: '#E5E7EB', xaxis: { lines: { show: true } }, yaxis: { lines: { show: !spotIndex } }, padding: { left: compact ? 2 : 16, right: 0, top: compact ? -22 : -16, bottom: 0 } },
      xaxis: {
        type: 'numeric', min, max, tickAmount: compact ? 3 : 4, decimalsInFloat: 0,
        labels: { rotate: 0, hideOverlappingLabels: true, formatter: (value) => {
          const candle = candles[Math.round(Number(value))]
          return candle ? new Date(candle[0]).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : ''
        }, style: { fontSize: '10px' } },
        crosshairs: { show: false, width: 1, position: 'front', stroke: { color: '#94A3B8', width: 1, dashArray: 4 } },
        tooltip: { enabled: false, formatter: (value) => { const candle = candles[Math.max(0, Math.min(candles.length - 1, Math.round(Number(value))))]; return candle ? `${candleDate(candle[0])} IST` : '' } },
      },
      yaxis: {
        opposite: true, min: Number.isFinite(low) ? domain.min : undefined, max: Number.isFinite(high) ? domain.max : undefined,
        labels: { minWidth: axisLabelWidth, maxWidth: trade || levels || spotIndex ? axisLabelWidth + 4 : compact ? 64 : 78, formatter: price, style: { fontSize: '10px' } },
        crosshairs: { show: false, position: 'front', stroke: { color: '#94A3B8', width: 1, dashArray: 4 } }, tooltip: { enabled: false },
      },
      tooltip: { enabled: true, shared: false, intersect: false, custom: tooltip },
      annotations: { yaxis: [
        ...(spotIndex ? indexPriceLevels(domain.min, domain.max, name).map(value => ({ id: `index-step-${value}`, y: value, borderColor: '#E5E7EB', strokeDashArray: 0 })) : []),
        ...([
          { id: 'structure-level-support', value: levels?.support, label: 'S', color: '#15803D' },
          { id: 'structure-level-resistance', value: levels?.resistance, label: 'R', color: '#B91C1C' },
        ].filter((level): level is typeof level & { value: number } => level.value !== undefined && Number.isFinite(level.value)).map(level => ({
          id: level.id, y: level.value, borderColor: level.color, strokeDashArray: 3,
          label: { text: `${level.label} ${price(level.value)}`, position: 'right', textAnchor: 'start', offsetX: 4, offsetY: level.id.endsWith('support') ? 7 : -7, borderColor: level.color,
            style: { background: level.color, color: '#fff', fontSize: '10px', fontWeight: 600, padding: { left: 2, right: 2, top: 2, bottom: 2 } } },
        }))),
        ...(latestPrice !== undefined ? [{
          id: 'live-index-price', y: latestPrice, borderColor: '#6C63FF', strokeDashArray: 4,
          label: {
            text: price(latestPrice), position: 'right', textAnchor: 'start', offsetX: 4, offsetY: 7, borderColor: '#6C63FF',
            style: { background: '#6C63FF', color: '#fff', fontSize: '10px', fontWeight: 600, padding: { left: 2, right: 2, top: 2, bottom: 2 } },
          },
        }] : []),
        ...(trade ? [
          { id: 'trade-level-entry', label: 'ENTRY', value: trade.entry, color: '#64748B', background: '#F1F5F9', textColor: '#334155' },
          { id: 'trade-level-stop', label: trade.trailingStop === trade.stopLoss ? 'SL / TSL' : 'SL', value: trade.stopLoss, color: '#EF4444', background: '#FEE2E2', textColor: '#B91C1C' },
          { id: 'trade-level-target', label: 'REF', value: trade.target, color: '#22C55E', background: '#DCFCE7', textColor: '#166534' },
          ...(trade.trailingStop !== undefined && trade.trailingStop !== trade.stopLoss ? [{ id: 'trade-level-trailing', label: 'TSL', value: trade.trailingStop, color: '#D97706', background: '#FEF3C7', textColor: '#92400E' }] : []),
        ].map(level => ({
          id: level.id, y: level.value, borderColor: level.color, strokeDashArray: 5,
          label: { text: `${level.label} ${price(level.value)}`, position: 'right', textAnchor: 'start', offsetX: 4, offsetY: level.id === 'trade-level-trailing' ? -11 : 7, borderColor: level.color,
            style: { background: level.background, color: level.textColor, fontSize: '10px', fontWeight: 600, padding: { left: 2, right: 2, top: 2, bottom: 2 } } },
        })) : []),
        ...horizontalLines.map(line => ({
          id: `horizontal-price-${line.id}`, y: line.price, borderColor: '#2563EB', strokeDashArray: 0,
          label: {
            text: price(line.price), position: 'right', textAnchor: 'start', offsetX: 4, offsetY: 7, borderColor: '#2563EB',
            style: { background: '#2563EB', color: '#fff', fontSize: '10px', fontWeight: 600, padding: { left: 2, right: 2, top: 2, bottom: 2 } },
            mouseEnter: () => setMarker(null),
            click: (_annotation: unknown, event: MouseEvent) => {
              event.stopPropagation()
              setMarker(null)
              setHorizontalLines(current => current.filter(item => item.id !== line.id))
            },
          },
        })),
      ] },
    }
  }, [candles, min, max, series, latestPrice, priceShift, horizontalLines, compact, trade, levels, priceScaleReserve, name, spotIndex, syncChartScale])

  const axis = options.yaxis as { min?: number; max?: number }
  const scaleMin = axis.min ?? 0, scaleMax = axis.max ?? 0
  const scaleLevels = useMemo(() => indexPriceLevels(scaleMin, scaleMax, name), [scaleMin, scaleMax, name])
  const scaleBadges: ScaleBadge[] = [
    ...(latestPrice !== undefined ? [{ id: 'live', value: latestPrice, text: price(latestPrice), background: '#6C63FF' }] : []),
    ...([{ id: 'support', value: levels?.support, prefix: 'S', background: '#15803D' }, { id: 'resistance', value: levels?.resistance, prefix: 'R', background: '#B91C1C' }].filter((level): level is typeof level & { value: number } => level.value !== undefined).map(level => ({ ...level, text: `${level.prefix} ${price(level.value)}` }))),
    ...(trade ? [{ id: 'entry', value: trade.entry, text: `ENTRY ${price(trade.entry)}`, background: '#F1F5F9', color: '#334155' }, { id: 'stop', value: trade.stopLoss, text: `SL ${price(trade.stopLoss)}`, background: '#FEE2E2', color: '#B91C1C' }, { id: 'target', value: trade.target, text: `REF ${price(trade.target)}`, background: '#DCFCE7', color: '#166534' }] : []),
    ...(trade?.trailingStop !== undefined ? [{ id: 'trailing', value: trade.trailingStop, text: `${trade.trailingStop === trade.stopLoss ? 'SL / TSL' : trade.trailingStop === trade.entry ? 'ENTRY / TSL' : 'TSL'} ${price(trade.trailingStop)}`, background: '#FEF3C7', color: '#92400E' }] : []),
    ...horizontalLines.map(line => ({ id: `line-${line.id}`, value: line.price, text: price(line.price), background: '#2563EB', remove: () => { setMarker(null); setHorizontalLines(current => current.filter(item => item.id !== line.id)) } })),
  ]

  function inspectCandle(event: PointerEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest('.candle-crosshair-price')) return
    const grid = event.currentTarget.querySelector('.apexcharts-grid')
    if (!grid) return
    const bounds = grid.getBoundingClientRect()
    if (!bounds.width || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      if (event.currentTarget === plotRef.current && !(event.clientX > bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom)) setMarker(null)
      return
    }
    const index = Math.max(0, Math.min(latest, Math.round(min + (event.clientX - bounds.left) / bounds.width * (max - min))))
    setSelectedTime(candles[index][0])
    if (event.currentTarget === plotRef.current) {
      const parent = event.currentTarget.getBoundingClientRect()
      const axis = options.yaxis as { min: number; max: number }
      setMarker({ x: event.clientX - parent.left, y: event.clientY - parent.top, left: bounds.left - parent.left, top: bounds.top - parent.top, width: bounds.width, height: bounds.height, price: axis.max - (event.clientY - bounds.top) / bounds.height * (axis.max - axis.min), time: candles[index][0] })
    }
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    cancelInteraction()
    if (event.button !== 0) return
    const bounds = event.currentTarget.querySelector('.apexcharts-grid')?.getBoundingClientRect()
    if (!bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return
    inspectCandle(event)
    dragRef.current = { x: event.clientX, y: event.clientY, min, max, shift: priceShift, width: bounds.width, height: bounds.height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (drag) {
      const x = event.clientX, y = event.clientY
      scheduleInteraction(() => {
        const width = drag.max - drag.min
        panTo(drag.min - (x - drag.x) / drag.width * width, width)
        setPriceShift(Math.max(-2, Math.min(2, drag.shift + (y - drag.y) / drag.height)))
      })
      return
    }
    inspectCandle(event)
  }

  if (!candles.length) return <section ref={chartRef} className="candle-chart" aria-label={`${name} ${intervalLabel} chart`} style={{ padding: 12 }}><div className="candle-chart-title"><strong>{name}</strong><span aria-hidden="true">·</span><strong>{intervalLabel}</strong></div><span className="candle-market-heartbeat">{marketHeartbeat}</span><p style={{ color: 'var(--text-secondary)' }}>No candle data returned.</p>{chartControls}</section>

  return (
    <section ref={chartRef} className={`candle-chart${spotIndex && scaleGeometry ? ' has-strike-scale' : ''}`} aria-label={`${name} ${intervalLabel} chart`}>
      <details className="candle-chart-info" open={infoOpen} onToggle={(event) => setInfoOpen(event.currentTarget.open)}>
        <summary aria-label={`Chart information and controls for ${name}`}>
          <span className="candle-chart-title"><strong>{name}</strong><span aria-hidden="true">·</span><strong>{intervalLabel}</strong></span>
          <svg className="card-disclosure-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </summary>
        <div className="candle-chart-header">
          <div className="candle-chart-identity">
            <span className="candle-market-heartbeat" aria-label={`${name} market heartbeat`}>{marketHeartbeat}</span>
            <span className="candle-chart-history">
              {savedCandleCount} candles · {priceStatusLabel ?? (isLive ? 'Live' : 'Waiting for live tick')}{savedCandleCount ? ` · ${historyLabel}` : ''}
            </span>
          </div>
          <div className="candle-chart-details" role="status" aria-label="Candle OHLC and volume">
            <time dateTime={selected[0]}>{candleDate(selected[0])} IST</time>
            <span>Open <b>{price(selected[1])}</b></span>
            <span>High <b>{price(selected[2])}</b></span>
            <span>Low <b>{price(selected[3])}</b></span>
            <span>Close <b>{price(selected[4])}</b></span>
            {spotIndex ? <span>ATM session volume · CE <b>{atm.data?.ce.volume.toLocaleString('en-IN') ?? '—'}</b> / PE <b>{atm.data?.pe.volume.toLocaleString('en-IN') ?? '—'}</b></span> : <span>Volume <b>{selected[5].toLocaleString('en-IN')}</b></span>}
          </div>
          <div className="candle-chart-zoom" aria-label="Chart zoom controls">
            <button type="button" onClick={() => zoom(1.5)} aria-label="Zoom out">−</button>
            <button type="button" onClick={() => zoom(1 / 1.5)} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => { panTo(-0.5, totalSpan); setPriceShift(0) }}>Fit all</button>
            <button type="button" onClick={() => { setRange(null); setPriceShift(0); setSelectedTime(null); setMarker(null) }}>Latest</button>
          </div>
        </div>
      </details>
      <div className="candle-price-viewport">
        <div ref={plotRef} className="apex-candle-plot" onPointerDown={startDrag} onPointerMove={movePointer} onPointerUp={() => { dragRef.current = null }} onPointerCancel={() => { dragRef.current = null }} onLostPointerCapture={() => { dragRef.current = null }} onPointerLeave={(event) => { if (event.pointerType === 'mouse' && !dragRef.current) { setSelectedTime(null); setMarker(null) } }}>
          <ApexPlot options={options} series={series} type="candlestick" height={360} width="100%" />
          {spotIndex && scaleGeometry && <IndexPriceScale geometry={scaleGeometry} min={scaleMin} max={scaleMax} levels={scaleLevels} name={name} view="INDEX" onView={view => onViewChange?.(view)} badges={scaleBadges} onInteract={() => { setMarker(null); setSelectedTime(null) }} />}
          {marker && <div className="candle-crosshair">
            <div className="candle-crosshair-vertical" aria-hidden="true" style={{ left: marker.x, top: marker.top, height: marker.height }} />
            <div className="candle-crosshair-horizontal" aria-hidden="true" style={{ left: marker.left, top: marker.y, width: marker.width }} />
            <span className="candle-crosshair-price" style={{ top: Math.max(marker.top + 14, Math.min(marker.top + marker.height - 14, marker.y)) }}>
              <button type="button" aria-label={`Draw horizontal line at ${price(marker.price)}`} title={`Draw horizontal line at ${price(marker.price)}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
                event.stopPropagation()
                const value = Math.round(marker.price * 100) / 100
                const id = nextLineId.current++
                setHorizontalLines((current) => current.some((line) => line.price === value) ? current : [...current, { id, price: value }])
                setMarker(null)
              }}>⊕</button>
              {price(marker.price)}
            </span>
            <span className="candle-crosshair-time" style={{ left: Math.max(90, Math.min(marker.left + marker.width - 90, marker.x)), top: marker.top + marker.height }}>{candleDate(marker.time)} IST</span>
          </div>}
        </div>
        <div ref={verticalScrollRef} className="candle-price-scroll" tabIndex={0} role="region" aria-label="Scroll chart price vertically" onScroll={(event) => {
          const scroll = event.currentTarget
          const shift = Math.max(-2, Math.min(2, 2 - scroll.scrollTop / scroll.clientHeight))
          if (Math.abs(shift - priceShift) > 0.01) scheduleInteraction(() => { setMarker(null); setPriceShift(shift) })
        }}><div style={{ height: '500%', width: 1 }} /></div>
      </div>
      {!spotIndex && <CandleVolume candles={candles} min={min} max={max} name={name} />}
      <div ref={horizontalScrollRef} className="candle-time-scroll" tabIndex={0} role="region" aria-label="Scroll chart history horizontally" onScroll={(event) => {
        const scroll = event.currentTarget
        const available = scroll.scrollWidth - scroll.clientWidth
        if (available <= 0) return
        const start = -0.5 + scroll.scrollLeft / available * (totalSpan - span)
        if (Math.abs(start - min) > 0.05) scheduleInteraction(() => panTo(start, span))
      }}><div style={{ width: `${100 * totalSpan / span}%`, height: 1 }} /></div>
      {chartControls}
      <details className="chart-indicator-disclosure" open={spotIndex || undefined}>
        <summary aria-label={showTradeContext ? 'Support, resistance and chart indicators' : 'Chart indicators'}>
          {showTradeContext ? <span className="chart-indicator-summary-levels">
            <span className="agent-text-bullish">Support (S): {levels?.support === undefined ? 'Not established' : price(levels.support)}</span>
            <span className="agent-text-bearish">Resistance (R): {levels?.resistance === undefined ? 'Not established' : price(levels.resistance)}</span>
          </span> : <span>Chart indicators</span>}
          <svg className="card-disclosure-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </summary>
        <ChartIndicators onShowAtm={onViewChange ? () => onViewChange('CE') : undefined} visibility={indicatorVisibility} onToggle={key => { setMarker(null); setIndicatorVisibility(current => ({ ...current, [key]: !current[key] })) }}
          average={averages[selectedIndex] || {}} technical={indicators[selectedIndex] || {}} atmVwap={atm.data} atmVwapError={atm.error} atmIndexPrice={latestPrice ?? candles[latest]?.[4]} vwap={vwap[selectedIndex]} hasVwap={hasVwap} spotIndex={spotIndex} showIndexContext={showIndexContext} showTradeContext={showTradeContext}
          close={selected[4]} trade={trade} indiaVix={indiaVix} indiaVixLoading={indiaVixLoading} now={now} context={`${inspectedIndex >= 0 ? 'Selected candle' : 'Latest candle'} · ${candleDate(selected[0])} IST`} />
      </details>
    </section>
  )
}
