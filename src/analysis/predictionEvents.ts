import type { PredictionRecord } from './predictionHistory'

export type PredictionEvent = {
  id: string
  recordId: string
  instrument: string
  side: 'CALL' | 'PUT'
  reason: string
  detail: string
}

/** Compare a successful history write with its prior value. Loading history emits nothing. */
export function predictionEvents(previous: PredictionRecord[], next: PredictionRecord[]): PredictionEvent[] {
  const before = new Map(previous.map(record => [record.id, record]))
  return next.flatMap(record => {
    const old = before.get(record.id)
    const events: PredictionEvent[] = []
    const add = (kind: string, reason: string, detail: string) => events.push({
      id: `${record.id}:${kind}`, recordId: record.id, instrument: record.instrument, side: record.side, reason, detail,
    })
    if (!old) add('setup', record.stage === 'CONFIRMED' ? 'Confirm call' : 'Early setup', `Awaiting entry at ${record.entry.toFixed(2)}. ${record.reason}`)
    if (old && old.entryAt === undefined && record.entryAt !== undefined) {
      add('entry', 'Confirm call · Entry reached', `Entry ${record.entryPrice!.toFixed(2)}. Target ${record.target.toFixed(2)} · Stop loss ${record.stopLoss.toFixed(2)}.`)
    }
    if (old && old.status !== record.status && record.status !== 'PENDING' && record.status !== 'ACTIVE') {
      const reason = record.status === 'TARGET_HIT' ? 'Target achieved · Exit'
        : record.status === 'STOP_LOSS_HIT' ? 'Stop loss · Exit'
        : record.status === 'EARLY_EXIT' ? 'Early exit'
        : record.status === 'EXPIRED' ? 'Exit · Setup expired'
        : record.status === 'AMBIGUOUS' ? 'Exit · Outcome ambiguous' : 'Exit · Outcome unverified'
      add(record.status, reason, `${record.exitPrice === undefined ? '' : `Exit ${record.exitPrice.toFixed(2)}. `}${record.outcomeNote}`)
    }
    return events
  })
}
