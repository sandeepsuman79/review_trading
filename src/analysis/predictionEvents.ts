import { isCommodity } from './commodities'
import { squareOffLabel } from './tradingSession'
import { isConfirmedTrade, type PredictionRecord } from './predictionHistory'

export type PredictionEvent = {
  id: string
  recordId: string
  instrument: string
  side: 'CALL' | 'PUT'
  reason: string
  detail: string
}

/** Compare observed ledger states. Loading history emits nothing; unsaved live transitions still alert the user. */
export function predictionEvents(previous: PredictionRecord[], next: PredictionRecord[], now?: number): PredictionEvent[] {
  const before = new Map(previous.map(record => [record.id, record]))
  // Settle an existing position before announcing entry into its replacement, regardless of array order.
  const existingExit = (record: PredictionRecord) => {
    const old = before.get(record.id)
    return old?.status === 'ACTIVE' && record.status !== 'ACTIVE'
  }
  return [...next].sort((a, b) => Number(existingExit(b)) - Number(existingExit(a))).flatMap(record => {
    if (!isConfirmedTrade(record)) return []
    const old = before.get(record.id)
    const events: PredictionEvent[] = []
    const add = (kind: string, reason: string, detail: string) => events.push({
      id: `${record.id}:${kind}`, recordId: record.id, instrument: record.instrument, side: record.side, reason, detail,
    })
    const newEntry = !old || old.entryAt === undefined
    const liveEntry = record.status === 'ACTIVE' && (record.entrySource === 'LIVE' || record.entrySource === undefined && record.latestPriceSource === 'LIVE')
      && (now === undefined || now - record.entryAt! >= -1_000 && now - record.entryAt! <= 30_000)
    if (newEntry && liveEntry) {
      add('entry', isCommodity(record.instrument) ? 'Confirmed trade · Entry reached' : 'Confirm call · Entry reached', `Entry ${record.entryPrice!.toFixed(2)}. Target ${record.target.toFixed(2)} · Stop loss ${record.stopLoss.toFixed(2)}.`)
    }
    if ((!old || old.status !== record.status) && record.status !== 'PENDING' && record.status !== 'ACTIVE') {
      const reason = record.status === 'TARGET_HIT' ? 'Target achieved · Exit'
        : record.status === 'STOP_LOSS_HIT' ? 'Stop loss · Exit'
        : record.status === 'EARLY_EXIT' ? record.earlyExitSource === 'SESSION_SQUARE_OFF' ? `${squareOffLabel(record.instrument, record.entryAt ?? record.generatedAt)} square-off · Exit` : record.earlyExitSource === 'AGENT_PROTECTION' ? 'Protective exit' : record.earlyExitSource === 'AGENT_REVERSAL' ? record.reversalInterval === 'ONE_MINUTE' ? '1-minute reversal · Exit' : 'Agent reversal · Exit' : 'Exit'
        : record.status === 'EXPIRED' ? 'Exit · Setup expired'
        : record.status === 'AMBIGUOUS' ? 'Exit · Outcome ambiguous' : 'Exit · Outcome unverified'
      const result = record.points === undefined ? '' : `Booked ${record.points > 0 ? 'profit' : record.points < 0 ? 'loss' : 'break-even'}: ${record.points > 0 ? '+' : ''}${record.points.toFixed(2)} price points. `
      add(record.status, newEntry && record.entrySource === 'CANDLE' ? `Recorded outcome · ${reason}` : reason, `${record.exitPrice === undefined ? '' : `Exit ${record.exitPrice.toFixed(2)}. `}${result}${record.outcomeNote}`)
    }
    return events
  })
}
