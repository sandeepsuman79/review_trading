import { tradeDirection } from '../analysis/commodities'
import { useEffect } from 'react'
import type { PredictionEvent } from '../analysis/predictionEvents'

function EventToast({ event, onDismiss }: { event: PredictionEvent; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(event.id), 8_000)
    return () => window.clearTimeout(timer)
  }, [event.id, onDismiss])
  return <div className="prediction-event-toast" role="status">
    <div><strong>{event.instrument} · {tradeDirection(event.instrument, event.side)} · {event.reason}</strong><p>{event.detail}</p></div>
    <button type="button" aria-label={`Dismiss ${event.instrument} ${event.reason} notification`} onClick={() => onDismiss(event.id)}>×</button>
  </div>
}

export default function PredictionNotifications({ events, onDismiss }: {
  events: PredictionEvent[]; onDismiss: (id: string) => void
}) {
  return <div className="prediction-event-stack" aria-label="Prediction notifications">
    {events.slice(0, 3).map(event => <EventToast key={event.id} event={event} onDismiss={onDismiss} />)}
  </div>
}
