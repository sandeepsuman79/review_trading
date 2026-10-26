import type { AngelOneCandle } from '../api/angelOne'
import { candleBucketTime, candleIntervalMs, completedCandles } from './candleData'
import { isCommodity } from './commodities'
import { calculateMovingAverageSeries } from './movingAverages'
import type { PriceActionInterval } from './priceAction'
import { calculateTechnicalIndicatorSeries } from './technicalIndicators'
import { candleSession } from './vwap'
import { deriveAdaptiveThresholds, type AdaptiveThresholds, type ThresholdMode } from './adaptiveConfirmation'

export const confirmationPolicy = 'adaptive-confirmation-v3' as const
export type ConfirmationIndicator = 'EMA20_50' | 'RSI14' | 'SUPERTREND'
// Explicit policy selection, shared across instruments; never select a winning indicator retrospectively.
export const confirmationConfig = { indicator: 'EMA20_50' as ConfirmationIndicator, continuationScore: 55, continuationLead: 15, reversalScore: 65, reversalLead: 20 }
export function passesConfirmationScore(support: number, opposition: number, minimumScore: number, minimumLead: number) {
  return Number.isFinite(support) && Number.isFinite(opposition) && support > 0 && opposition >= 0 && support >= minimumScore
    && Math.round((support - opposition) * 10) / 10 >= minimumLead
}
// Intraday adaptation of educational concepts, not parameters validated by ChartSchool.
export const confirmationRules = { minimumAdx: 20, maximumExtensionAtr: 1.5, maximumSignalRangeAtr: 1.8, maximumGapAtr: .5,
  minimumBodyFraction: .35, minimumClosePosition: .65, breakLookback: 10, breakBufferAtr: .05, retestToleranceAtr: .25,
  breakoutRelativeVolume: 1.2, pullbackRelativeVolume: .8, volumeLookback: 20, minimumVolumeBars: 6 }
export type ConfirmationCheck = { code: 'QUALITY_DATA' | 'TREND_REGIME' | 'HIGHER_TREND' | 'ENTRY_EXTENSION' | 'PRICE_ACCEPTANCE' | 'MOMENTUM_CONFIRMATION' | 'PARTICIPATION'; label: string; passed: boolean; detail: string }
export type ConfirmationQuality = {
  policy: typeof confirmationPolicy | 'structure-confirmation-v2' | 'chart-confirmation-v1'; asOf?: string; passed: boolean; reason: string; side: 'CALL' | 'PUT'
  adaptive?: AdaptiveThresholds
  setupType?: 'CONTINUATION' | 'REVERSAL' | 'TRANSITION'; indicator?: ConfirmationIndicator
  structureLevel?: number; invalidationLevel?: number; requiredScore?: number; requiredLead?: number
  appliedScore?: number; appliedLead?: number
  family?: 'PULLBACK' | 'ACCEPTED_BREAK' | 'STRUCTURE_REVERSAL'; adx?: number; extensionAtr?: number; relativeVolume?: number
  atr14?: number; rsi14?: number; ema20?: number; ema50?: number
  vwap?: { passed: boolean; source: 'ATM_OPTIONS' | 'CONTRACT'; observedAt: number; quote?: number; value?: number; strike?: number; expiry?: string
    ce?: { close: number | null; vwap: number | null; volume: number; asOf: string | null }; pe?: { close: number | null; vwap: number | null; volume: number; asOf: string | null } }
  higherInterval?: PriceActionInterval; higherAsOf?: string; higherBias: 'CALL' | 'PUT' | 'NEUTRAL' | 'UNAVAILABLE'
  checks: ConfirmationCheck[]
}
export type ConfirmationContext = { higherCandles?: AngelOneCandle[]; indicator?: ConfirmationIndicator; regimeCandles?: AngelOneCandle[]; thresholdMode?: ThresholdMode }
export const higherConfirmationInterval = (interval: PriceActionInterval): PriceActionInterval | undefined => interval === 'FIVE_MINUTE' ? 'FIFTEEN_MINUTE' : interval === 'FIFTEEN_MINUTE' ? 'ONE_HOUR' : undefined
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const round = (value: number | undefined) => value === undefined ? undefined : Math.round(value * 1000) / 1000

