import { isConfirmedTrade, predictionHistoryStats, type PredictionRecord } from './predictionHistory'

const tradingDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })

export function todayConfirmedTrades(records: PredictionRecord[], now: number) {
  const day = tradingDate.format(now)
  const trades = records.filter(record => isConfirmedTrade(record) && record.entryAt! <= now && tradingDate.format(record.entryAt!) === day)
    .sort((a, b) => b.entryAt! - a.entryAt! || b.generatedAt - a.generatedAt || a.id.localeCompare(b.id))
  const stats = predictionHistoryStats(trades)
  const indices = [...new Set(trades.map(record => record.instrument))].map(instrument => ({
    instrument, ...predictionHistoryStats(trades.filter(record => record.instrument === instrument)),
  }))
  return { trades, stats, indices }
}

export function confirmedTradePoints(record: PredictionRecord) {
  if (record.status === 'ACTIVE' && record.latestPrice !== undefined && record.entryPrice !== undefined) {
    const points = Math.round((record.latestPrice - record.entryPrice) * (record.side === 'CALL' ? 1 : -1) * 100) / 100
    return points === 0 ? 0 : points
  }
  return ['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(record.status) ? record.points : undefined
}
