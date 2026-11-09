import type { AngelOneCandle } from '../api/angelOne'
import { completedCandles } from './candleData'
import { adjacentIndicatorBars } from './indicatorHistory'
import { instrumentSession, tradingSession } from './tradingSession'

export type ChartSwing = { index: number; at: string; confirmedAt: string; price: number; kind: 'HIGH' | 'LOW'; label: 'H' | 'L' | 'HH' | 'HL' | 'LH' | 'LL' | 'EH' | 'EL' }
export type PriceZone = { low: number; high: number; role: 'SUPPORT' | 'RESISTANCE'; originalRole: 'SUPPORT' | 'RESISTANCE'; touches: number; firstAt: string; lastAt: string; flipped: boolean }
export type PriceTrendLine = { kind: 'SUPPORT' | 'RESISTANCE'; start: ChartSwing; anchor: ChartSwing; slope: number; touches: number; validated: boolean; endAt: string; endPrice: number }
export type PriceGap = { direction: 'UP' | 'DOWN'; low: number; high: number; at: string; state: 'OPEN' | 'PARTIAL' | 'FILLED'; basis: 'SESSION_RANGE' }
export type ChartStructure = { version: 2; asOf?: string; bars: number; tolerance: number; trend: 'UPTREND' | 'DOWNTREND' | 'RANGE' | 'TRANSITION' | 'UNDETERMINED'; swings: ChartSwing[]; zones: PriceZone[]; lines: PriceTrendLine[]; gap?: PriceGap }
const step = 300000
const last = <T,>(values: T[], back = 1) => values[values.length - back]

/** Never span missing trading observations. Regular session closures are allowed. */
export function completedChartHistory(input: AngelOneCandle[], instrument: string, now: number) {
  const closed = completedCandles(input, 'FIVE_MINUTE', now).filter(b => {
    const time = Date.parse(b[0]), session = instrumentSession(time, instrument)
    // A special day's pre-open/auction observations are not continuous-session
    // pattern bars, even if a historical response happens to include them.
    return time % step === 0 && b.slice(1, 5).every(v => typeof v === 'number' && v > 0)
      && (!session.special || time >= session.open && time + step <= session.close)
  })
  let start = closed.length - 1
  while (start > 0 && adjacentIndicatorBars(Date.parse(closed[start - 1][0]), Date.parse(closed[start][0]), step, instrument)) start--
  return { closed, tail: closed.slice(Math.max(0, start)).slice(-80) }
}

export const trendLinePrice = (line: PriceTrendLine, index: number) => line.start.price + (index - line.start.index) * line.slope

/** Input must be chronological completed, contiguous trading bars. Two bars on
 * each side confirm a pivot. No oscillator, volume or future observation is used. */