/** Build only complete higher bars; never bridge missing bars, sessions or a forming close. */
export function aggregateConfirmationCandles(candles: AngelOneCandle[], interval: PriceActionInterval, target: PriceActionInterval, instrument: string, asOf: number): AngelOneCandle[] {
  const from = candleIntervalMs(interval), to = candleIntervalMs(target)
  if (to <= from || to % from !== 0) return []
  const groups = new Map<number, AngelOneCandle[]>()
  for (const bar of completedCandles(candles, interval, asOf)) {
    const bucket = candleBucketTime(Date.parse(bar[0]), target, isCommodity(instrument) ? 540 : 555)
    const group = groups.get(bucket) ?? []; group.push(bar); groups.set(bucket, group)
  }
  return [...groups].flatMap(([start, bars]): AngelOneCandle[] => {
    if (bars.length !== to / from || start + to > asOf || bars.some((bar, i) => Date.parse(bar[0]) !== start + i * from || candleSession(bar[0]) !== candleSession(bars[0][0]))) return []
    return [[new Date(start).toISOString(), bars[0][1], Math.max(...bars.map(bar => bar[2])), Math.min(...bars.map(bar => bar[3])), bars[bars.length - 1][4], bars.reduce((sum, bar) => sum + bar[5], 0)]]
  })
}

const seriesCache = new WeakMap<AngelOneCandle[], { interval: PriceActionInterval; at: number; result: ReturnType<typeof series> }>()
function series(raw: AngelOneCandle[], interval: PriceActionInterval, asOf: number) {
  const bars = completedCandles(raw, interval, asOf)
  return { bars, averages: calculateMovingAverageSeries(bars.map(bar => bar[4])), points: calculateTechnicalIndicatorSeries(bars.map(bar => bar[2]), bars.map(bar => bar[3]), bars.map(bar => bar[4])) }
}
function cachedSeries(raw: AngelOneCandle[], interval: PriceActionInterval, at: number) {
  const saved = seriesCache.get(raw)
  if (saved?.interval === interval && saved.at === at) return saved.result
  const result = series(raw, interval, at); seriesCache.set(raw, { interval, at, result }); return result
}

