import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import ReactApexChart from 'react-apexcharts'
import type { ApexOptions } from 'apexcharts'
import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import { calculateMovingAverageSeries } from '../analysis/movingAverages'
import { normalizeCandles } from '../analysis/candleData'
import { buildSupertrendSegments } from '../analysis/supertrendChart'
import { calculateTechnicalIndicatorSeries } from '../analysis/technicalIndicators'

type Range = { min: number; max: number }
type Props = {
  candles: AngelOneCandle[]
  name: string
  intervalLabel: string
  tick?: AngelOneStreamTick
  isLive: boolean
  savedCandleCount: number
  marketHeartbeat: string
  spotIndex?: boolean
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
  for (const label of chart.el.querySelectorAll<SVGGraphicsElement>('text.live-index-price, text[class*="horizontal-price-"]')) {
    const id = [...label.classList].find(value => value === 'live-index-price' || value.startsWith('horizontal-price-'))
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
  for (const line of chart.el.querySelectorAll<SVGLineElement>('line.live-index-price, line[class*="horizontal-price-"]')) {
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

export default function CandleChart({ candles: inputCandles, name, intervalLabel, tick, isLive, savedCandleCount, marketHeartbeat, spotIndex = false }: Props) {
  const candles = useMemo(() => normalizeCandles(inputCandles), [inputCandles])
  const volumeUnavailable = spotIndex && !candles.some(candle => candle[5] > 0)
  // A null range follows the newest candles. A chosen historical range stays put on live ticks.
  const [horizontalLines, setHorizontalLines] = useState<Array<{ id: number; price: number }>>([])
  const nextLineId = useRef(1)
  const [range, setRange] = useState<Range | null>(null)
  const [marker, setMarker] = useState<{ x: number; y: number; left: number; top: number; width: number; height: number; price: number; time: string } | null>(null)
  const [selectedTime, setSelectedTime] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia('(max-width: 640px)').matches)
  const [volumeOpen, setVolumeOpen] = useState(true)
  const [visibleCount, setVisibleCount] = useState<number | null>(null)
  const [priceShift, setPriceShift] = useState(0)
  const [scrollWidth, setScrollWidth] = useState(() => typeof window === 'undefined' ? 1 : window.innerWidth)
  const compact = scrollWidth <= 640
  // Give each candle about 10px on phones; keep a chosen zoom when resizing or receiving ticks.
  const defaultVisibleCount = compact ? Math.max(18, Math.floor((scrollWidth - 56 - 20) / 10)) : 60
  const horizontalScrollRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<HTMLElement>(null)
  const verticalScrollRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; min: number; max: number; shift: number; width: number; height: number } | null>(null)
  const hasCandles = candles.length > 0
  const latest = candles.length - 1
  // Leave room beyond the final candle so its body and live price never touch the clipping edge.
  const rightEdge = latest + 2.5
  const totalSpan = Math.max(1, candles.length + 2)
  const min = range?.min ?? Math.max(-0.5, rightEdge - (visibleCount ?? defaultVisibleCount))
  const max = range?.max ?? rightEdge
  const span = max - min

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
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        zoom(event.deltaY < 0 ? 1 / 1.2 : 1.2)
        return
      }
      const horizontal = event.shiftKey ? event.deltaY : event.deltaX
      if (horizontal) panTo(min + horizontal / Math.max(1, plot.clientWidth) * span, span)
      if (!event.shiftKey && event.deltaY) { setMarker(null); setPriceShift((current) => Math.max(-2, Math.min(2, current - event.deltaY / 360))) }
    }
    plot.addEventListener('wheel', wheel, { passive: false })
    return () => plot.removeEventListener('wheel', wheel)
  }, [min, span, zoom, panTo, hasCandles])
  const selected = candles.find((candle) => candle[0] === selectedTime) ?? candles[latest]

  const series = useMemo(() => {
    const closes = candles.map((candle) => candle[4])
    const averages = calculateMovingAverageSeries(closes)
    const indicators = calculateTechnicalIndicatorSeries(candles.map((candle) => candle[2]), candles.map((candle) => candle[3]), closes)
    // Equal spacing keeps overnight and weekend gaps from squeezing the candles.
    return [
      { name: 'OHLC', type: 'candlestick', data: candles.map((candle, x) => ({ x, y: candle.slice(1, 5) })) },
      { name: 'SMA(20)', type: 'line', data: averages.map((point, x) => ({ x, y: point.sma20 ?? null })) },
      { name: 'EMA(50)', type: 'line', data: averages.map((point, x) => ({ x, y: point.ema50 ?? null })) },
      ...buildSupertrendSegments(indicators).map((segment) => ({ name: segment.direction === 'UP' ? 'Supertrend up' : 'Supertrend down', type: 'line', data: segment.data })),
    ]
  }, [candles])
  const volumeSeries = useMemo(() => [{ name: 'Volume', data: candles.map((candle, x) => ({ x, y: candle[5], fillColor: candle[4] >= candle[1] ? '#16A34A' : '#DC2626' })) }], [candles])

  const options = useMemo<ApexOptions>(() => {
    const tooltip = ({ seriesIndex, dataPointIndex }: { seriesIndex: number; dataPointIndex: number }) => {
      const index = series[seriesIndex]?.data[dataPointIndex]?.x
      const candle = index === undefined ? undefined : candles[index]
      const element = document.createElement('div')
      element.className = 'candle-chart-tooltip'
      if (candle) element.textContent = `${candleDate(candle[0])} IST\nOpen: ${price(candle[1])}\nHigh: ${price(candle[2])}\nLow: ${price(candle[3])}\nClose: ${price(candle[4])}\nVolume: ${candle[5].toLocaleString('en-IN')}`
      return element
    }
    const visible = candles.slice(Math.max(0, Math.ceil(min)), Math.min(candles.length, Math.floor(max) + 1))
    const values = visible.flatMap((candle) => [candle[2], candle[3]])
    series.slice(1).forEach((line) => line.data.forEach((point) => {
      if (point.x >= min && point.x <= max && typeof point.y === 'number') values.push(point.y)
    }))
    if (tick?.ltp !== undefined && max >= candles.length - 1) values.push(tick.ltp)
    const low = values.reduce((result, value) => Math.min(result, value), Infinity)
    const high = values.reduce((result, value) => Math.max(result, value), -Infinity)
    const padding = Math.max((high - low) * 0.04, Math.abs(high) * 0.0002, 1)
    const shift = (high - low + padding * 2) * priceShift
    // Reserve only the width of the full prices, including the bold live marker.
    const axisLabelWidth = measureScale([low - padding + shift, high + padding + shift, tick?.ltp ?? high, ...horizontalLines.map(line => line.price)])
    return {
      chart: {
        type: 'candlestick', background: 'transparent', foreColor: '#6B7280',
        animations: { enabled: false }, parentHeightOffset: 0,
        zoom: { enabled: false }, toolbar: { show: false },
        events: { mounted: clipSeriesToGrid, updated: clipSeriesToGrid },
      },
      plotOptions: { candlestick: { colors: { upward: '#16A34A', downward: '#DC2626' } } },
      colors: series.map((line, index) => index === 0 ? '#6C63FF' : index === 1 ? '#F59E0B' : index === 2 ? '#2563EB' : line.name === 'Supertrend up' ? '#16A34A' : '#DC2626'),
      stroke: { width: series.map((_, index) => index === 0 ? 1 : 2), curve: 'straight' },
      markers: { size: 0 }, dataLabels: { enabled: false }, legend: { show: false },
      grid: { borderColor: '#E5E7EB', xaxis: { lines: { show: true } }, padding: { left: compact ? 2 : 16, right: 0, top: compact ? -22 : -16, bottom: 0 } },
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
        opposite: true, min: Number.isFinite(low) ? low - padding + shift : undefined, max: Number.isFinite(high) ? high + padding + shift : undefined,
        labels: { minWidth: axisLabelWidth, maxWidth: compact ? 64 : 78, formatter: price, style: { fontSize: '10px' } },
        crosshairs: { show: false, position: 'front', stroke: { color: '#94A3B8', width: 1, dashArray: 4 } }, tooltip: { enabled: false },
      },
      tooltip: { enabled: true, shared: false, intersect: false, custom: tooltip },
      annotations: { yaxis: [
        ...(tick?.ltp !== undefined ? [{
          id: 'live-index-price', y: tick.ltp, borderColor: '#6C63FF', strokeDashArray: 4,
          label: {
            text: price(tick.ltp), position: 'right', textAnchor: 'start', offsetX: 4, offsetY: 7, borderColor: '#6C63FF',
            style: { background: '#6C63FF', color: '#fff', fontSize: '10px', fontWeight: 600, padding: { left: 2, right: 2, top: 2, bottom: 2 } },
          },
        }] : []),
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
  }, [candles, min, max, series, tick?.ltp, priceShift, horizontalLines, compact])

  const volumeOptions = useMemo<ApexOptions>(() => {
    const visible = candles.slice(Math.max(0, Math.ceil(min)), Math.min(candles.length, Math.floor(max) + 1))
    const ceiling = Math.max(1, visible.reduce((value, candle) => Math.max(value, candle[5]), 0) * 1.05)
    const formatVolume = (value: number) => Intl.NumberFormat('en-IN', { notation: 'compact' }).format(value)
    // Volume labels are much shorter than index prices; give their unused scale space to the plot.
    const axisLabelWidth = measureScale([0, ceiling / 2, ceiling], formatVolume, 16)
    return {
      ...options,
      chart: { ...options.chart, type: 'bar', toolbar: { show: false }, zoom: { enabled: false }, events: { mounted: clipSeriesToGrid, updated: clipSeriesToGrid } },
      annotations: {}, stroke: { width: 0 },
      grid: { ...options.grid, padding: { left: compact ? 2 : 16, right: 0, top: -12, bottom: -10 } },
      plotOptions: { bar: { columnWidth: '70%' } },
      xaxis: { ...options.xaxis, labels: { show: false }, axisTicks: { show: false }, axisBorder: { show: false } },
      yaxis: { show: !volumeUnavailable, opposite: true, min: 0, max: ceiling, tickAmount: 2, labels: { minWidth: axisLabelWidth, maxWidth: axisLabelWidth + 4, style: { fontSize: '10px' }, formatter: formatVolume } },
    }
  }, [options, compact, candles, min, max, volumeUnavailable])

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
      const width = drag.max - drag.min
      panTo(drag.min - (event.clientX - drag.x) / drag.width * width, width)
      setPriceShift(Math.max(-2, Math.min(2, drag.shift + (event.clientY - drag.y) / drag.height)))
    }
    inspectCandle(event)
  }

  if (!candles.length) return <section ref={chartRef} className="candle-chart" aria-label={`${name} ${intervalLabel} chart`} style={{ padding: 12 }}><div className="candle-chart-title"><strong>{name}</strong><span aria-hidden="true">·</span><strong>{intervalLabel}</strong></div><span className="candle-market-heartbeat">{marketHeartbeat}</span><p style={{ color: 'var(--text-secondary)' }}>No candle data returned.</p></section>

  return (
    <section ref={chartRef} className="candle-chart" aria-label={`${name} ${intervalLabel} chart`}>
      <details className="candle-chart-info" open={infoOpen} onToggle={(event) => setInfoOpen(event.currentTarget.open)}>
        <summary aria-label={`Chart information and controls for ${name}`}>
          <span className="candle-chart-title"><strong>{name}</strong><span aria-hidden="true">·</span><strong>{intervalLabel}</strong></span>
          <svg className="card-disclosure-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </summary>
        <div className="candle-chart-header">
          <div className="candle-chart-identity">
            <span className="candle-market-heartbeat" aria-label={`${name} market heartbeat`}>{marketHeartbeat}</span>
            <span className="candle-chart-history">
              {savedCandleCount} candles · {isLive ? 'Live' : 'Waiting for live tick'}{savedCandleCount ? ' · Saved locally' : ''}
            </span>
          </div>
          <div className="candle-chart-details" role="status" aria-label="Candle OHLC and volume">
            <time dateTime={selected[0]}>{candleDate(selected[0])} IST</time>
            <span>Open <b>{price(selected[1])}</b></span>
            <span>High <b>{price(selected[2])}</b></span>
            <span>Low <b>{price(selected[3])}</b></span>
            <span>Close <b>{price(selected[4])}</b></span>
            <span>Volume <b>{selected[5].toLocaleString('en-IN')}</b></span>
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
          <ReactApexChart options={options} series={series} type="candlestick" height={360} width="100%" />
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
          if (Math.abs(shift - priceShift) > 0.01) { setMarker(null); setPriceShift(shift) }
        }}><div style={{ height: '500%', width: 1 }} /></div>
      </div>
      <details className="candle-volume" open={volumeOpen} onToggle={(event) => setVolumeOpen(event.currentTarget.open)}>
        <summary aria-label="Toggle volume chart">
          <span>Volume</span>
          <svg className="card-disclosure-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </summary>
        {volumeOpen && <div className="apex-volume-plot" onPointerDownCapture={inspectCandle} onPointerMoveCapture={inspectCandle}>
          <ReactApexChart options={volumeOptions} series={volumeSeries} type="bar" height={96} width="100%" />
          {volumeUnavailable && <span className="candle-volume-unavailable" role="status">Volume is unavailable for spot indices.</span>}
        </div>}
      </details>
      <div ref={horizontalScrollRef} className="candle-time-scroll" tabIndex={0} role="region" aria-label="Scroll chart history horizontally" onScroll={(event) => {
        const scroll = event.currentTarget
        const available = scroll.scrollWidth - scroll.clientWidth
        if (available <= 0) return
        const start = -0.5 + scroll.scrollLeft / available * (totalSpan - span)
        if (Math.abs(start - min) > 0.05) panTo(start, span)
      }}><div style={{ width: `${100 * totalSpan / span}%`, height: 1 }} /></div>
      <div className="candle-chart-legend"><span><i className="legend-bullish" /> Supertrend up</span><span><i className="legend-bearish" /> Supertrend down</span><span><i className="legend-ma" /> SMA(20)</span><span><i className="legend-ema" /> EMA(50)</span><span>Touch or hover to inspect · Drag or scroll to pan · Shift + wheel for history · Use + / − to zoom</span></div>
    </section>
  )
}
