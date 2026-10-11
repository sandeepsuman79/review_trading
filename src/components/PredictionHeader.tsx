import { useLayoutEffect, useState, type ReactNode } from 'react'

export default function PredictionHeader({ children }: { children: ReactNode }) {
  const [compact, setCompact] = useState(false)

  useLayoutEffect(() => {
    let frame = 0
    const updateScroll = () => {
      frame = 0
      // Separate thresholds prevent flicker as the header changes height near the top.
      setCompact(current => window.scrollY > (current ? 8 : 96))
    }
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(updateScroll) }
    updateScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  return <header className={`prediction-header${compact ? ' is-compact' : ''}`}>{children}</header>
}
