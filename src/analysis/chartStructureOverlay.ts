import type { AngelOneCandle } from '../api/angelOne'
import { trendLinePrice, type ChartStructure } from './chartStructure'

/** Draw at actual observed bar indices, with no extrapolation into forming bars. */
export function chartStructureOverlay(structure: ChartStructure, candles: AngelOneCandle[]) {
  const indices = new Map(candles.map((b, i) => [Date.parse(b[0]), i]))
  const indexOf = (at: string) => indices.get(Date.parse(at))
  const lines = structure.lines.flatMap(line => {
    const from = indexOf(line.start.at), to = indexOf(line.endAt)
    if (from === undefined || to === undefined || to <= from) return []
    return [{ name: `${line.kind === 'SUPPORT' ? 'Rising support' : 'Falling resistance'} · ${line.validated ? `${line.touches} touches` : 'provisional (2 touches)'}`,
      type: 'line' as const, validated: line.validated, color: line.kind === 'SUPPORT' ? '#15803D' : '#B91C1C',
      data: Array.from({ length: to - from + 1 }, (_, i) => ({ x: from + i, y: trendLinePrice(line, line.start.index + i) })) }]
  })
  const points = structure.swings.flatMap(s => {
    const x = indexOf(s.at)
    return x === undefined ? [] : [{ x, y: s.price, marker: { size: 3, fillColor: s.kind === 'LOW' ? '#15803D' : '#B91C1C' },
      label: { text: s.label, offsetY: s.kind === 'HIGH' ? -12 : 20, borderColor: 'transparent', style: { background: '#F1F5F9', color: '#334155', fontSize: '9px' } } }]
  })
  const close = candles.find(b => b[0] === structure.asOf)?.[4]
  const supports = structure.zones.filter(z => z.role === 'SUPPORT' && z.low < (close ?? 0)).sort((a, b) => b.high - a.high).slice(0, 2)
  const resistance = structure.zones.filter(z => z.role === 'RESISTANCE' && z.high > (close ?? Infinity)).sort((a, b) => a.low - b.low).slice(0, 2)
  const zones = [...supports, ...resistance].map((z, i) => ({ id: `price-zone-${i}`, y: z.low, y2: z.high, fillColor: z.role === 'SUPPORT' ? '#16A34A' : '#DC2626', opacity: .08, borderColor: 'transparent',
    label: { text: `${z.role === 'SUPPORT' ? 'Support' : 'Resistance'} zone · ${z.touches} swing${z.touches > 1 ? 's' : ''}${z.flipped ? ' · role flipped' : ''}`, position: 'left', style: { background: '#F8FAFC', color: '#475569', fontSize: '9px' } } }))
  return { lines, points, zones, latestIndex: structure.asOf ? indexOf(structure.asOf) : undefined }
}
