import type { AngelOneCandle } from '../api/angelOne'
import { calculateMovingAverageSeries } from './movingAverages'
import { calculateTechnicalIndicatorSeries } from './technicalIndicators'

/**
 * 5-minute OHLC price-action AI agent.
 *
 * IMPORTANT:
 * - Uses candle OHLC + timestamps and SMA(20), EMA(50), RSI(14), Supertrend(10,3).
 * - No MACD, VWAP, volume or other indicator.
 * - The "agent" is a deterministic, explainable price-action engine.
 * - It never treats one candle pattern as a standalone signal.
 * - The live/incomplete candle is excluded from decisions.
 */

export type PriceActionInterval =
  | 'FIVE_MINUTE'
  | 'FIFTEEN_MINUTE'
  | 'ONE_HOUR'

export type PriceActionSide = 'CALL' | 'PUT' | 'WAIT'

export type PriceActionPhase =
  | 'UPTREND'
  | 'DOWNTREND'
  | 'RANGE'
  | 'TRANSITION'
  | 'INSUFFICIENT_DATA'

export type PriceActionPattern =
  | 'BREAKOUT_RETEST'
  | 'BREAKDOWN_RETEST'
  | 'BULLISH_SUPPORT_REJECTION'
  | 'BEARISH_RESISTANCE_REJECTION'
  | 'BULLISH_PULLBACK_CONTINUATION'
  | 'BEARISH_PULLBACK_CONTINUATION'
  | 'RANGE_LOW_REJECTION'
  | 'RANGE_HIGH_REJECTION'
  | 'BULLISH_FALSE_BREAKDOWN'
  | 'BEARISH_FALSE_BREAKOUT'
  | 'COMPRESSION_BREAKOUT'
  | 'NO_CONFIRMED_PATTERN'

export type PriceActionAnalysis = {
  side: PriceActionSide
  phase: PriceActionPhase
  structure: string
  structureEvent: string
  location: string
  candleBehavior: string
  pattern: PriceActionPattern
  setup: string
  reason: string

  entry?: number
  stopLoss?: number
  target?: number
  target2?: number
  riskReward?: number

  support?: number
  resistance?: number
  previousDayHigh?: number
  previousDayLow?: number
  previousDayClose?: number
  todayHigh?: number
  todayLow?: number
  movingAverage20?: number
  exponentialMovingAverage20?: number
  exponentialMovingAverage50?: number
  rsi14Momentum?: number
  rsi14?: number
  supertrend10?: number
  supertrendDirection?: 'UP' | 'DOWN'

  confidence: number
  confluence: string[]
  warnings: string[]
  invalidation: string

  earlyBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  earlyStage: 'EARLY' | 'TRIGGER' | 'CONFIRMED' | 'NEUTRAL'
  earlyStrength: 'NO_BIAS' | 'WEAK' | 'CONFLICTED' | 'EARLY' | 'STRONG_EARLY' | 'HIGH_CONVICTION' | 'EXTREME'
  bullishScore: number
  bearishScore: number
  bullishEvidence: string[]
  bearishEvidence: string[]
  tradeStatus: string
  currentPrice?: number
  distanceToBullishTrigger?: number
  distanceToBearishTrigger?: number
  bullishTrigger?: number
  bearishTrigger?: number
  bullishInvalidation?: number
  bearishInvalidation?: number

  analyzedCandles: number
  latestCandleTime?: string
}

const intervalMilliseconds: Record<PriceActionInterval, number> = {
  FIVE_MINUTE: 5 * 60 * 1000,
  FIFTEEN_MINUTE: 15 * 60 * 1000,
  ONE_HOUR: 60 * 60 * 1000,
}

type OHLC = {
  time: number
  open: number
  high: number
  low: number
  close: number
}

type Swing = {
  index: number
  price: number
}

type Level = {
  price: number
  touches: number
  source: string
}

