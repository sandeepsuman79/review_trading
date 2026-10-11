import { useEffect, useRef } from 'react'

export default function ErrorToast({ message, onDismiss, notificationId }: { message: string; onDismiss: () => void; notificationId?: number }) {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => dismissRef.current(), 6000)
    return () => window.clearTimeout(timer)
  }, [message, notificationId])

  if (!message) return null
  return (
    <div className="prediction-toast" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification">×</button>
    </div>
  )
}
