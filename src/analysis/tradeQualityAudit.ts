import type { AngelOneCandle } from '../api/angelOne'
import { candleIntervalMs } from './candleData'
import { assessConfirmationQuality, confirmationPolicy, higherConfirmationInterval, type ConfirmationQuality } from './confirmationQuality'
import { isConfirmedTrade, type PredictionRecord } from './predictionHistory'
import { reviewDate } from './sessionReview'
import type { AgentTimeframe } from './multiTimeframe'
import { isCommodity, type CommodityContract } from './commodities'

/** Inspect actual browser records, using only candles that had closed at each signal.
 * Historical ATM/OI snapshots cannot be recreated from today's live context.
 */
export function auditTradeQuality({ instrument, records, candlesByInterval, contract, now, date = reviewDate(now) }: {
  instrument: string; records: PredictionRecord[]; candlesByInterval: Partial<Record<AgentTimeframe, AngelOneCandle[]>>; contract?: CommodityContract; now: number; date?: string
}) {
  const trades = records.filter(record => record.instrument === instrument && isConfirmedTrade(record) && record.entryAt! <= now && reviewDate(record.entryAt!) === date)
    .sort((a, b) => a.entryAt! - b.entryAt!)
  const rows = trades.map(record => {
    const risk = Math.abs(record.entryPrice! - record.stopLoss)
    const settled = ['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(record.status) && record.exitAt !== undefined && record.exitAt <= now && record.points !== undefined
    const signalClose = Date.parse(record.signalCandleTime) + candleIntervalMs(record.interval)
    let assessment: ConfirmationQuality | undefined
    const bars = candlesByInterval[record.interval as AgentTimeframe]
    const matchingContract = !isCommodity(instrument) || Boolean(contract && record.contract && contract.token === record.contract.token
      && contract.symbol === record.contract.symbol && contract.expiry === record.contract.expiry && contract.exchange === record.contract.exchange)
    const matchingSignal = matchingContract && bars?.some(bar => bar[0] === record.signalCandleTime || Date.parse(bar[0]) === Date.parse(record.signalCandleTime))
    const higher = higherConfirmationInterval(record.interval)
    if (matchingSignal && signalClose <= now) assessment = assessConfirmationQuality({ instrument, side: record.side, candles: bars!, interval: record.interval, now: signalClose,
      higherCandles: higher ? candlesByInterval[higher as AgentTimeframe] : undefined, regimeCandles: candlesByInterval.FIFTEEN_MINUTE ?? [] })
    const available = assessment?.checks.find(check => check.code === 'QUALITY_DATA')?.passed === true
      && (!higher || assessment.higherBias !== 'UNAVAILABLE') && assessment.adaptive?.regime !== 'UNAVAILABLE'
    return { id: record.id, side: record.side, interval: record.interval, entryAt: record.entryAt!, status: record.status, exitAt: record.exitAt,
      points: settled ? record.points : undefined, r: settled && risk > 0 ? record.points! / risk : undefined,
      recordedPolicy: record.confirmationSnapshot?.policy ?? 'legacy / snapshot unavailable',
      priceAssessment: available ? assessment!.passed ? 'PASS' as const : 'BLOCK' as const : 'UNAVAILABLE' as const,
      blockers: available ? assessment!.checks.filter(check => !check.passed).map(check => `${check.label}: ${check.detail}`) : [matchingContract ? 'Full historical entry/higher-timeframe candles are unavailable.' : 'Historical candles for this exact MCX contract are unavailable.'],
      assessment, savedConfirmation: record.confirmationSnapshot }
  })
  const settled = rows.filter(row => row.points !== undefined), rs = settled.filter(row => row.r !== undefined)
  const wins = settled.filter(row => row.points! > 0).length, losses = settled.filter(row => row.points! < 0).length
  return { version: 1, policy: confirmationPolicy, date, instrument, generatedAt: now,
    scope: 'Actual saved browser trades; retrospective price filters only. Historical ATM VWAP/OI and unobserved fills are not reconstructed.',
    summary: { entries: rows.length, settled: settled.length, unresolved: rows.length - settled.length, wins, losses, flat: settled.length - wins - losses,
      points: settled.reduce((sum, row) => sum + row.points!, 0), meanR: rs.length ? rs.reduce((sum, row) => sum + row.r!, 0) / rs.length : null,
      priceBlocked: rows.filter(row => row.priceAssessment === 'BLOCK').length, unavailable: rows.filter(row => row.priceAssessment === 'UNAVAILABLE').length }, rows }
}