type Candidate = {
  side: Exclude<PriceActionSide, 'WAIT'>
  pattern: PriceActionPattern
  setup: string
  reason: string
  entry: number
  stopLoss: number
  target: number
  target2?: number
  score: number
  confluence: string[]
  invalidation: string
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function toOHLC(candle: AngelOneCandle): OHLC | undefined {
  const time = new Date(candle[0]).getTime()
  const open = Number(candle[1])
  const high = Number(candle[2])
  const low = Number(candle[3])
  const close = Number(candle[4])

  if (![time, open, high, low, close].every(finite)) return undefined
  if (high < Math.max(open, close)) return undefined
  if (low > Math.min(open, close)) return undefined
  if (high < low) return undefined

  return { time, open, high, low, close }
}

function body(candle: OHLC): number {
  return Math.abs(candle.close - candle.open)
}

function range(candle: OHLC): number {
  return Math.max(0, candle.high - candle.low)
}

function upperWick(candle: OHLC): number {
  return candle.high - Math.max(candle.open, candle.close)
}

function lowerWick(candle: OHLC): number {
  return Math.min(candle.open, candle.close) - candle.low
}

function closeLocation(candle: OHLC): number {
  const r = range(candle)
  return r > 0 ? (candle.close - candle.low) / r : 0.5
}

function averageRange(candles: OHLC[], count: number, endExclusive = candles.length): number {
  const start = Math.max(0, endExclusive - count)
  const sample = candles.slice(start, endExclusive)
  if (!sample.length) return 0
  return sample.reduce((sum, candle) => sum + range(candle), 0) / sample.length
}

function candleBehavior(candle: OHLC): string {
  const r = range(candle)
  if (r <= 0) return 'Indecisive candle'

  const b = body(candle)
  const br = b / r
  const upper = upperWick(candle)
  const lower = lowerWick(candle)
  const closePos = closeLocation(candle)

  if (br <= 0.10) return 'Doji / strong indecision'

  if (
    candle.close > candle.open &&
    br >= 0.65 &&
    closePos >= 0.80 &&
    upper / r <= 0.20
  ) {
    return 'Strong bullish close'
  }

  if (
    candle.close < candle.open &&
    br >= 0.65 &&
    closePos <= 0.20 &&
    lower / r <= 0.20
  ) {
    return 'Strong bearish close'
  }

  if (lower >= Math.max(b * 1.5, r * 0.30) && closePos >= 0.55) {
    return 'Lower-wick rejection / hammer-type candle'
  }

  if (upper >= Math.max(b * 1.5, r * 0.30) && closePos <= 0.45) {
    return 'Upper-wick rejection / shooting-star-type candle'
  }

  if (candle.close > candle.open) return 'Mixed bullish candle'
  if (candle.close < candle.open) return 'Mixed bearish candle'
  return 'Neutral candle'
}

function findSwings(candles: OHLC[], type: 'HIGH' | 'LOW', strength = 2): Swing[] {
  const swings: Swing[] = []

  for (
    let index = strength;
    index < candles.length - strength;
    index += 1
  ) {
    const price =
      type === 'HIGH' ? candles[index].high : candles[index].low

    const left = candles.slice(index - strength, index)
    const right = candles.slice(index + 1, index + strength + 1)

    const isSwing =
      left.every((candle) =>
        type === 'HIGH'
          ? price >= candle.high
          : price <= candle.low,
      ) &&
      right.every((candle) =>
        type === 'HIGH'
          ? price >= candle.high
          : price <= candle.low,
      )

    if (isSwing) swings.push({ index, price })
  }

  return swings
}

function dedupeLevels(
  swings: Swing[],
  tolerance: number,
  source: string,
): Level[] {
  const levels: Level[] = []

  for (const swing of swings) {
    const existing = levels.find(
      (level) => Math.abs(level.price - swing.price) <= tolerance,
    )

    if (existing) {
      existing.price = (existing.price + swing.price) / 2
      existing.touches += 1
    } else {
      levels.push({
        price: swing.price,
        touches: 1,
        source,
      })
    }
  }

  return levels
}

function nearestBelow(
  price: number,
  levels: Level[],
): Level | undefined {
  return levels
    .filter((level) => level.price < price)
    .sort((a, b) => b.price - a.price)[0]
}

function nearestAbove(
  price: number,
  levels: Level[],
): Level | undefined {
  return levels
    .filter((level) => level.price > price)
    .sort((a, b) => a.price - b.price)[0]
}

function previousSessionLevels(candles: OHLC[]) {
  if (!candles.length) {
    return {
      previousDayHigh: undefined,
      previousDayLow: undefined,
      previousDayClose: undefined,
      todayHigh: undefined,
      todayLow: undefined,
    }
  }

  const latestDate = new Date(candles[candles.length - 1].time)
  const todayKey = `${latestDate.getFullYear()}-${latestDate.getMonth()}-${latestDate.getDate()}`

  const today = candles.filter((candle) => {
    const d = new Date(candle.time)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === todayKey
  })

  const previous = candles.filter((candle) => {
    const d = new Date(candle.time)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` !== todayKey
  })

  const previousDayKey = previous.length
    ? (() => {
        const d = new Date(previous[previous.length - 1].time)
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      })()
    : undefined

  const previousDay = previousDayKey
    ? previous.filter((candle) => {
        const d = new Date(candle.time)
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === previousDayKey
      })
    : []

  return {
    previousDayHigh: previousDay.length
      ? Math.max(...previousDay.map((candle) => candle.high))
      : undefined,
    previousDayLow: previousDay.length
      ? Math.min(...previousDay.map((candle) => candle.low))
      : undefined,
    previousDayClose: previousDay.length
      ? previousDay[previousDay.length - 1].close
      : undefined,
    todayHigh: today.length
      ? Math.max(...today.map((candle) => candle.high))
      : undefined,
    todayLow: today.length
      ? Math.min(...today.map((candle) => candle.low))
      : undefined,
  }
}

function structureState(
  highs: Swing[],
  lows: Swing[],
): {
  phase: PriceActionPhase
  structure: string
  event: string
  bullish: boolean
  bearish: boolean
} {
  const lastHighs = highs.slice(-3)
  const lastLows = lows.slice(-3)

  if (lastHighs.length < 2 || lastLows.length < 2) {
    return {
      phase: 'INSUFFICIENT_DATA',
      structure: 'Not enough confirmed swing points',
      event: 'Waiting for more structure',
      bullish: false,
      bearish: false,
    }
  }

  const hh =
    lastHighs[lastHighs.length - 1].price >
    lastHighs[lastHighs.length - 2].price

  const hl =
    lastLows[lastLows.length - 1].price >
    lastLows[lastLows.length - 2].price

  const lh =
    lastHighs[lastHighs.length - 1].price <
    lastHighs[lastHighs.length - 2].price

  const ll =
    lastLows[lastLows.length - 1].price <
    lastLows[lastLows.length - 2].price

  if (hh && hl) {
    return {
      phase: 'UPTREND',
      structure: 'Higher High + Higher Low',
      event: 'Bullish structure intact',
      bullish: true,
      bearish: false,
    }
  }

  if (lh && ll) {
    return {
      phase: 'DOWNTREND',
      structure: 'Lower High + Lower Low',
      event: 'Bearish structure intact',
      bullish: false,
      bearish: true,
    }
  }

  const lastHigh = lastHighs[lastHighs.length - 1].price
  const previousHigh = lastHighs[lastHighs.length - 2].price
  const lastLow = lastLows[lastLows.length - 1].price
  const previousLow = lastLows[lastLows.length - 2].price

  if (lastHigh > previousHigh && lastLow <= previousLow) {
    return {
      phase: 'TRANSITION',
      structure: 'Bullish attempt / mixed structure',
      event: 'Higher high without confirmed higher low',
      bullish: false,
      bearish: false,
    }
  }

  if (lastHigh <= previousHigh && lastLow < previousLow) {
    return {
      phase: 'TRANSITION',
      structure: 'Bearish attempt / mixed structure',
      event: 'Lower low without confirmed lower high',
      bullish: false,
      bearish: false,
    }
  }

  return {
    phase: 'RANGE',
    structure: 'Overlapping / range structure',
    event: 'No clean HH-HL or LH-LL sequence',
    bullish: false,
    bearish: false,
  }
}

function isBullishEngulfing(previous: OHLC, latest: OHLC): boolean {
  return (
    previous.close < previous.open &&
    latest.close > latest.open &&
    latest.open <= previous.close &&
    latest.close >= previous.open &&
    body(latest) > body(previous)
  )
}

function isBearishEngulfing(previous: OHLC, latest: OHLC): boolean {
  return (
    previous.close > previous.open &&
    latest.close < latest.open &&
    latest.open >= previous.close &&
    latest.close <= previous.open &&
    body(latest) > body(previous)
  )
}

function isInsideBar(previous: OHLC, latest: OHLC): boolean {
  return latest.high <= previous.high && latest.low >= previous.low
}

function isCompression(candles: OHLC[]): boolean {
  if (candles.length < 15) return false

  const recent = averageRange(candles, 5)
  const prior = averageRange(candles, 10, candles.length - 5)

  return prior > 0 && recent <= prior * 0.70
}

function isExpansion(candles: OHLC[]): boolean {
  if (candles.length < 12) return false

  const latest = candles[candles.length - 1]
  const prior = averageRange(candles, 10, candles.length - 1)

  return prior > 0 && range(latest) >= prior * 1.35
}

function earlyMoveOutlook(
  candles: OHLC[],
  phase: PriceActionPhase,
  highs: Swing[],
  lows: Swing[],
  support: number | undefined,
  resistance: number | undefined,
  tolerance: number,
  buffer: number,
  compression: boolean,
  priorRangeHigh: number | undefined,
  priorRangeLow: number | undefined,
  sma20: number | undefined,
  ema20: number | undefined,
  ema50: number | undefined,
  ema20Slope: number | undefined,
  rsi14: number | undefined,
  rsi14Momentum: number | undefined,
  supertrendDirection: 'UP' | 'DOWN' | undefined,
  tradeReadySide?: Exclude<PriceActionSide, 'WAIT'>,
  confirmedSetup = false,
): Pick<PriceActionAnalysis,
  'earlyBias' | 'earlyStage' | 'bullishScore' | 'bearishScore' |
  'earlyStrength' | 'bullishEvidence' | 'bearishEvidence' | 'tradeStatus' |
  'currentPrice' | 'distanceToBullishTrigger' | 'distanceToBearishTrigger' |
  'bullishTrigger' | 'bearishTrigger' | 'bullishInvalidation' | 'bearishInvalidation'> {
  let bullish = 0
  let bearish = 0
  const bullishEvidence: string[] = []
  const bearishEvidence: string[] = []
  const addEvidence = (signedStrength: number, weight: number, bullishReason: string, bearishReason: string) => {
    const strength = Math.max(-1, Math.min(1, signedStrength))
    if (strength > 0.08) {
      bullish += weight * strength
      if (strength >= 0.2) bullishEvidence.push(bullishReason)
    } else if (strength < -0.08) {
      bearish += weight * -strength
      if (strength <= -0.2) bearishEvidence.push(bearishReason)
    }
  }
  const clamp = (value: number, minimum = -1, maximum = 1) => Math.max(minimum, Math.min(maximum, value))
  const recent = candles.slice(-5)
  const earlier = candles.slice(-10, -5)
  const avg = (items: OHLC[], pick: (candle: OHLC) => number) =>
    items.length ? items.reduce((sum, candle) => sum + pick(candle), 0) / items.length : 0.5
  const closePressure = avg(recent, closeLocation) - 0.5
  const signedBodyPressure = avg(recent, (candle) => {
    const candleRange = range(candle)
    return candleRange > 0 ? (candle.close > candle.open ? 1 : candle.close < candle.open ? -1 : 0) * body(candle) / candleRange : 0
  })
  const recentCloseLocation = avg(recent, closeLocation)
  const earlierCloseLocation = avg(earlier, closeLocation)
  const pressureChange = recentCloseLocation - earlierCloseLocation

  // 30%: confirmed swing structure.
  let structureDirection = phase === 'UPTREND' ? 1 : phase === 'DOWNTREND' ? -1 : 0
  const lastLows = lows.slice(-3)
  const lastHighs = highs.slice(-3)
  const risingLows = lastLows.length >= 2 && lastLows[lastLows.length - 1].price > lastLows[lastLows.length - 2].price
  const fallingLows = lastLows.length >= 2 && lastLows[lastLows.length - 1].price < lastLows[lastLows.length - 2].price
  const risingHighs = lastHighs.length >= 2 && lastHighs[lastHighs.length - 1].price > lastHighs[lastHighs.length - 2].price
  const fallingHighs = lastHighs.length >= 2 && lastHighs[lastHighs.length - 1].price < lastHighs[lastHighs.length - 2].price
  if (phase === 'TRANSITION') {
    structureDirection = (Number(risingHighs) + Number(risingLows) - Number(fallingHighs) - Number(fallingLows)) / 2
  }
  addEvidence(structureDirection, 30, 'Higher highs / higher lows support bullish structure', 'Lower highs / lower lows support bearish structure')

  // 20%: close strength, signed body force and whether candle pressure is improving.
  const candleMomentum = clamp(closePressure * 1.4 + signedBodyPressure * 0.4 + pressureChange * 1.5)
  addEvidence(candleMomentum, 20, 'Recent candles are closing stronger with bullish pressure increasing', 'Recent candles are closing weaker with bearish pressure increasing')
  const priorBearBody = avg(earlier, (candle) => candle.close < candle.open ? body(candle) : 0)
  const recentBearBody = avg(recent, (candle) => candle.close < candle.open ? body(candle) : 0)
  const priorBullBody = avg(earlier, (candle) => candle.close > candle.open ? body(candle) : 0)
  const recentBullBody = avg(recent, (candle) => candle.close > candle.open ? body(candle) : 0)
  const weakeningSelling = priorBearBody > 0 && recentBearBody < priorBearBody * 0.65 && closePressure >= 0
  const weakeningBuying = priorBullBody > 0 && recentBullBody < priorBullBody * 0.65 && closePressure <= 0
  if (weakeningSelling) bullishEvidence.push('Recent selling candles are shrinking; downside pressure is easing')
  if (weakeningBuying) bearishEvidence.push('Recent buying candles are shrinking; upside pressure is easing')

  // 15%: price, SMA/EMA ordering and short EMA slope.
  const latest = candles[candles.length - 1]
  let maDirection = 0
  let maFactors = 0
  if (ema20 !== undefined && latest) {
    maDirection += latest.close > ema20 ? 1 : latest.close < ema20 ? -1 : 0
    maFactors += 1
  }
  if (ema20 !== undefined && sma20 !== undefined) {
    maDirection += ema20 > sma20 ? 1 : ema20 < sma20 ? -1 : 0
    maFactors += 1
  }
  if (ema20 !== undefined && ema50 !== undefined) {
    maDirection += ema20 > ema50 ? 1 : ema20 < ema50 ? -1 : 0
    maFactors += 1
  }
  if (ema20Slope !== undefined) {
    maDirection += ema20Slope > 0 ? 1 : ema20Slope < 0 ? -1 : 0
    maFactors += 1
  }
  const maSignal = maFactors ? maDirection / maFactors : 0
  addEvidence(maSignal, 15, 'Price/EMA/SMA alignment and EMA slope support the bullish trend', 'Price/EMA/SMA alignment and EMA slope support the bearish trend')

  // 10%: RSI level plus change over the last three closed candles.
  const rsiSignal = rsi14 !== undefined
    ? clamp(((rsi14 - 50) / 20) * 0.45 + (rsi14Momentum === undefined ? 0 : (rsi14Momentum / 12) * 0.55))
    : 0
  addEvidence(rsiSignal, 10, 'RSI(14) momentum is strengthening upward', 'RSI(14) momentum is weakening')

  // 10%: Supertrend confirms direction, but never drives the signal alone.
  addEvidence(supertrendDirection === 'UP' ? 1 : supertrendDirection === 'DOWN' ? -1 : 0, 10,
    'Supertrend is bullish', 'Supertrend is bearish')

  // 10%: repeated level tests, with higher lows favoring an upside break and lower highs favoring downside.
  const recentTen = candles.slice(-10)
  const resistanceTests = resistance === undefined ? 0 : recentTen.filter((candle) =>
    candle.high >= resistance - tolerance && candle.close <= resistance + tolerance,
  ).length
  const supportTests = support === undefined ? 0 : recentTen.filter((candle) =>
    candle.low <= support + tolerance && candle.close >= support - tolerance,
  ).length
  const resistancePressure = resistanceTests >= 2 ? (risingLows ? 0.65 : closePressure < 0 ? -0.65 : 0.25) * Math.min(1, resistanceTests / 3) : 0
  const supportPressure = supportTests >= 2 ? (fallingHighs ? -0.65 : closePressure > 0 ? 0.65 : -0.25) * Math.min(1, supportTests / 3) : 0
  const levelSignal = Math.abs(resistancePressure) > Math.abs(supportPressure) ? resistancePressure : supportPressure
  addEvidence(levelSignal, 10, 'Repeated resistance tests with rising lows favor an upside break', 'Repeated support tests with lower highs favor a downside break')

  // 5%: compression only adds direction when candle pressure provides a side.
  addEvidence(compression ? clamp(candleMomentum * 1.5) : 0, 5,
    'Range is compressing with bullish pressure building', 'Range is compressing with bearish pressure building')

  const breakoutUp = priorRangeHigh !== undefined && latest.close > priorRangeHigh && latest.close > latest.open
  const breakoutDown = priorRangeLow !== undefined && latest.close < priorRangeLow && latest.close < latest.open
  bullish = Math.min(100, Math.round(bullish))
  bearish = Math.min(100, Math.round(bearish))

  let earlyBias: PriceActionAnalysis['earlyBias'] = 'NEUTRAL'
  let earlyStage: PriceActionAnalysis['earlyStage'] = 'NEUTRAL'
  if (bullish >= 50 && bullish - bearish >= 15) {
    earlyBias = 'BULLISH'
  } else if (bearish >= 50 && bearish - bullish >= 15) {
    earlyBias = 'BEARISH'
  }

  if (confirmedSetup && tradeReadySide && earlyBias === (tradeReadySide === 'CALL' ? 'BULLISH' : 'BEARISH')) {
    earlyStage = 'CONFIRMED'
  } else if (breakoutUp && bullish >= 50 && bullish > bearish) {
    earlyStage = 'TRIGGER'
  } else if (breakoutDown && bearish >= 50 && bearish > bullish) {
    earlyStage = 'TRIGGER'
  } else if (earlyBias !== 'NEUTRAL') {
    earlyStage = 'EARLY'
  }

  const dominantScore = Math.max(bullish, bearish)
  const earlyStrength: PriceActionAnalysis['earlyStrength'] = earlyBias === 'NEUTRAL'
    ? dominantScore >= 50 ? 'CONFLICTED' : dominantScore >= 30 ? 'WEAK' : 'NO_BIAS'
    : dominantScore >= 90 ? 'EXTREME'
      : dominantScore >= 80 ? 'HIGH_CONVICTION'
        : dominantScore >= 65 ? 'STRONG_EARLY'
          : 'EARLY'

  const tradeStatus = tradeReadySide
    ? `${tradeReadySide} SETUP READY — risk/reward filter passed`
    : earlyBias !== 'NEUTRAL'
      ? `WAIT — ${earlyBias === 'BULLISH' ? 'upside breakout' : 'support breakdown'} confirmation pending`
      : breakoutUp || breakoutDown
        ? 'WAIT — breakout detected but directional evidence is not aligned'
        : 'WAIT — no clear directional edge'
  const bullishTrigger = priorRangeHigh !== undefined ? priorRangeHigh + buffer : resistance === undefined ? undefined : resistance + buffer
  const bearishTrigger = priorRangeLow !== undefined ? priorRangeLow - buffer : support === undefined ? undefined : support - buffer
  const currentPrice = latest?.close

  return {
    earlyBias,
    earlyStage,
    earlyStrength,
    bullishScore: bullish,
    bearishScore: bearish,
    bullishEvidence: [...new Set(bullishEvidence)],
    bearishEvidence: [...new Set(bearishEvidence)],
    tradeStatus,
    currentPrice,
    distanceToBullishTrigger: currentPrice !== undefined && bullishTrigger !== undefined ? Math.max(0, bullishTrigger - currentPrice) : undefined,
    distanceToBearishTrigger: currentPrice !== undefined && bearishTrigger !== undefined ? Math.max(0, currentPrice - bearishTrigger) : undefined,
    bullishTrigger,
    bearishTrigger,
    bullishInvalidation: lastLows.length ? lastLows[lastLows.length - 1].price - buffer : support === undefined ? undefined : support - buffer,
    bearishInvalidation: lastHighs.length ? lastHighs[lastHighs.length - 1].price + buffer : resistance === undefined ? undefined : resistance + buffer,
  }
}

function makeCandidate(
  candidate: Candidate,
  analyzedCandles: number,
  context: Omit<
    PriceActionAnalysis,
    'side' | 'setup' | 'reason' | 'entry' | 'stopLoss' |
    'target' | 'target2' | 'riskReward' | 'confidence' |
    'confluence' | 'invalidation' | 'analyzedCandles' |
    'pattern' | 'warnings' | 'earlyBias' | 'earlyStage' |
    'earlyStrength' | 'bullishEvidence' | 'bearishEvidence' | 'tradeStatus' |
    'bullishScore' | 'bearishScore' | 'bullishTrigger' | 'bearishTrigger' |
    'bullishInvalidation' | 'bearishInvalidation' | 'distanceToBullishTrigger' |
    'distanceToBearishTrigger' | 'currentPrice'
  >,
): PriceActionAnalysis {
  const risk = Math.abs(candidate.entry - candidate.stopLoss)
  const reward = Math.abs(candidate.target - candidate.entry)
  const rr = risk > 0 ? reward / risk : 0

  if (
    !Number.isFinite(risk) ||
    risk <= 0 ||
    !Number.isFinite(reward) ||
    reward <= 0 ||
    rr < 1.5
  ) {
    return {
      ...context,
      side: 'WAIT',
      pattern: 'NO_CONFIRMED_PATTERN',
      setup: 'No confirmed setup',
      reason:
        'A price-action setup exists, but the nearest valid target does not provide at least 1.5:1 reward-to-risk.',
      confidence: Math.min(candidate.score, 59),
      confluence: candidate.confluence,
      warnings: [
        'Risk/reward filter rejected the setup.',
        'Do not widen the stop only to manufacture a better-looking target.',
      ],
      invalidation: 'No trade until a valid structure and target are available.',
      earlyBias: 'NEUTRAL',
      earlyStage: 'NEUTRAL',
      earlyStrength: 'NO_BIAS',
      bullishScore: 0,
      bearishScore: 0,
      bullishEvidence: [],
      bearishEvidence: [],
      tradeStatus: 'WAIT — no confirmed setup',
      analyzedCandles,
    }
  }

  return {
    ...context,
    side: candidate.side,
    pattern: candidate.pattern,
    setup: candidate.setup,
    reason: candidate.reason,
    entry: candidate.entry,
    stopLoss: candidate.stopLoss,
    target: candidate.target,
    target2: candidate.target2,
    riskReward: rr,
    confidence: Math.min(99, Math.max(0, candidate.score)),
    confluence: candidate.confluence,
    warnings: [],
    invalidation: candidate.invalidation,
    earlyBias: 'NEUTRAL',
    earlyStage: 'NEUTRAL',
    earlyStrength: 'NO_BIAS',
    bullishScore: 0,
    bearishScore: 0,
    bullishEvidence: [],
    bearishEvidence: [],
    tradeStatus: `${candidate.side} SETUP READY — risk/reward filter passed`,
    analyzedCandles,
  }
}

export function analyzePriceAction(
  candles: AngelOneCandle[],
  interval: PriceActionInterval = 'FIVE_MINUTE',
  now = Date.now(),
): PriceActionAnalysis {
  const parsed = candles
    .map(toOHLC)
    .filter((candle): candle is OHLC => Boolean(candle))
    .filter(
      (candle) =>
        candle.time + intervalMilliseconds[interval] <= now,
    )
    .sort((a, b) => a.time - b.time)

  // Keep enough history to calculate structure, session levels and ranges.
  const completed = parsed.slice(-180)
  const movingAverageSeries = calculateMovingAverageSeries(completed.map((candle) => candle.close))
  const latestMovingAverages = movingAverageSeries[movingAverageSeries.length - 1]
  const indicatorSeries = calculateTechnicalIndicatorSeries(
    completed.map((candle) => candle.high),
    completed.map((candle) => candle.low),
    completed.map((candle) => candle.close),
  )
  const latestIndicators = indicatorSeries[indicatorSeries.length - 1]
  const threeCandlesAgoIndicators = indicatorSeries[Math.max(0, indicatorSeries.length - 4)]
  const threeCandlesAgoMovingAverages = movingAverageSeries[Math.max(0, movingAverageSeries.length - 4)]
  const latestMovingAverage20Slope = latestMovingAverages?.ema20 !== undefined && threeCandlesAgoMovingAverages?.ema20 !== undefined
    ? latestMovingAverages.ema20 - threeCandlesAgoMovingAverages.ema20
    : undefined
  const latestRsi14Momentum = latestIndicators?.rsi14 !== undefined && threeCandlesAgoIndicators?.rsi14 !== undefined
    ? latestIndicators.rsi14 - threeCandlesAgoIndicators.rsi14
    : undefined

  const empty = (
    reason: string,
    extra: Partial<PriceActionAnalysis> = {},
  ): PriceActionAnalysis => ({
    side: 'WAIT',
    phase: extra.phase ?? 'INSUFFICIENT_DATA',
    structure: extra.structure ?? 'Not established',
    structureEvent: extra.structureEvent ?? 'Waiting for more candles',
    location: extra.location ?? 'Not established',
    candleBehavior: extra.candleBehavior ?? 'Not available',
    pattern: 'NO_CONFIRMED_PATTERN',
    setup: 'No confirmed setup',
    reason,
    confidence: 0,
    confluence: [],
    warnings: extra.warnings ?? [],
    invalidation: 'No trade until the price-action structure is confirmed.',
    earlyBias: extra.earlyBias ?? 'NEUTRAL',
    earlyStage: extra.earlyStage ?? 'NEUTRAL',
    earlyStrength: extra.earlyStrength ?? 'NO_BIAS',
    bullishScore: extra.bullishScore ?? 0,
    bearishScore: extra.bearishScore ?? 0,
    bullishEvidence: extra.bullishEvidence ?? [],
    bearishEvidence: extra.bearishEvidence ?? [],
    tradeStatus: extra.tradeStatus ?? 'WAIT — no confirmed setup',
    movingAverage20: extra.movingAverage20 ?? latestMovingAverages?.sma20,
    exponentialMovingAverage20: extra.exponentialMovingAverage20 ?? latestMovingAverages?.ema20,
    exponentialMovingAverage50: extra.exponentialMovingAverage50 ?? latestMovingAverages?.ema50,
    rsi14: extra.rsi14 ?? latestIndicators?.rsi14,
    rsi14Momentum: extra.rsi14Momentum,
    supertrend10: extra.supertrend10 ?? latestIndicators?.supertrend10,
    supertrendDirection: extra.supertrendDirection ?? latestIndicators?.supertrendDirection,
    analyzedCandles: completed.length,
    latestCandleTime: completed.length
      ? new Date(completed[completed.length - 1].time).toISOString()
      : undefined,
    ...extra,
  })

  if (completed.length < 25) {
    return empty(
      `Waiting for at least 25 completed ${interval === 'FIVE_MINUTE' ? '5-minute' : interval} candles. The live/incomplete candle is excluded.`,
    )
  }

  const latest = completed[completed.length - 1]
  const previous = completed[completed.length - 2]

  const highs = findSwings(completed, 'HIGH', 2)
  const lows = findSwings(completed, 'LOW', 2)

  const structureStateResult = structureState(highs, lows)
  const {
    phase,
    structure,
    event: structureEvent,
  } = structureStateResult

  const avgRange = Math.max(averageRange(completed, 10), 0.000001)
  const tolerance = Math.max(
    avgRange * 0.25,
    latest.close * 0.00015,
  )
  const buffer = Math.max(
    avgRange * 0.08,
    latest.close * 0.00003,
  )

  const highLevels = dedupeLevels(highs.slice(-10), tolerance, 'Swing high')
  const lowLevels = dedupeLevels(lows.slice(-10), tolerance, 'Swing low')

  const supportLevel = nearestBelow(latest.close, lowLevels)
  const resistanceLevel = nearestAbove(latest.close, highLevels)

  const session = previousSessionLevels(completed)

  const allSupports: Level[] = [
    ...lowLevels,
    ...(session.previousDayLow !== undefined
      ? [{ price: session.previousDayLow, touches: 1, source: 'Previous day low' }]
      : []),
    ...(session.previousDayClose !== undefined && session.previousDayClose < latest.close
      ? [{ price: session.previousDayClose, touches: 1, source: 'Previous day close' }]
      : []),
  ]

  const allResistances: Level[] = [
    ...highLevels,
    ...(session.previousDayHigh !== undefined
      ? [{ price: session.previousDayHigh, touches: 1, source: 'Previous day high' }]
      : []),
    ...(session.previousDayClose !== undefined && session.previousDayClose > latest.close
      ? [{ price: session.previousDayClose, touches: 1, source: 'Previous day close' }]
      : []),
  ]

  const support =
    nearestBelow(latest.close, allSupports)?.price ??
    supportLevel?.price

  const resistance =
    nearestAbove(latest.close, allResistances)?.price ??
    resistanceLevel?.price

  const nearSupport =
    support !== undefined &&
    latest.low <= support + tolerance &&
    latest.close >= support - tolerance

  const nearResistance =
    resistance !== undefined &&
    latest.high >= resistance - tolerance &&
    latest.close <= resistance + tolerance

  const location = nearSupport
    ? 'At / near support'
    : nearResistance
      ? 'At / near resistance'
      : support !== undefined && resistance !== undefined
        ? 'Between support and resistance'
        : 'No nearby confirmed level'

  const behavior = candleBehavior(latest)
  const compression = isCompression(completed)
  const expansion = isExpansion(completed)

  const priorWindow = completed.slice(-22, -2)
  const priorRangeHigh = priorWindow.length
    ? Math.max(...priorWindow.map((candle) => candle.high))
    : undefined
  const priorRangeLow = priorWindow.length
    ? Math.min(...priorWindow.map((candle) => candle.low))
    : undefined

  const movingAverage20 = latestMovingAverages?.sma20
  const exponentialMovingAverage20 = latestMovingAverages?.ema20
  const exponentialMovingAverage50 = latestMovingAverages?.ema50
  const rsi14 = latestIndicators?.rsi14
  const rsi14Momentum = latestRsi14Momentum
  const supertrend10 = latestIndicators?.supertrend10
  const supertrendDirection = latestIndicators?.supertrendDirection

  const bullishClose = latest.close > latest.open
  const bearishClose = latest.close < latest.open

  const previousLowerRejection =
    lowerWick(previous) >= Math.max(body(previous) * 1.5, range(previous) * 0.30) &&
    closeLocation(previous) >= 0.55

  const previousUpperRejection =
    upperWick(previous) >= Math.max(body(previous) * 1.5, range(previous) * 0.30) &&
    closeLocation(previous) <= 0.45

  const previousClosedAboveRange =
    priorRangeHigh !== undefined &&
    previous.close > priorRangeHigh

  const previousClosedBelowRange =
    priorRangeLow !== undefined &&
    previous.close < priorRangeLow

  const latestRetestedBullishBreak =
    previousClosedAboveRange &&
    priorRangeHigh !== undefined &&
    latest.low <= priorRangeHigh + tolerance &&
    latest.close > priorRangeHigh &&
    bullishClose

  const latestRetestedBearishBreak =
    previousClosedBelowRange &&
    priorRangeLow !== undefined &&
    latest.high >= priorRangeLow - tolerance &&
    latest.close < priorRangeLow &&
    bearishClose

  const falseBreakdown =
    support !== undefined &&
    previous.low < support - tolerance &&
    previous.close >= support &&
    latest.close > previous.high

  const falseBreakout =
    resistance !== undefined &&
    previous.high > resistance + tolerance &&
    previous.close <= resistance &&
    latest.close < previous.low

  const bullishSupportRejection =
    nearSupport &&
    previousLowerRejection &&
    previous.close >= support! - tolerance &&
    bullishClose &&
    latest.close > previous.high

  const bearishResistanceRejection =
    nearResistance &&
    previousUpperRejection &&
    previous.close <= resistance! + tolerance &&
    bearishClose &&
    latest.close < previous.low

  const bullishEngulfing =
    nearSupport &&
    isBullishEngulfing(previous, latest)

  const bearishEngulfing =
    nearResistance &&
    isBearishEngulfing(previous, latest)

  const bullishPullback =
    phase === 'UPTREND' &&
    nearSupport &&
    bullishClose &&
    latest.close > previous.high

  const bearishPullback =
    phase === 'DOWNTREND' &&
    nearResistance &&
    bearishClose &&
    latest.close < previous.low

  const rangeLowRejection =
    phase === 'RANGE' &&
    nearSupport &&
    bullishClose &&
    latest.close > previous.high

  const rangeHighRejection =
    phase === 'RANGE' &&
    nearResistance &&
    bearishClose &&
    latest.close < previous.low

  const compressionBullishBreak =
    compression &&
    priorRangeHigh !== undefined &&
    latest.close > priorRangeHigh &&
    bullishClose

  const compressionBearishBreak =
    compression &&
    priorRangeLow !== undefined &&
    latest.close < priorRangeLow &&
    bearishClose

  const candidates: Candidate[] = []

  const addCandidate = (
    candidate: Candidate,
  ) => {
    if (
      candidate.entry > 0 &&
      candidate.stopLoss > 0 &&
      candidate.target > 0
    ) {
      candidates.push(candidate)
    }
  }

  // 1. Breakout + retest is deliberately given the highest priority.
  if (latestRetestedBullishBreak && priorRangeHigh !== undefined) {
    const entry = latest.close
    const stopLoss = Math.min(latest.low, priorRangeHigh) - buffer
    const target =
      resistance !== undefined && resistance > entry + buffer
        ? resistance
        : entry + Math.abs(entry - stopLoss) * 2

    addCandidate({
      side: 'CALL',
      pattern: 'BREAKOUT_RETEST',
      setup: 'Breakout + retest + bullish confirmation',
      reason:
        'Price closed above the recent range, retested the breakout level, and closed bullish again.',
      entry,
      stopLoss,
      target,
      target2: entry + Math.abs(entry - stopLoss) * 3,
      score: 88 + (expansion ? 5 : 0),
      confluence: [
        'Range breakout',
        'Successful retest',
        'Bullish close',
        ...(phase === 'UPTREND' ? ['Bullish market structure'] : []),
        ...(expansion ? ['Range expansion'] : []),
      ],
      invalidation:
        'A decisive 5-minute close back below the breakout level invalidates the setup.',
    })
  }

  if (latestRetestedBearishBreak && priorRangeLow !== undefined) {
    const entry = latest.close
    const stopLoss = Math.max(latest.high, priorRangeLow) + buffer
    const target =
      support !== undefined && support < entry - buffer
        ? support
        : entry - Math.abs(stopLoss - entry) * 2

    addCandidate({
      side: 'PUT',
      pattern: 'BREAKDOWN_RETEST',
      setup: 'Breakdown + retest + bearish confirmation',
      reason:
        'Price closed below the recent range, retested the breakdown level, and closed bearish again.',
      entry,
      stopLoss,
      target,
      target2: entry - Math.abs(stopLoss - entry) * 3,
      score: 88 + (expansion ? 5 : 0),
      confluence: [
        'Range breakdown',
        'Successful retest',
        'Bearish close',
        ...(phase === 'DOWNTREND' ? ['Bearish market structure'] : []),
        ...(expansion ? ['Range expansion'] : []),
      ],
      invalidation:
        'A decisive 5-minute close back above the breakdown level invalidates the setup.',
    })
  }

  // 2. False breaks are considered before ordinary rejection.
  if (falseBreakdown) {
    const entry = latest.close
    const stopLoss = Math.min(previous.low, support ?? previous.low) - buffer
    const target =
      resistance !== undefined && resistance > entry
        ? resistance
        : entry + Math.abs(entry - stopLoss) * 2

    addCandidate({
      side: 'CALL',
      pattern: 'BULLISH_FALSE_BREAKDOWN',
      setup: 'False breakdown + bullish confirmation',
      reason:
        'Price broke below support, recovered back above it, and the latest candle confirmed the recovery.',
      entry,
      stopLoss,
      target,
      score: 82,
      confluence: [
        'Failed breakdown',
        'Recovery above support',
        'Bullish confirmation',
      ],
      invalidation:
        'A 5-minute close back below the failed-break level invalidates the setup.',
    })
  }

  if (falseBreakout) {
    const entry = latest.close
    const stopLoss = Math.max(previous.high, resistance ?? previous.high) + buffer
    const target =
      support !== undefined && support < entry
        ? support
        : entry - Math.abs(stopLoss - entry) * 2

    addCandidate({
      side: 'PUT',
      pattern: 'BEARISH_FALSE_BREAKOUT',
      setup: 'False breakout + bearish confirmation',
      reason:
        'Price broke above resistance, failed to hold the breakout, and the latest candle confirmed the rejection.',
      entry,
      stopLoss,
      target,
      score: 82,
      confluence: [
        'Failed breakout',
        'Recovery below resistance',
        'Bearish confirmation',
      ],
      invalidation:
        'A 5-minute close back above the failed-break level invalidates the setup.',
    })
  }

  // 3. Support/resistance rejection.
  if (bullishSupportRejection || bullishEngulfing) {
    const entry = latest.close
    const stopLoss = Math.min(previous.low, support ?? previous.low) - buffer
    const target =
      resistance !== undefined && resistance > entry
        ? resistance
        : entry + Math.abs(entry - stopLoss) * 2

    addCandidate({
      side: 'CALL',
      pattern: 'BULLISH_SUPPORT_REJECTION',
      setup: bullishEngulfing
        ? 'Support + bullish engulfing confirmation'
        : 'Support rejection + two-candle confirmation',
      reason: bullishEngulfing
        ? 'Price reacted at support and the latest candle engulfed the prior bearish body.'
        : 'A lower-wick rejection at support was followed by a bullish close above the rejection candle.',
      entry,
      stopLoss,
      target,
      score: 78 + (bullishEngulfing ? 5 : 0),
      confluence: [
        'Support reaction',
        bullishEngulfing
          ? 'Bullish engulfing'
          : 'Lower-wick rejection',
        'Two-candle confirmation',
      ],
      invalidation:
        'A 5-minute close below the support/rejection low invalidates the setup.',
    })
  }

  if (bearishResistanceRejection || bearishEngulfing) {
    const entry = latest.close
    const stopLoss = Math.max(previous.high, resistance ?? previous.high) + buffer
    const target =
      support !== undefined && support < entry
        ? support
        : entry - Math.abs(stopLoss - entry) * 2

    addCandidate({
      side: 'PUT',
      pattern: 'BEARISH_RESISTANCE_REJECTION',
      setup: bearishEngulfing
        ? 'Resistance + bearish engulfing confirmation'
        : 'Resistance rejection + two-candle confirmation',
      reason: bearishEngulfing
        ? 'Price reacted at resistance and the latest candle engulfed the prior bullish body.'
        : 'An upper-wick rejection at resistance was followed by a bearish close below the rejection candle.',
      entry,
      stopLoss,
      target,
      score: 78 + (bearishEngulfing ? 5 : 0),
      confluence: [
        'Resistance reaction',
        bearishEngulfing
          ? 'Bearish engulfing'
          : 'Upper-wick rejection',
        'Two-candle confirmation',
      ],
      invalidation:
        'A 5-minute close above the resistance/rejection high invalidates the setup.',
    })
  }

  // 4. Trend pullback continuation.
  if (bullishPullback) {
    const entry = latest.close
    const stopLoss = Math.min(previous.low, support ?? previous.low) - buffer
    const target =
      resistance !== undefined && resistance > entry
        ? resistance
        : entry + Math.abs(entry - stopLoss) * 2

    addCandidate({
      side: 'CALL',
      pattern: 'BULLISH_PULLBACK_CONTINUATION',
      setup: 'Bullish trend pullback + confirmation',
      reason:
        'The 5-minute structure is bullish, price pulled into support, and the latest candle reclaimed the prior candle high.',
      entry,
      stopLoss,
      target,
      score: 76,
      confluence: [
        'HH + HL structure',
        'Pullback toward support',
        'Bullish confirmation',
      ],
      invalidation:
        'A 5-minute close below the latest confirmed higher-low area invalidates the continuation thesis.',
    })
  }

  if (bearishPullback) {
    const entry = latest.close
    const stopLoss = Math.max(previous.high, resistance ?? previous.high) + buffer
    const target =
      support !== undefined && support < entry
        ? support
        : entry - Math.abs(stopLoss - entry) * 2

    addCandidate({
      side: 'PUT',
      pattern: 'BEARISH_PULLBACK_CONTINUATION',
      setup: 'Bearish trend pullback + confirmation',
      reason:
        'The 5-minute structure is bearish, price pulled into resistance, and the latest candle broke the prior candle low.',
      entry,
      stopLoss,
      target,
      score: 76,
      confluence: [
        'LH + LL structure',
        'Pullback toward resistance',
        'Bearish confirmation',
      ],
      invalidation:
        'A 5-minute close above the latest confirmed lower-high area invalidates the continuation thesis.',
    })
  }

  // 5. Range-edge reactions.
  if (rangeLowRejection) {
    const entry = latest.close
    const stopLoss = Math.min(previous.low, support ?? previous.low) - buffer
    const target =
      resistance !== undefined && resistance > entry
        ? resistance
        : entry + Math.abs(entry - stopLoss) * 2

    addCandidate({
      side: 'CALL',
      pattern: 'RANGE_LOW_REJECTION',
      setup: 'Range low rejection + confirmation',
      reason:
        'Price is at the lower edge of a range and the latest candle confirmed rejection of lower prices.',
      entry,
      stopLoss,
      target,
      score: 72,
      confluence: [
        'Range environment',
        'Range low',
        'Bullish confirmation',
      ],
      invalidation:
        'A 5-minute close below the range low invalidates the setup.',
    })
  }

  if (rangeHighRejection) {
    const entry = latest.close
    const stopLoss = Math.max(previous.high, resistance ?? previous.high) + buffer
    const target =
      support !== undefined && support < entry
        ? support
        : entry - Math.abs(stopLoss - entry) * 2

    addCandidate({
      side: 'PUT',
      pattern: 'RANGE_HIGH_REJECTION',
      setup: 'Range high rejection + confirmation',
      reason:
        'Price is at the upper edge of a range and the latest candle confirmed rejection of higher prices.',
      entry,
      stopLoss,
      target,
      score: 72,
      confluence: [
        'Range environment',
        'Range high',
        'Bearish confirmation',
      ],
      invalidation:
        'A 5-minute close above the range high invalidates the setup.',
    })
  }

  // 6. Compression breakout.
  if (compressionBullishBreak) {
    const entry = latest.close
    const stopLoss = Math.min(previous.low, priorRangeHigh ?? previous.low) - buffer
    const target = entry + Math.abs(entry - stopLoss) * 2

    addCandidate({
      side: 'CALL',
      pattern: 'COMPRESSION_BREAKOUT',
      setup: 'Compression + bullish range expansion',
      reason:
        'Recent candle ranges contracted and price then expanded through the upper boundary with a bullish close.',
      entry,
      stopLoss,
      target,
      score: 74,
      confluence: [
        'Range compression',
        'Upside expansion',
        'Bullish close',
      ],
      invalidation:
        'A 5-minute close back inside the compressed range invalidates the breakout.',
    })
  }

  if (compressionBearishBreak) {
    const entry = latest.close
    const stopLoss = Math.max(previous.high, priorRangeLow ?? previous.high) + buffer
    const target = entry - Math.abs(entry - stopLoss) * 2

    addCandidate({
      side: 'PUT',
      pattern: 'COMPRESSION_BREAKOUT',
      setup: 'Compression + bearish range expansion',
      reason:
        'Recent candle ranges contracted and price then expanded through the lower boundary with a bearish close.',
      entry,
      stopLoss,
      target,
      score: 74,
      confluence: [
        'Range compression',
        'Downside expansion',
        'Bearish close',
      ],
      invalidation:
        'A 5-minute close back inside the compressed range invalidates the breakdown.',
    })
  }

  // Never manufacture a trade simply because a candle looks interesting.
  if (!candidates.length) {
    const outlook = earlyMoveOutlook(
      completed, phase, highs, lows, support, resistance, tolerance, buffer,
      compression, priorRangeHigh, priorRangeLow,
      movingAverage20, exponentialMovingAverage20, exponentialMovingAverage50,
      latestMovingAverage20Slope, rsi14, rsi14Momentum, supertrendDirection,
    )
    const warnings: string[] = []

    if (location === 'Between support and resistance') {
      warnings.push('Price is in the middle of the local range.')
    }

    if (isInsideBar(previous, latest)) {
      warnings.push('Latest candles are compressed inside the prior candle range.')
    }

    if (behavior.includes('Doji') || behavior.includes('indecision')) {
      warnings.push('Latest candle is indecisive.')
    }

    if (phase === 'TRANSITION' || phase === 'RANGE') {
      warnings.push('Market structure is not cleanly directional.')
    }

    if (compression) {
      warnings.push('Compression detected; wait for a confirmed range break.')
    }

    return empty(
      warnings.length
        ? warnings.join(' ')
        : 'No confirmed price-action setup. Wait for level interaction, breakout/retest, rejection, or structure confirmation.',
      {
        phase,
        structure,
        structureEvent,
        location,
        candleBehavior: behavior,
        support,
        resistance,
        previousDayHigh: session.previousDayHigh,
        previousDayLow: session.previousDayLow,
        previousDayClose: session.previousDayClose,
        todayHigh: session.todayHigh,
        todayLow: session.todayLow,
        warnings,
        movingAverage20,
        exponentialMovingAverage20,
        exponentialMovingAverage50,
        rsi14,
        rsi14Momentum,
        supertrend10,
        supertrendDirection,
        ...outlook,
      },
    )
  }

  const eligibleCandidates = candidates.filter((candidate) => {
    const risk = Math.abs(candidate.entry - candidate.stopLoss)
    const reward = Math.abs(candidate.target - candidate.entry)
    return risk > 0 && reward / risk >= 1.5
  })

  if (!eligibleCandidates.length) {
    const outlook = earlyMoveOutlook(
      completed, phase, highs, lows, support, resistance, tolerance, buffer,
      compression, priorRangeHigh, priorRangeLow,
      movingAverage20, exponentialMovingAverage20, exponentialMovingAverage50,
      latestMovingAverage20Slope, rsi14, rsi14Momentum, supertrendDirection,
    )
    return empty(
      'A price-action pattern was detected, but every candidate was rejected because its target offers less than 1.5:1 reward-to-risk.',
      {
        phase,
        structure,
        structureEvent,
        location,
        candleBehavior: behavior,
        support,
        resistance,
        previousDayHigh: session.previousDayHigh,
        previousDayLow: session.previousDayLow,
        previousDayClose: session.previousDayClose,
        todayHigh: session.todayHigh,
        todayLow: session.todayLow,
        warnings: [
          'Risk/reward filter rejected all detected setups (minimum 1.5:1).',
          'Do not widen the stop only to manufacture a better-looking target.',
        ],
        ...outlook,
        tradeStatus: 'WAIT — detected setup rejected by minimum 1.5:1 reward-to-risk filter',
        movingAverage20,
        exponentialMovingAverage20,
        exponentialMovingAverage50,
        rsi14,
        rsi14Momentum,
        supertrend10,
        supertrendDirection,
      },
    )
  }

  // Highest-quality candidate wins. The engine is deterministic and explainable.
  for (const candidate of eligibleCandidates) {
    const alignedBullish = candidate.side === 'CALL'
      && exponentialMovingAverage20 !== undefined
      && movingAverage20 !== undefined
      && exponentialMovingAverage50 !== undefined
      && latest.close > exponentialMovingAverage20
      && exponentialMovingAverage20 > movingAverage20
      && exponentialMovingAverage20 > exponentialMovingAverage50
    const alignedBearish = candidate.side === 'PUT'
      && exponentialMovingAverage20 !== undefined
      && movingAverage20 !== undefined
      && exponentialMovingAverage50 !== undefined
      && latest.close < exponentialMovingAverage20
      && exponentialMovingAverage20 < movingAverage20
      && exponentialMovingAverage20 < exponentialMovingAverage50
    if (alignedBullish || alignedBearish) {
      candidate.score += 5
      candidate.confluence.push(alignedBullish ? 'Price above EMA(20) above SMA(20) and EMA(50)' : 'Price below EMA(20) below SMA(20) and EMA(50)')
    }

    const trendAligned = candidate.side === 'CALL'
      ? supertrendDirection === 'UP'
      : supertrendDirection === 'DOWN'
    if (trendAligned) {
      candidate.score += 6
      candidate.confluence.push(`Supertrend(10,3) ${supertrendDirection?.toLowerCase()} trend`)
    }

    const momentumAligned = candidate.side === 'CALL'
      ? rsi14 !== undefined && rsi14 >= 55 && rsi14 < 75
      : rsi14 !== undefined && rsi14 <= 45 && rsi14 > 25
    if (momentumAligned) {
      candidate.score += 4
      candidate.confluence.push(`RSI(14) supports ${candidate.side === 'CALL' ? 'bullish' : 'bearish'} momentum`)
    }
  }

  eligibleCandidates.sort((a, b) => {
    const rrA =
      Math.abs(a.entry - a.stopLoss) > 0
        ? Math.abs(a.target - a.entry) / Math.abs(a.entry - a.stopLoss)
        : 0

    const rrB =
      Math.abs(b.entry - b.stopLoss) > 0
        ? Math.abs(b.target - b.entry) / Math.abs(b.entry - b.stopLoss)
        : 0

    return (b.score + Math.min(rrB, 3) * 2) - (a.score + Math.min(rrA, 3) * 2)
  })

  const selected = eligibleCandidates[0]

  const context = {
    phase,
    structure,
    structureEvent,
    location,
    candleBehavior: behavior,
    support,
    resistance,
    previousDayHigh: session.previousDayHigh,
    previousDayLow: session.previousDayLow,
    previousDayClose: session.previousDayClose,
    todayHigh: session.todayHigh,
    todayLow: session.todayLow,
    movingAverage20,
    exponentialMovingAverage20,
    exponentialMovingAverage50,
    rsi14,
    rsi14Momentum,
    supertrend10,
    supertrendDirection,
    latestCandleTime: new Date(latest.time).toISOString(),
  }

  const result = makeCandidate(
    selected,
    completed.length,
    context,
  )
  const confirmedPattern = [
    'BREAKOUT_RETEST',
    'BREAKDOWN_RETEST',
    'BULLISH_FALSE_BREAKDOWN',
    'BEARISH_FALSE_BREAKOUT',
  ].includes(selected.pattern)
  Object.assign(
    result,
    earlyMoveOutlook(
      completed,
      phase,
      highs,
      lows,
      support,
      resistance,
      tolerance,
      buffer,
      compression,
      priorRangeHigh,
      priorRangeLow,
      movingAverage20,
      exponentialMovingAverage20,
      exponentialMovingAverage50,
      latestMovingAverage20Slope,
      rsi14,
      rsi14Momentum,
      supertrendDirection,
      selected.side,
      confirmedPattern,
    ),
  )

  // Attach context warnings without hiding the actual decision.
  result.warnings = [
    ...(compression && !selected.pattern.includes('COMPRESSION')
      ? ['Compression exists nearby; avoid chasing late entries.']
      : []),
    ...(phase === 'TRANSITION'
      ? ['Structure is transitional; confidence is reduced.']
      : []),
    ...(isInsideBar(previous, latest)
      ? ['Latest candle is an inside bar; wait for a clean break if price stalls.']
      : []),
  ]

  return result
}

/**
 * Convenience API for the user's requested pure 5-minute agent.
 */
export function analyzeFiveMinutePriceAction(
  candles: AngelOneCandle[],
  now = Date.now(),
): PriceActionAnalysis {
  return analyzePriceAction(candles, 'FIVE_MINUTE', now)
}