export function analyzeChartStructure(bars: AngelOneCandle[], tick: number, gap?: PriceGap): ChartStructure {
  const ranges = bars.slice(-20).map(b => b[2] - b[3]).sort((a, b) => a - b)
  const median = ranges.length ? ranges[Math.floor(ranges.length / 2)] : 0
  const tolerance = Math.max(2 * tick, median * .15)
  const swings: ChartSwing[] = []
  for (let i = 2; i < bars.length - 2; i++) {
    const neighbours = [...bars.slice(i - 2, i), ...bars.slice(i + 1, i + 3)]
    for (const kind of ['HIGH', 'LOW'] as const) {
      const column = kind === 'HIGH' ? 2 : 3, price = bars[i][column]
      if (!neighbours.every(b => kind === 'HIGH' ? price > b[column] : price < b[column])) continue
      const previous = last(swings.filter(s => s.kind === kind)), delta = previous ? price - previous.price : 0
      const label = !previous ? kind === 'HIGH' ? 'H' : 'L' : Math.abs(delta) <= tick ? kind === 'HIGH' ? 'EH' : 'EL' : kind === 'HIGH' ? delta > 0 ? 'HH' : 'LH' : delta > 0 ? 'HL' : 'LL'
      swings.push({ index: i, at: bars[i][0], confirmedAt: bars[i + 2][0], price, kind, label })
    }
  }
  const highs = swings.filter(s => s.kind === 'HIGH'), lows = swings.filter(s => s.kind === 'LOW')
  const hi = last(highs), lo = last(lows)
  const trend: ChartStructure['trend'] = !hi || !lo || highs.length < 2 || lows.length < 2 ? 'UNDETERMINED'
    : hi.label === 'HH' && lo.label === 'HL' ? 'UPTREND' : hi.label === 'LH' && lo.label === 'LL' ? 'DOWNTREND'
      : ['EH', 'LH'].includes(hi.label) && ['EL', 'HL'].includes(lo.label) ? 'RANGE' : 'TRANSITION'
  const clusters: Array<{ swings: ChartSwing[]; low: number; high: number }> = []
  for (const swing of swings) {
    const cluster = clusters.find(z => Math.max(z.high, swing.price) - Math.min(z.low, swing.price) <= tolerance)
    if (cluster) { cluster.swings.push(swing); cluster.low = Math.min(cluster.low, swing.price); cluster.high = Math.max(cluster.high, swing.price) }
    else clusters.push({ swings: [swing], low: swing.price, high: swing.price })
  }
  const zones: PriceZone[] = clusters.map(z => {
    const first = z.swings[0], latest = last(z.swings)!, originalRole = first.kind === 'LOW' ? 'SUPPORT' as const : 'RESISTANCE' as const
    const low = Math.max(tick, z.low - tick), high = z.high + tick
    let role = originalRole
    // A wick or one close cannot flip a zone. It must exist before both closes.
    for (let i = first.index + 4; i < bars.length; i++) {
      if (bars[i - 1][4] > high + tick && bars[i][4] > high + tick) role = 'SUPPORT'
      else if (bars[i - 1][4] < low - tick && bars[i][4] < low - tick) role = 'RESISTANCE'
    }
    return { low, high, role, originalRole, touches: new Set(z.swings.map(s => s.index)).size, firstAt: first.at, lastAt: latest.at, flipped: role !== originalRole }
  })
  const lines: PriceTrendLine[] = []
  for (const kind of ['SUPPORT', 'RESISTANCE'] as const) {
    const points = (kind === 'SUPPORT' ? lows : highs).slice(-8), d = kind === 'SUPPORT' ? 1 : -1
    const candidates: PriceTrendLine[] = []
    for (let a = 0; a < points.length - 1; a++) for (let b = a + 1; b < points.length; b++) {
      const start = points[a], anchor = points[b], span = anchor.index - start.index
      const slope = (anchor.price - start.price) / span
      if (span < 4 || d * slope <= 0 || Math.abs(slope) > Math.max(tick, median * .75)) continue
      const priceAt = (i: number) => start.price + (i - start.index) * slope
      // Do not fit a line through candles that already closed through it.
      if (bars.slice(start.index + 1).some((bar, j) => d * (bar[4] - priceAt(start.index + 1 + j)) < -tolerance)) continue
      const touches = points.slice(a).filter(p => Math.abs(p.price - priceAt(p.index)) <= tolerance).length
      const endPrice = priceAt(bars.length - 1)
      if (endPrice <= 0) continue
      candidates.push({ kind, start, anchor, slope, touches, validated: touches >= 3, endAt: last(bars)![0], endPrice })
    }
    candidates.sort((a, b) => Number(b.validated) - Number(a.validated) || b.anchor.index - a.anchor.index || b.touches - a.touches || b.start.index - a.start.index)
    if (candidates[0]) lines.push(candidates[0])
  }
  return { version: 2, asOf: last(bars)?.[0], bars: bars.length, tolerance, trend, swings, zones, lines, gap }
}

/** A session-range gap needs a fully observed previous regular session and the
 * current opening bar. No partial day's range is called a completed daily gap. */
