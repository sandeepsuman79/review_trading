import { recentChartTrend } from './recentChartTrend'
import type { AngelOneCandle } from '../api/angelOne'
import { completedCandles } from './candleData'
import { adjacentIndicatorBars } from './indicatorHistory'
import { analyzeChartStructure, observedSessionGap } from './chartStructure'
import { chartStructureOverlay } from './chartStructureOverlay'

/** Chart history is independent of entry readiness: preserve each observed
 * section's annotations without drawing a line across a missing trading bar. */
export function chartStructureDisplay(candles: AngelOneCandle[], instrument: string, tick: number, now: number, min: number, max: number) {
  const end = Math.min(candles.length, Math.max(0, Math.floor(max) + 1))
  const start = Math.max(0, Math.floor(min) - 80, end - 500)
  const closed = completedCandles(candles.slice(start, end), 'FIVE_MINUTE', now)
    .filter(b => Date.parse(b[0]) % 300000 === 0 && b.slice(1, 5).every(v => typeof v === 'number' && v > 0))
  const segments: AngelOneCandle[][] = []
  for (const bar of closed) {
    const current = segments[segments.length - 1], previous = current?.[current.length - 1]
    if (!previous || !adjacentIndicatorBars(Date.parse(previous[0]), Date.parse(bar[0]), 300000, instrument)) segments.push([bar])
    else current.push(bar)
  }
  const structures = segments.map((bars, i) => analyzeChartStructure(bars, tick, i === segments.length - 1 ? observedSessionGap(closed, instrument) : undefined))
  const latest = structures[structures.length - 1]
  const overlays = structures.map(s => chartStructureOverlay(s, candles))
  const recentGuides = segments.map(bars => recentChartTrend(bars, candles, tick))
  const recentGuide = recentGuides[recentGuides.length - 1]
  const structureLines = overlays.flatMap((overlay, i) => overlay.lines.map(line => ({ ...line, name: `${line.name} · ${structures[i].asOf}` })))
  const trendLines = recentGuides.flatMap((guide, i) => guide.line ? [{ ...guide.line, name: `${guide.line.name} · ${structures[i].asOf}` }] : [])
  const lines = [...structureLines, ...trendLines]
  const pendingPoints = (recentGuide?.points ?? []).filter(point => point.x >= min && point.x <= max)
  const points = overlays.flatMap(overlay => overlay.points).filter(point => point.x >= min && point.x <= max)
  const latestOverlay = overlays[overlays.length - 1]
  const recent = segments[segments.length - 1]?.slice(-20) ?? []
  const change = recent.length >= 2 ? recent[recent.length - 1][4] - recent[0][4] : undefined
  const movement = change === undefined ? 'WAITING' : Math.abs(change) <= tick ? 'FLAT' : change > 0 ? 'RISING' : 'FALLING'
  const swings = latest?.swings.length ?? 0
  const lineStatus = !latest || latest.bars < 5 ? 'Waiting for at least five completed candles to confirm swings.'
    : swings < 2 ? 'Waiting for two confirmed swing anchors; a smooth move may not form a pivot yet.'
      : !latest.lines.length ? 'No unbroken swing-based line; the recent price guide is shown.'
        : latest.lines.map(line => `${line.kind === 'SUPPORT' ? 'Rising support' : 'Falling resistance'}: ${line.touches} touches${line.validated ? ' · validated' : ' · provisional'}`).join(' · ')
  return { latest, movement, segments: segments.length, lines, structureLines, points, pendingPoints, recentTrend: recentGuide ? { direction: recentGuide.direction, bars: recentGuide.bars } : undefined,
    zones: latestOverlay?.zones ?? [], latestIndex: latestOverlay?.latestIndex, lineStatus }
}
