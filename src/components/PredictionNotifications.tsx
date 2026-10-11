import { useEffect, useRef } from 'react'
import type { PredictionEvent } from '../analysis/predictionEvents'
import type { PredictionRecord } from '../analysis/predictionHistory'

function EventToast({ event, paused, onDismiss }: { event: PredictionEvent; paused: boolean; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => onDismiss(event.id), 8_000)
    return () => window.clearTimeout(timer)
  }, [event.id, onDismiss, paused])
  return <div className="prediction-event-toast" role="status">
    <div><strong>{event.instrument} · {event.side} · {event.reason}</strong><p>{event.detail}</p></div>
    <button type="button" aria-label={`Dismiss ${event.instrument} ${event.reason} notification`} onClick={() => onDismiss(event.id)}>×</button>
  </div>
}

export default function PredictionNotifications({ events, earlyExit, onDismiss, onAcknowledge }: {
  events: PredictionEvent[]; earlyExit?: PredictionRecord; onDismiss: (id: string) => void; onAcknowledge: (id: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const okButton = useRef<HTMLButtonElement>(null)
  const earlyExitId = earlyExit?.id
  useEffect(() => {
    if (earlyExitId) {
      if (!dialog.current?.open) dialog.current?.showModal()
      okButton.current?.focus()
    } else dialog.current?.close()
  }, [earlyExitId])
  return <>
    <div className="prediction-event-stack" aria-label="Prediction notifications">
      {events.slice(0, 3).map(event => <EventToast key={event.id} event={event} paused={Boolean(earlyExitId)} onDismiss={onDismiss} />)}
    </div>
    <dialog ref={dialog} className="prediction-exit-alert" role="alertdialog" aria-labelledby="early-exit-title" aria-describedby="early-exit-detail" onCancel={event => event.preventDefault()}>
      {earlyExit && <>
        <h2 id="early-exit-title">{earlyExit.instrument} · {earlyExit.side} · Early exit</h2>
        <p id="early-exit-detail">{earlyExit.outcomeNote}</p>
        <p>Exit {earlyExit.exitPrice?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · {earlyExit.points! > 0 ? '+' : ''}{earlyExit.points?.toFixed(2)} index points</p>
        <button ref={okButton} type="button" onClick={() => onAcknowledge(earlyExit.id)}>OK</button>
      </>}
    </dialog>
  </>
}