export function observedSessionGap(closed: AngelOneCandle[], instrument: string): PriceGap | undefined {
  const latest = last(closed)
  if (!latest) return
  const current = tradingSession(Date.parse(latest[0])), currentBars = closed.filter(b => tradingSession(Date.parse(b[0])).date === current.date)
  const prior = closed.filter(b => tradingSession(Date.parse(b[0])).date !== current.date), previous = last(prior)
  if (!previous || !currentBars.length) return
  const session = instrumentSession(Date.parse(previous[0]), instrument), previousBars = prior.filter(b => tradingSession(Date.parse(b[0])).date === session.date)
  const open = session.open, close = session.close
  if (Date.parse(previousBars[0][0]) !== open || previousBars.length !== (close - open) / step || previousBars.some((b, i) => Date.parse(b[0]) !== open + i * step)
    || Date.parse(currentBars[0][0]) !== instrumentSession(Date.parse(latest[0]), instrument).open
    || !adjacentIndicatorBars(Date.parse(previous[0]), Date.parse(currentBars[0][0]), step, instrument)
    || currentBars.some((b, i) => i > 0 && Date.parse(b[0]) !== Date.parse(currentBars[i - 1][0]) + step)) return
  const high = Math.max(...previousBars.map(b => b[2])), low = Math.min(...previousBars.map(b => b[3])), first = currentBars[0]
  if (first[3] > high) {
    const reached = Math.min(...currentBars.map(b => b[3]))
    return { direction: 'UP', low: high, high: first[3], at: first[0], state: reached <= high ? 'FILLED' : reached < first[3] ? 'PARTIAL' : 'OPEN', basis: 'SESSION_RANGE' }
  }
  if (first[2] < low) {
    const reached = Math.max(...currentBars.map(b => b[2]))
    return { direction: 'DOWN', low: first[2], high: low, at: first[0], state: reached >= low ? 'FILLED' : reached > first[2] ? 'PARTIAL' : 'OPEN', basis: 'SESSION_RANGE' }
  }
}

/** Persisted evidence is versioned and bounded; malformed snapshots cannot make
 * an archived record look like a newly confirmed chart-structure trade. */
export function validSavedChartStructure(value: ChartStructure | undefined, signalAt: string) {
  if (!value || value.version !== 2 || !Number.isInteger(value.bars) || value.bars < 1 || value.bars > 80
    || !Number.isFinite(value.tolerance) || value.tolerance <= 0 || !['UPTREND', 'DOWNTREND', 'RANGE', 'TRANSITION', 'UNDETERMINED'].includes(value.trend)
    || !value.asOf || Date.parse(value.asOf) !== Date.parse(signalAt) - 2 * step
    || !Array.isArray(value.swings) || value.swings.length > 160 || !Array.isArray(value.zones) || value.zones.length > 160 || !Array.isArray(value.lines) || value.lines.length > 2) return false
  const swing = (s: ChartSwing) => Boolean(s && Number.isInteger(s.index) && s.index >= 2 && s.index < value.bars - 2
    && Number.isFinite(s.price) && s.price > 0 && ['HIGH', 'LOW'].includes(s.kind) && ['H', 'L', 'HH', 'HL', 'LH', 'LL', 'EH', 'EL'].includes(s.label)
    && Number.isFinite(Date.parse(s.at)) && Date.parse(s.at) % step === 0 && Date.parse(s.confirmedAt) >= Date.parse(s.at) + 2 * step && Date.parse(s.confirmedAt) <= Date.parse(value.asOf!))
  return value.swings.every(swing) && value.zones.every(z => z && Number.isFinite(z.low) && z.low > 0 && Number.isFinite(z.high) && z.high > z.low
    && ['SUPPORT', 'RESISTANCE'].includes(z.role) && ['SUPPORT', 'RESISTANCE'].includes(z.originalRole) && typeof z.flipped === 'boolean'
    && Number.isInteger(z.touches) && z.touches >= 1 && Number.isFinite(Date.parse(z.firstAt)) && Date.parse(z.lastAt) >= Date.parse(z.firstAt) && Date.parse(z.lastAt) <= Date.parse(value.asOf!))
    && value.lines.every(l => l && swing(l.start) && swing(l.anchor) && l.anchor.index > l.start.index && Number.isFinite(l.slope)
      && ['SUPPORT', 'RESISTANCE'].includes(l.kind) && l.slope * (l.kind === 'SUPPORT' ? 1 : -1) > 0
      && Number.isInteger(l.touches) && l.touches >= 2 && l.validated === (l.touches >= 3)
      && l.endAt === value.asOf && Number.isFinite(l.endPrice) && l.endPrice > 0)
    && (!value.gap || ['UP', 'DOWN'].includes(value.gap.direction) && ['OPEN', 'PARTIAL', 'FILLED'].includes(value.gap.state)
      && value.gap.basis === 'SESSION_RANGE' && Number.isFinite(value.gap.low) && value.gap.low > 0 && Number.isFinite(value.gap.high) && value.gap.high > value.gap.low
      && Number.isFinite(Date.parse(value.gap.at)) && Date.parse(value.gap.at) <= Date.parse(value.asOf!))
}
