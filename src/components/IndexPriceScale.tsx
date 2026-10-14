import { useLayoutEffect, useRef } from 'react'
import type { OptionPremiumSnapshot } from '../api/optionPremiums'
import { priceScalePosition, scaleViews, type ScaleView } from '../analysis/indexPriceScale'
export type ScaleGeometry = { left: number; top: number; width: number; height: number }
export type ScaleBadge = { id: string; value: number; text: string; background: string; color?: string; remove?: () => void }
export default function IndexPriceScale({ geometry, min, max, levels, name, view, onView, data, badges, onInteract }: {
  geometry: ScaleGeometry; min: number; max: number; levels: number[]; name: string; view: ScaleView; onView: (view: ScaleView) => void; data?: OptionPremiumSnapshot; badges: ScaleBadge[]; onInteract: () => void
}) {
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollLeft = geometry.width * scaleViews.indexOf(view) }, [view, geometry.width])
  const y = (value: number) => Math.max(7, Math.min(geometry.height - 7, priceScalePosition(value, min, max, geometry.height)))
  return <div ref={scroll} className="chart-scale-ladder" style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }} tabIndex={0} role="region" aria-label="Scroll left for CE premiums, center for index values, right for PE premiums" onPointerEnter={onInteract} onFocus={onInteract} onPointerDown={event => { event.stopPropagation(); onInteract() }} onPointerMove={event => event.stopPropagation()} onScroll={event => {
    const selected = Math.max(0, Math.min(2, Math.round(event.currentTarget.scrollLeft / geometry.width)))
    if (scaleViews[selected] !== view) onView(scaleViews[selected])
  }}>
    <div className="chart-scale-track" style={{ width: geometry.width * 3 }}>
      {scaleViews.map(mode => <div key={mode} className={`chart-scale-column is-${mode.toLowerCase()}`} style={{ width: geometry.width, height: geometry.height }} aria-hidden={view !== mode} aria-label={`${mode} price column`}>
        {levels.map(strike => {
          const leg = mode === 'INDEX' ? undefined : data?.rows.find(row => row.strike === strike)?.[mode === 'CE' ? 'ce' : 'pe']
          const value = mode === 'INDEX' ? strike.toLocaleString('en-IN') : leg?.ltp !== null && leg?.ltp !== undefined ? `₹${leg.ltp.toFixed(2)}` : '—'
          return <span key={strike} className="chart-scale-value" style={{ top: y(strike) }} data-strike={strike} title={mode === 'INDEX' ? `${name} index level ${strike}` : `${name} ${mode} · Strike ${strike} · ${data?.expiry ?? 'Nearest expiry'} · ${leg?.symbol ?? ''} · ${leg?.ltp == null ? leg?.message || 'Quote unavailable' : value}`} aria-label={`${mode} at strike ${strike}: ${value}`}>{value}</span>
        })}
        {mode === 'INDEX' && badges.filter(badge => badge.value >= min && badge.value <= max).map(badge => badge.remove ? <button key={badge.id} type="button" tabIndex={view === 'INDEX' ? 0 : -1} className="chart-scale-badge" style={{ top: y(badge.value), background: badge.background, color: badge.color ?? '#fff' }} aria-label={`Remove horizontal line at ${badge.value.toFixed(2)}`} onClick={badge.remove}>{badge.text}</button> : <span key={badge.id} className="chart-scale-badge" style={{ top: y(badge.value), background: badge.background, color: badge.color ?? '#fff' }}>{badge.text}</span>)}
      </div>)}
    </div>
  </div>
}