/** Chronological price/regime qualification. Existing weighted score and risk checks remain separate. */
export function assessConfirmationQuality({ candles, interval, instrument, side, now, higherCandles, regimeCandles, thresholdMode, indicator = confirmationConfig.indicator }: {
  candles: AngelOneCandle[]; interval: PriceActionInterval; instrument: string; side: 'CALL' | 'PUT'; now: number; higherCandles?: AngelOneCandle[]; indicator?: ConfirmationIndicator; regimeCandles?: AngelOneCandle[]; thresholdMode?: ThresholdMode
}): ConfirmationQuality {
  const closed = completedCandles(candles, interval, now), latest = closed[closed.length - 1]
  const asOf = latest?.[0], signalClose = asOf ? Date.parse(asOf) + candleIntervalMs(interval) : now
  const { bars, averages, points } = cachedSeries(candles, interval, signalClose)
  const end = bars.length - 1, current = points[end], previous = bars[end - 1], point = averages[end], older = averages[end - 3]
  const atr = current?.atr14, ema = point?.ema20, d = side === 'CALL' ? 1 : -1
  const checks: ConfirmationCheck[] = []
  const add = (code: ConfirmationCheck['code'], label: string, passed: boolean, detail: string) => checks.push({ code, label, passed, detail })
  const recent = bars.slice(-3)
  const ready = bars.length >= 50 && Boolean(latest && previous) && finite(atr) && atr > 0 && finite(ema) && finite(point?.ema50)
    && now >= signalClose && now < signalClose + candleIntervalMs(interval) && candleSession(latest[0]) === candleSession(new Date(now).toISOString())
    && recent.length === 3 && recent.every((bar, i) => candleSession(bar[0]) === candleSession(latest[0]) && (!i || Date.parse(bar[0]) - Date.parse(recent[i - 1][0]) === candleIntervalMs(interval)))
  add('QUALITY_DATA', 'Quality data', ready, '50 completed indicator bars and three consecutive current-session price bars; no forming candle or missing interval')
  const higherInterval = higherConfirmationInterval(interval)
  let higherBias: ConfirmationQuality['higherBias'] = 'UNAVAILABLE', higherAsOf: string | undefined
  if (higherInterval) {
    const raw = higherCandles ?? aggregateConfirmationCandles(candles, interval, higherInterval, instrument, signalClose)
    const higher = cachedSeries(raw, higherInterval, signalClose), last = higher.bars.length - 1, avg = higher.averages[last], old = higher.averages[last - 3], bar = higher.bars[last]
    higherAsOf = bar?.[0]
    const duration = candleIntervalMs(higherInterval), at = Date.parse(higherAsOf ?? ''), tail = higher.bars.slice(-4)
    if (higher.bars.length >= 50 && bar && signalClose >= at + duration && signalClose < at + 2 * duration && candleSession(bar[0]) === candleSession(latest?.[0] ?? '')
      && tail.length === 4 && tail.every((item, i) => !i || candleSession(item[0]) !== candleSession(tail[i - 1][0]) || Date.parse(item[0]) - Date.parse(tail[i - 1][0]) === duration)
      && finite(avg?.ema20) && finite(avg?.ema50) && finite(old?.ema20)) {
      higherBias = avg.ema20 > avg.ema50 && avg.ema20 > old.ema20 && bar[4] > avg.ema20 ? 'CALL' : avg.ema20 < avg.ema50 && avg.ema20 < old.ema20 && bar[4] < avg.ema20 ? 'PUT' : 'NEUTRAL'
    }
  }
  const range = latest ? latest[2] - latest[3] : 0, body = latest ? d * (latest[4] - latest[1]) : 0
  const extension = ready ? Math.abs(latest[4] - ema!) / atr! : undefined
  const closePosition = range > 0 ? (side === 'CALL' ? latest[4] - latest[3] : latest[2] - latest[4]) / range : 0
  const cleanEntry = ready && extension! <= confirmationRules.maximumExtensionAtr && range > 0 && range <= confirmationRules.maximumSignalRangeAtr * atr!
    && Math.abs(latest[1] - previous[4]) <= confirmationRules.maximumGapAtr * atr! && body >= confirmationRules.minimumBodyFraction * range && closePosition >= confirmationRules.minimumClosePosition
  add('ENTRY_EXTENSION', 'Entry candle quality', Boolean(cleanEntry), `Distance from EMA20 ${extension?.toFixed(2) ?? 'unavailable'} ATR / ${confirmationRules.maximumExtensionAtr}; bounded candle range/gap, directional body and strong close required`)
  const buffer = confirmationRules.breakBufferAtr * (atr ?? 0), tolerance = confirmationRules.retestToleranceAtr * (atr ?? 0)
  const priorRange = bars.slice(-12, -2), level = priorRange.length === 10 ? side === 'CALL' ? Math.max(...priorRange.map(bar => bar[2])) : Math.min(...priorRange.map(bar => bar[3])) : undefined
  const acceptedBreak = ready && level !== undefined && d * (previous[4] - level) > buffer && d * (latest[4] - level) > buffer
    && (side === 'CALL' ? latest[3] >= level - tolerance : latest[2] <= level + tolerance) && previous[2] - previous[3] <= 2 * atr!
  const pullback = ready && bars.slice(-5, -1).some((bar, i) => {
    const average = averages[end - 4 + i]?.ema20
    return finite(average) && d * (bar[4] - bar[1]) < 0 && (side === 'CALL' ? bar[3] <= average + tolerance : bar[2] >= average - tolerance) && d * (bar[4] - average) >= -tolerance
  }) && d * (latest[4] - (side === 'CALL' ? previous[2] : previous[3])) > buffer
  // A pivot needs two completed bars on either side and must be known before
  // the first break candle. Stop at session/data boundaries; never borrow future pivots.
  const history: AngelOneCandle[] = []
  for (let i = end - 2; i >= 0 && history.length < 48; i--) {
    if (candleSession(bars[i][0]) !== candleSession(latest?.[0] ?? '') || i < end - 2 && Date.parse(bars[i + 1][0]) - Date.parse(bars[i][0]) !== candleIntervalMs(interval)) break
    history.unshift(bars[i])
  }
  const highs: AngelOneCandle[] = [], lows: AngelOneCandle[] = []
  for (let i = 2; i < history.length - 2; i++) {
    const neighbours = [...history.slice(i - 2, i), ...history.slice(i + 1, i + 3)]
    if (neighbours.every(bar => history[i][2] > bar[2])) highs.push(history[i])
    if (neighbours.every(bar => history[i][3] < bar[3])) lows.push(history[i])
  }
  const high = highs[highs.length - 1], low = lows[lows.length - 1], oldHigh = highs[highs.length - 2], oldLow = lows[lows.length - 2]
  const lowerHigh = high && oldHigh && high[2] < oldHigh[2] - buffer, lowerLow = low && oldLow && low[3] < oldLow[3] - buffer
  const higherHigh = high && oldHigh && high[2] > oldHigh[2] + buffer, higherLow = low && oldLow && low[3] > oldLow[3] + buffer
  const priorOpposite = Boolean(side === 'CALL' ? lowerHigh && (lowerLow || higherLow && lows.length >= 3 && lows[lows.length - 2][3] < lows[lows.length - 3][3] - buffer)
    : higherLow && (higherHigh || lowerHigh && highs.length >= 3 && highs[highs.length - 2][2] > highs[highs.length - 3][2] + buffer))
  const structureLevel = side === 'CALL' ? high?.[2] : low?.[3], invalidationLevel = side === 'CALL' ? low?.[3] : high?.[2]
  const structureBreak = ready && priorOpposite && structureLevel !== undefined && invalidationLevel !== undefined
    && d * (previous[4] - structureLevel) > buffer && d * (latest[4] - structureLevel) > buffer
    && d * (bars[end - 2][4] - structureLevel) <= buffer
    && (side === 'CALL' ? latest[3] >= structureLevel - tolerance : latest[2] <= structureLevel + tolerance)
    && previous[2] - previous[3] <= 2 * atr! && d * (latest[4] - invalidationLevel) > 0
  const continuationFamily = acceptedBreak ? 'ACCEPTED_BREAK' : pullback ? 'PULLBACK' : undefined
  // EMA ordering is mandatory only in EMA mode. RSI/Supertrend modes must not
  // silently inherit a second indicator veto; opposing price structure still blocks them.
  const oppositeEma = indicator === 'EMA20_50' && ready && d * (ema! - point.ema50!) < 0
  const setupType = structureBreak ? 'REVERSAL' : continuationFamily && !priorOpposite && !oppositeEma ? 'CONTINUATION' : 'TRANSITION'
  const family = structureBreak ? 'STRUCTURE_REVERSAL' : setupType === 'CONTINUATION' ? continuationFamily : undefined
  const regimeBars = regimeCandles ?? (interval === 'FIFTEEN_MINUTE' ? candles : interval === 'FIVE_MINUTE' ? higherCandles ?? aggregateConfirmationCandles(candles, interval, 'FIFTEEN_MINUTE', instrument, signalClose) : [])
  const adaptive = deriveAdaptiveThresholds({ candles: regimeBars, instrument, now: signalClose, side, reversal: setupType === 'REVERSAL', higherAligned: !higherInterval || higherBias === side, mode: thresholdMode })
  add('HIGHER_TREND', 'Higher timeframe trend', !higherInterval || higherBias !== 'UNAVAILABLE' && (setupType === 'REVERSAL' || higherBias === side || higherBias === 'NEUTRAL'), higherInterval ? `${higherInterval}: ${higherBias}${higherAsOf ? ` · closed input ${higherAsOf}` : ''}; continuation cannot oppose it; a proven reversal may, with stricter scores. Missing history never qualifies.` : 'Hourly setup uses its own completed trend; no synthetic higher timeframe is invented')
  const trend = ready && !adaptive.blocked && (setupType === 'REVERSAL' ? structureBreak : setupType === 'CONTINUATION' && finite(current?.adx14) && current.adx14 >= adaptive.minimumAdx)
  add('TREND_REGIME', 'Setup regime', Boolean(trend), `${setupType} · ${adaptive.regime} · ADX ${current?.adx14?.toFixed(1) ?? 'unavailable'}${setupType === 'REVERSAL' ? '; confirmed opposing-structure break replaces the continuation ADX floor' : ` / ${adaptive.minimumAdx} required`}. ${adaptive.reason} A slope turn alone is insufficient.`)
  add('PRICE_ACCEPTANCE', 'Accepted breakout or pullback', Boolean(family), family === 'STRUCTURE_REVERSAL' ? `Prior opposing swings broken at ${structureLevel!.toFixed(2)}; two completed accepting closes; invalidation ${invalidationLevel!.toFixed(2)}` : family === 'ACCEPTED_BREAK' ? `Two completed closes beyond prior ${confirmationRules.breakLookback}-bar level ${level!.toFixed(2)}, without a failed retest` : family === 'PULLBACK' ? 'Actual counter-direction pullback to EMA20 followed by a completed break of the preceding candle' : 'Wait for an accepted continuation or confirmed reversal of opposing swings. A slope change or single impulse is insufficient.')
  const emaSlope = finite(older?.ema20) && finite(ema) ? d * (ema - older.ema20) : undefined
  const oldEma = averages[end - 6]?.ema20
  const continuous = (lookback: number) => end >= lookback && bars.slice(end - lookback).every((bar, i, tail) => candleSession(bar[0]) === candleSession(latest[0]) && (!i || Date.parse(bar[0]) - Date.parse(tail[i - 1][0]) === candleIntervalMs(interval)))
  const emaConfirm = ready && continuous(setupType === 'REVERSAL' ? 6 : 3) && finite(emaSlope) && emaSlope > 0 && d * (latest[4] - ema!) > 0
    && (setupType === 'REVERSAL' ? finite(oldEma) && d * (older!.ema20! - oldEma) <= 0 : d * (ema! - point.ema50!) > 0)
  const rsiConfirm = ready && continuous(setupType === 'REVERSAL' ? 6 : 1) && finite(current?.rsi14) && finite(points[end - 1]?.rsi14) && d * (current.rsi14 - points[end - 1].rsi14!) > 0
    && (setupType === 'REVERSAL' ? finite(points[end - 3]?.rsi14) && finite(points[end - 6]?.rsi14)
      && d * (current.rsi14 - points[end - 3].rsi14!) > 0 && d * (points[end - 3].rsi14! - points[end - 6].rsi14!) <= 0 : d * (current.rsi14 - 50) > 0)
  const supertrendConfirm = ready && current?.supertrendDirection === (side === 'CALL' ? 'UP' : 'DOWN')
  const indicatorConfirm = indicator === 'EMA20_50' ? emaConfirm : indicator === 'RSI14' ? rsiConfirm : indicator === 'SUPERTREND' ? supertrendConfirm : false
  add('MOMENTUM_CONFIRMATION', 'Selected indicator', Boolean(indicatorConfirm), `${indicator} explicitly selected. ${setupType === 'REVERSAL' ? 'Require its momentum turn; EMA crossover is not required. Supertrend mode waits for its direction to agree.' : 'EMA mode needs price/EMA20/EMA50 and positive slope; RSI mode needs the directional side of 50 and rising/falling momentum; Supertrend mode needs matching direction.'} No automatic indicator substitution.`)
  const volumeBars = bars.slice(-confirmationRules.volumeLookback - 1, -1).filter(bar => bar[5] > 0), baseline = volumeBars.length ? volumeBars.reduce((sum, bar) => sum + bar[5], 0) / volumeBars.length : 0
  const relativeVolume = baseline > 0 && latest ? latest[5] / baseline : undefined
  const threshold = family === 'PULLBACK' ? confirmationRules.pullbackRelativeVolume : confirmationRules.breakoutRelativeVolume
  add('PARTICIPATION', 'Traded-volume participation', !isCommodity(instrument) || volumeBars.length >= confirmationRules.minimumVolumeBars && relativeVolume !== undefined && relativeVolume >= threshold,
    isCommodity(instrument) ? `Actual contract volume / prior up-to-${confirmationRules.volumeLookback}-bar mean: ${relativeVolume?.toFixed(2) ?? 'unavailable'}× / ${threshold}×. No invented volume.` : 'Spot indices have no traded volume. Paired ATM option VWAP is checked separately; option volume is never relabelled as index volume.')
  const passed = checks.every(check => check.passed)
  return { policy: thresholdMode === 'FIXED' ? 'structure-confirmation-v2' : confirmationPolicy, adaptive, setupType, indicator, requiredScore: adaptive.minimumScore,
    requiredLead: adaptive.minimumLead, structureLevel, invalidationLevel, asOf, passed, reason: passed ? `${family} price/regime confirmation passed.` : checks.find(check => !check.passed)!.detail, side, family, adx: round(current?.adx14), atr14: round(atr), rsi14: round(current?.rsi14), ema20: round(ema), ema50: round(point?.ema50), extensionAtr: round(extension), relativeVolume: round(relativeVolume), higherInterval, higherAsOf, higherBias, checks }
}
