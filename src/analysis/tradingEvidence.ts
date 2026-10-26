import { scoreDominates } from './scoreTrajectory'
import { atmVwapContext, type AtmVwapSnapshot } from '../api/atmVwap'
import { findRiskyLevelSetup, type RiskyLevelSetup } from './riskyLevelSetup'
import { cachedHistoricalOutcomes, type HistoricalOutcomes } from './historicalOutcomes'
import type { AngelOneCandle } from '../api/angelOne'
import type { IndiaVixSnapshot, InstitutionalFlow, MarketContext, MarketOutlook, PublicSnapshot } from '../api/marketContext'
import type { PriceActionAnalysis, PriceActionInterval } from './priceAction'
import { candleIntervalMs } from './candleData'
import { cachedCandleIndicators } from './candleIndicatorCache'
import { globalMarketRows, observedFlows } from './marketDashboard'
import { buildNewsEvidence } from './newsEvidence'
import { buildCandidateDecision, recordTradeDiagnostics, withinEntryWindow, type CandidateDecision } from './tradeDecision'
import { candleSession } from './vwap'
import { type IndicatorTurn } from './indicatorTrajectory'
import { isCommodity } from './commodities'
import { marketHours, squareOffLabel } from './tradingSession'
import { sentimentAgeLabel, sentimentFreshness, type SentimentFreshness } from './sentimentFreshness'

export const tradingEvidenceRules = {
  minimumCoverage: 70, minimumScore: 0, minimumGap: 0,
  strongScore: 60, strongGap: 20, elevatedVixGap: 20,
  earlyCandles: 30, earlyCoverage: 60, earlyScore: 55, earlyGap: 15,
  elevatedVixScore: 65, highVixLevel: 25, vixJumpPercent: 10,
  minimumAtrRisk: 1, minimumRewardRisk: 1.5,
}
export type EvidenceLayer = { key: string; name: string; weight: number; coverage: number; bullish: number; bearish: number; details: string[] }
// Score allocation only. Confirmation cutoffs remain in tradingEvidenceRules.
export const technicalWeights = { chart: 25, indicators: 15, rsiVwap: 50, oi: 10 }
export const sentimentWeights = { flows: 30, news: 30, global: 30, pcr: 10 }
export type MarketSentiment = {
  bullishScore: number; bearishScore: number; coverage: number; bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNAVAILABLE'
  alignment: 'SUPPORTS' | 'OPPOSES' | 'MIXED' | 'UNAVAILABLE' | 'NO_TECHNICAL_DIRECTION'
  reason: string; layers: EvidenceLayer[]; bullishEvidence: string[]; bearishEvidence: string[]; missing: string[]
}
export type TradingEvidence = {
  version: 'technical-v2'; instrument: string; asOf?: string; interval: PriceActionInterval
  bullishScore: number; bearishScore: number; coverage: number; bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  selectedAnalysis?: PriceActionAnalysis
  decisions?: CandidateDecision[]
  quality?: 'STANDARD' | 'STRONG'
  requiredGap: number
  riskySetup?: RiskyLevelSetup
  historicalOutcomes?: HistoricalOutcomes
  checks?: Array<{ label: string; passed: boolean; detail: string }>
  canConfirm: boolean; reason: string; layers: EvidenceLayer[]; bullishEvidence: string[]; bearishEvidence: string[]
  missing: string[]; riskNotes: string[]; atr14?: number; vwap?: number; atmVwap?: AtmVwapSnapshot
  indiaVix?: { price: number; changePercent: number; asOf: string }; requiredScore: number; stopLoss?: number; observedFlowReports: InstitutionalFlow[]
  sentiment: MarketSentiment; turns: IndicatorTurn[]
}
const clamp = (value: number) => Math.max(-1, Math.min(1, value))
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const format = (value: unknown) => finite(value) ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'unavailable'
const round = (value: number) => Math.round(value * 10) / 10

function fresh<T extends { asOf: string }>(snapshot: PublicSnapshot<T> | undefined, now: number, age: number) {
  if (snapshot?.status !== 'AVAILABLE' || !snapshot.data || !snapshot.fetchedAt) return false
  const fetched = now - Date.parse(snapshot.fetchedAt), reported = now - Date.parse(snapshot.data.asOf)
  return finite(fetched) && fetched >= -60_000 && fetched <= 10 * 60_000 && finite(reported) && reported >= -60_000 && reported <= age
}

/** Fixed evidence budgets avoid multiplying correlated signals or promoting missing data to support. */
function analyzeSetupEvidence({ analysis, candles, interval, instrument, context, outlook, indiaVix, flowHistory, atmVwap, now, historicalReference = false }: {
  analysis: PriceActionAnalysis; candles: AngelOneCandle[]; interval: PriceActionInterval; instrument: string
  context?: MarketContext | null; outlook?: MarketOutlook; indiaVix?: IndiaVixSnapshot; flowHistory?: InstitutionalFlow[]; now: number; atmVwap?: AtmVwapSnapshot; historicalReference?: boolean
}): TradingEvidence {
  const commodity = isCommodity(instrument)
  const historicalOutcomes = historicalReference ? cachedHistoricalOutcomes(candles, interval, now, instrument) : undefined
  const { closed, averages, trajectory, vwap: vwapValues } = cachedCandleIndicators(candles, interval, now)
  const chartTime = Date.parse(analysis.latestCandleTime || '')
  const chartCurrent = analysis.analyzedCandles >= 25 && finite(chartTime) && chartTime === Date.parse(closed[closed.length - 1]?.[0] || '')
    && chartTime + candleIntervalMs(interval) <= now && now < chartTime + 2 * candleIntervalMs(interval)
  const contextAge = context ? now - Date.parse(context.retrievedAt) : NaN
  const market = (!commodity || context?.marketType === 'COMMODITY') && context?.instrument === instrument && finite(contextAge) && contextAge >= -60_000 && contextAge <= 10 * 60_000 ? context : null
  const layers: EvidenceLayer[] = [], bullishEvidence: string[] = [], bearishEvidence: string[] = [], missing: string[] = [], riskNotes: string[] = []
  const sentimentLayers: EvidenceLayer[] = [], sentimentBullish: string[] = [], sentimentBearish: string[] = [], sentimentMissing: string[] = []
  const layer = (key: keyof typeof technicalWeights | keyof typeof sentimentWeights, name: string) => {
    const technical = key in technicalWeights
    const weight = technical ? technicalWeights[key as keyof typeof technicalWeights] : sentimentWeights[key as keyof typeof sentimentWeights]
    const item: EvidenceLayer = { key, name, weight, coverage: 0, bullish: 0, bearish: 0, details: [] }
    ;(technical ? layers : sentimentLayers).push(item)
    return item
  }
  const add = (item: EvidenceLayer, fraction: number, vote: number | undefined, detail: string) => {
    item.details.push(detail)
    if (vote === undefined || !finite(vote)) return
    const signal = clamp(vote)
    item.coverage += fraction
    item.bullish += item.weight * fraction * Math.max(0, signal)
    item.bearish += item.weight * fraction * Math.max(0, -signal)
    if (signal >= .15) (item.key in technicalWeights ? bullishEvidence : sentimentBullish).push(`${item.name}: ${detail}`)
    if (signal <= -.15) (item.key in technicalWeights ? bearishEvidence : sentimentBearish).push(`${item.name}: ${detail}`)
  }
  // Only reference layers decay. Keep observed coverage and fixed budgets; do not reweight technical OI.
  const addAgedSentiment = (item: EvidenceLayer, fraction: number, vote: number | undefined, detail: string, freshness: SentimentFreshness | undefined) => {
    add(item, fraction, vote === undefined || !freshness ? undefined : clamp(vote) * freshness.factor, `${detail} · ${sentimentAgeLabel(freshness)}`)
  }
  const chart = layer('chart', 'Chart & pattern')
  const chartBullish = analysis.bullishEvidence.filter(item => !/EMA|SMA|RSI|Supertrend/i.test(item))
  const chartBearish = analysis.bearishEvidence.filter(item => !/EMA|SMA|RSI|Supertrend/i.test(item))
  if (chartCurrent) {
    add(chart, .45, analysis.side === 'CALL' ? 1 : analysis.side === 'PUT' ? -1 : 0, `${analysis.setup} · ${analysis.location} · ${analysis.candleBehavior}`)
    const total = chartBullish.length + chartBearish.length
    chart.coverage += .35
    chart.bullish += total ? chart.weight * .35 * chartBullish.length / total : 0
    chart.bearish += total ? chart.weight * .35 * chartBearish.length / total : 0
    bullishEvidence.push(...chartBullish.map(item => `Chart: ${item}`))
    bearishEvidence.push(...chartBearish.map(item => `Chart: ${item}`))
    add(chart, .2, analysis.phase === 'UPTREND' ? 1 : analysis.phase === 'DOWNTREND' ? -1 : 0, `Structure: ${analysis.structure} · ${analysis.structureEvent}`)
  } else missing.push('Recent completed chart candles')

  const indicators = layer('indicators', 'Indicators')
  const price = chartCurrent && finite(analysis.currentPrice) ? analysis.currentPrice : undefined
  const previousEma = averages[averages.length - 2]?.ema20
  const vwap = vwapValues[vwapValues.length - 1]
  const atr = chartCurrent && finite(analysis.atr14) && analysis.atr14 > 0 ? analysis.atr14 : undefined
  add(indicators, 1 / 15, price !== undefined && finite(analysis.movingAverage20) ? Math.sign(price - analysis.movingAverage20) : undefined, `SMA(20): ${finite(analysis.movingAverage20) ? format(analysis.movingAverage20) : 'warming up'}`)
  add(indicators, 1 / 15, price !== undefined && finite(analysis.exponentialMovingAverage20) ? Math.sign(price - analysis.exponentialMovingAverage20) : undefined, `EMA(20): ${finite(analysis.exponentialMovingAverage20) ? format(analysis.exponentialMovingAverage20) : 'warming up'}`)
  const ema20 = analysis.exponentialMovingAverage20, ema50 = analysis.exponentialMovingAverage50
  const emaVote = price !== undefined && finite(ema20) && finite(ema50) && finite(previousEma)
    ? (Math.sign(ema20 - ema50) + Math.sign(ema20 - previousEma)) / 2 : undefined
  add(indicators, 5 / 15, emaVote, `EMA(20/50) alignment and EMA(20) slope: ${emaVote === undefined ? 'warming up' : emaVote > 0 ? 'upward' : emaVote < 0 ? 'downward' : 'mixed'}`)
  add(indicators, 2 / 15, price !== undefined ? trajectory.slopeVote : undefined, trajectory.slopeDetails.join(' · ') || 'EMA trajectories: warming up or interrupted candle data')
  const otherTurns = trajectory.turns.filter(turn => !/RSI|VWAP/i.test(turn.name))
  const otherTurnVote = trajectory.turnVote === undefined ? undefined : otherTurns.length ? otherTurns.reduce((sum, turn) => sum + (turn.side === 'CALL' ? 1 : -1), 0) / otherTurns.length : 0
  add(indicators, 1 / 15, price !== undefined ? otherTurnVote : undefined, otherTurns.length ? otherTurns.map(turn => turn.name).join(' · ') : 'No new non-RSI/non-VWAP completed-bar turn or crossover')
  const rsiVwap = layer('rsiVwap', 'RSI structure + VWAP')
  add(rsiVwap, .16, price !== undefined && finite(analysis.rsi14) ? (analysis.rsi14 - 50) / 20 : undefined, `RSI(14): ${finite(analysis.rsi14) ? format(analysis.rsi14) : 'warming up'}`)
  add(rsiVwap, .14, price !== undefined && finite(analysis.rsi14Momentum) ? analysis.rsi14Momentum / 8 : undefined, `RSI(14) momentum: ${finite(analysis.rsi14Momentum) ? format(analysis.rsi14Momentum) : 'warming up'}`)
  const rsiStructure = trajectory.swingEvidence.find(item => item.name === 'RSI')?.structure
  const structureVote = price === undefined || !rsiStructure || rsiStructure.trend === 'WARMING_UP' ? undefined
    : rsiStructure.breakDirection ? rsiStructure.breakDirection === 'UP' ? 1 : -1
      : rsiStructure.trend === 'UPTREND' ? 1 : rsiStructure.trend === 'DOWNTREND' ? -1 : 0
  add(rsiVwap, .2, structureVote, `RSI structure: ${rsiStructure?.pattern ?? 'warming up'}${rsiStructure?.breakDirection ? ` · broken ${rsiStructure.breakDirection.toLowerCase()}` : ''}`)
  if (structureVote === undefined) missing.push('Confirmed RSI HH/HL/LH/LL swings')
  if (price !== undefined && finite(analysis.rsi14) && (analysis.rsi14 >= 70 || analysis.rsi14 <= 30)) riskNotes.push(`RSI(14) is ${analysis.rsi14 >= 70 ? 'overbought' : 'oversold'}; momentum and the confirmed price pattern must be considered together, not as an automatic reversal.`)
  add(indicators, 5 / 15, price !== undefined && analysis.supertrendDirection ? analysis.supertrendDirection === 'UP' ? 1 : -1 : undefined, `Supertrend(10,3): ${analysis.supertrendDirection || 'warming up'}`)
  const indexVwap = ['Nifty 50', 'Sensex', 'Bank Nifty'].includes(instrument)
  // ATM follows the current index quote used for this fresh request. An hourly
  // candle's older close must not invalidate the selected current ATM strike.
  const atmContext = indexVwap ? atmVwapContext(atmVwap, instrument, atmVwap?.referenceIndexPrice ?? price, now) : undefined
  const atmBias = atmContext?.bias
  const vwapVote = price === undefined ? undefined : indexVwap ? atmBias === undefined ? undefined : atmBias === 'BULLISH' ? 1 : atmBias === 'BEARISH' ? -1 : 0 : finite(vwap) ? Math.sign(price - vwap) : undefined
  add(rsiVwap, .5, vwapVote, indexVwap
    ? `ATM CE/PE VWAP: ${atmBias === undefined ? `unavailable; ${atmContext?.reason}` : `strike ${atmVwap!.strike} · CE ${format(atmVwap!.ce.vwap)} / PE ${format(atmVwap!.pe.vwap)} · ${atmBias.toLowerCase()}`}`
    : `VWAP: ${finite(vwap) ? `${format(vwap)} · price ${price !== undefined && price > vwap ? 'above' : 'below'}` : 'unavailable; zero traded volume'}`)
  if (vwapVote === undefined) missing.push(indexVwap ? 'Current ATM CE/PE VWAP' : 'VWAP (genuine traded volume unavailable)')
  if (atr === undefined) missing.push('ATR(14)')
  else riskNotes.push(`ATR(14) ${format(atr)} pts · stop distance must cover at least 1 ATR; reward/risk must remain ≥ 1.5`)

  const oiLayer = layer('oi', 'OI / PCR'), pcrLayer = layer('pcr', 'PCR reference'), oi = commodity ? undefined : market?.inputs?.openInterest
  const expiryText = oi?.data?.expiry
  const expiry = expiryText ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(expiryText) ? `${expiryText}T15:30:00+05:30` : `${expiryText} 15:30:00 GMT+0530`) : NaN
  if (fresh(oi, now, 30 * 60_000) && oi!.data!.unit === 'CONTRACTS' && finite(expiry) && expiry >= now && oi!.data!.symbol === (instrument === 'Bank Nifty' ? 'BANKNIFTY' : instrument === 'Nifty 50' ? 'NIFTY' : 'SENSEX')) {
    const data = oi!.data!
    add(oiLayer, .6, finite(data.pcr) && data.pcr >= 0 ? (data.pcr - 1) / .5 : undefined, `PCR ${format(data.pcr)} · expiry ${data.expiry}; positioning heuristic`)
    addAgedSentiment(pcrLayer, 1, finite(data.pcr) && data.pcr >= 0 ? (data.pcr - 1) / .5 : undefined, `PCR ${format(data.pcr)} · same option chain as technical analysis; reference only`, sentimentFreshness('pcr', data.asOf, now))
    const callChange = data.callOiChange, putChange = data.putOiChange
    add(oiLayer, .4, finite(callChange) && finite(putChange) ? (putChange - callChange) / (Math.abs(putChange) + Math.abs(callChange) || 1) : undefined, `Call OI ${format(data.callOi)} · Put OI ${format(data.putOi)} · change ${callChange == null ? '—' : format(callChange)} / ${putChange == null ? '—' : format(putChange)} contracts; writing is unverified`)
    oiLayer.details.push(`Call wall ${format(data.callWall)} · Put wall ${format(data.putWall)} · Max pain ${format(data.maxPain)}; reference levels, not price targets`)
  } else { missing.push(commodity ? 'Commodity option-chain OI/PCR is not connected; its weight remains unavailable' : 'Current, unexpired option-chain data'); sentimentMissing.push('Current PCR reference') }
  if (commodity) oiLayer.details.push('Commodity option-chain OI/PCR is not connected. Index positioning is not used for MCX futures.')

  const flows = layer('flows', 'FII / DII'), institutional = commodity ? undefined : market?.inputs?.institutional, positions = commodity ? undefined : market?.inputs?.participantPositions
  if (fresh(institutional, now, 7 * 86_400_000) && institutional!.data!.unit === 'INR_CRORE') {
    const data = institutional!.data!, total = Math.abs(data.fiiCash) + Math.abs(data.diiCash) || 1
    const freshness = sentimentFreshness('flows', data.asOf, now)
    addAgedSentiment(flows, .5, data.netFlow / total, `Net cash flow ₹${format(data.netFlow)} cr · report ${data.asOf.slice(0, 10)}`, freshness)
    addAgedSentiment(flows, .15, data.fiiCash / total, `FII cash ₹${format(data.fiiCash)} cr; daily market-wide flow`, freshness)
    addAgedSentiment(flows, .15, data.diiCash / total, `DII cash ₹${format(data.diiCash)} cr; daily market-wide flow`, freshness)
  } else sentimentMissing.push('Published FII / DII cash report')
  if (fresh(positions, now, 7 * 86_400_000)) {
    const data = positions!.data!
    addAgedSentiment(flows, .1, (data.longPercent - data.shortPercent) / 50, `FII index futures long / short ${format(data.longPercent)}% / ${format(data.shortPercent)}%`, sentimentFreshness('flows', data.asOf, now))
  } else sentimentMissing.push('FII index futures positions')
  const observedFlowReports = observedFlows(commodity ? [] : flowHistory).filter(flow => {
    const age = now - Date.parse(flow.asOf)
    return age >= 0 && age <= 14 * 86_400_000
  }).slice(-5)
  if (fresh(institutional, now, 7 * 86_400_000) && observedFlowReports.length >= 3) {
    const fii = observedFlowReports.reduce((sum, flow) => sum + flow.fiiCash, 0), absolute = observedFlowReports.reduce((sum, flow) => sum + Math.abs(flow.fiiCash), 0)
    const agedFii = observedFlowReports.reduce((sum, flow) => sum + flow.fiiCash * (sentimentFreshness('flows', flow.asOf, now, 14 * 86_400_000)?.factor ?? 0), 0)
    add(flows, .1, agedFii / (absolute || 1), `FII last ${observedFlowReports.length} observed reports ₹${format(fii)} cr · selling in ${observedFlowReports.filter(flow => flow.fiiCash < 0).length}/${observedFlowReports.length} reports · each report decays by publication age (3d half-life); absolute-flow denominator unchanged`)
  } else sentimentMissing.push('FII multi-session trend (at least 3 saved daily reports)')

  const newsLayer = layer('news', 'News'), news = buildNewsEvidence(market, outlook, now)
  for (const headline of news.headlines.filter(item => item.eligible)) {
    addAgedSentiment(newsLayer, 1 / Math.max(1, news.articles.length), headline.score === undefined ? undefined : headline.score / 2, `${headline.article.title}${headline.score === undefined ? ' · awaiting / unclear assessment' : ` · impact ${headline.score}`}`, headline.freshness)
  }
  if (!news.assessed) sentimentMissing.push('Current, assessed news headlines')
  const globalLayer = layer('global', 'Global'), global = globalMarketRows(market, now, instrument)
  for (const [label, value] of global.rows) {
    const detail = global.details[label]
    addAgedSentiment(globalLayer, 1 / global.count, detail.vote, `${label}: ${value.replace(/\n/g, ' ')}; ${commodity ? 'commodity reference' : 'India context cue'}`, sentimentFreshness('global', detail.asOf, now))
  }
  if (!global.votes.length) sentimentMissing.push('Current global market quotes')

  const previous = closed[closed.length - 2]
  const sessionIntact = Boolean(previous && chartTime - Date.parse(previous[0]) === candleIntervalMs(interval) && candleSession(previous[0]) === candleSession(new Date(now).toISOString()) && candleSession(previous[0]) === candleSession(analysis.latestCandleTime!))
  let requiredGap = tradingEvidenceRules.minimumGap
  let currentVix: TradingEvidence['indiaVix'], requiredScore = tradingEvidenceRules.minimumScore
  if (!commodity && fresh(indiaVix, now, 30 * 60_000) && indiaVix!.data!.symbol === '^INDIAVIX' && finite(indiaVix!.data!.price) && indiaVix!.data!.price > 0 && finite(indiaVix!.data!.changePercent)) {
    const data = indiaVix!.data!
    currentVix = { price: data.price, changePercent: data.changePercent, asOf: data.asOf }
    const elevated = data.price >= tradingEvidenceRules.highVixLevel || data.changePercent >= tradingEvidenceRules.vixJumpPercent
    requiredGap = elevated ? tradingEvidenceRules.elevatedVixGap : requiredGap
    requiredScore = elevated ? tradingEvidenceRules.elevatedVixScore : requiredScore
    riskNotes.push(`India VIX ${format(data.price)} · ${format(data.changePercent)}% change; volatility context, not a directional vote${elevated ? ' · elevated-risk score threshold applies' : ''}`)
  } else if (!commodity) missing.push('Current India VIX quote (volatility risk unavailable)')
  if (commodity) riskNotes.push('MCX futures use their own ATR and traded-volume VWAP. India VIX, equity cash flows and India-oriented global cues are not commodity risk signals. Commodity-specific news and global benchmarks provide sentiment reference only.')

  const bullishScore = round(layers.reduce((sum, item) => sum + item.bullish, 0)), bearishScore = round(layers.reduce((sum, item) => sum + item.bearish, 0))
  const coverage = round(layers.reduce((sum, item) => sum + item.weight * item.coverage, 0))
  const bias = scoreDominates(bullishScore, bearishScore) ? 'BULLISH' : scoreDominates(bearishScore, bullishScore) ? 'BEARISH' : 'NEUTRAL'
  const sentimentBullishScore = round(sentimentLayers.reduce((sum, item) => sum + item.bullish, 0)), sentimentBearishScore = round(sentimentLayers.reduce((sum, item) => sum + item.bearish, 0))
  const sentimentCoverage = round(sentimentLayers.reduce((sum, item) => sum + item.weight * item.coverage, 0))
  const sentimentGap = sentimentBullishScore - sentimentBearishScore
  // A lone PCR reference cannot represent the day's macro/news sentiment.
  const sentimentAvailable = sentimentCoverage >= 40 && sentimentLayers.some(item => item.key !== 'pcr' && item.coverage >= .4)
  const sentimentBias: MarketSentiment['bias'] = !sentimentAvailable ? 'UNAVAILABLE' : Math.abs(sentimentGap) < 15 ? 'NEUTRAL' : sentimentGap > 0 ? 'BULLISH' : 'BEARISH'
  const alignment: MarketSentiment['alignment'] = sentimentBias === 'UNAVAILABLE' ? 'UNAVAILABLE' : analysis.side === 'WAIT' ? 'NO_TECHNICAL_DIRECTION' : sentimentBias === 'NEUTRAL' ? 'MIXED' : sentimentBias === (analysis.side === 'CALL' ? 'BULLISH' : 'BEARISH') ? 'SUPPORTS' : 'OPPOSES'
  const sentiment: MarketSentiment = { bullishScore: sentimentBullishScore, bearishScore: sentimentBearishScore, coverage: sentimentCoverage, bias: sentimentBias, alignment,
    reason: alignment === 'OPPOSES' ? 'Market sentiment opposes the technical setup; counter-sentiment risk. It does not veto or reverse technical confirmation.' : alignment === 'SUPPORTS' ? 'Market sentiment supports the technical direction; reference only, not an entry trigger.' : alignment === 'UNAVAILABLE' ? 'Insufficient current sentiment data; technical confirmation remains independent.' : 'Sentiment is mixed or there is no technical setup to compare; reference only.',
    layers: sentimentLayers, bullishEvidence: sentimentBullish, bearishEvidence: sentimentBearish, missing: sentimentMissing }
  const side = analysis.side, d = side === 'CALL' ? 1 : -1
  const roundedEntry = finite(analysis.entry) ? Math.round(analysis.entry * 100) / 100 : undefined
  const chartRisk = roundedEntry !== undefined && finite(analysis.stopLoss) ? (roundedEntry - analysis.stopLoss) * d : undefined
  const riskDistance = chartRisk !== undefined && chartRisk > 0 && atr ? Math.max(chartRisk, atr * tradingEvidenceRules.minimumAtrRisk) : undefined
  const stopLoss = roundedEntry !== undefined && riskDistance !== undefined ? (d === 1 ? Math.floor((roundedEntry - riskDistance) * 100) : Math.ceil((roundedEntry + riskDistance) * 100)) / 100 : undefined
  const rewardRisk = roundedEntry !== undefined && stopLoss !== undefined && finite(analysis.target) ? (Math.round(analysis.target * 100) / 100 - roundedEntry) * d / ((roundedEntry - stopLoss) * d) : undefined
  const dominant = side === 'CALL' ? bullishScore : bearishScore, opposing = side === 'CALL' ? bearishScore : bullishScore
  const directionalLead = round(dominant - opposing)
  const coreIndicators = closed.length >= 50 && [ema20, ema50, analysis.rsi14, analysis.rsi14Momentum].every(finite) && Boolean(analysis.supertrendDirection)
  const matchingRoutes = analysis.alignment?.routes.filter(route => route.side === side) ?? []
  const directionalRoute = Date.parse(analysis.alignment?.at ?? '') === chartTime && matchingRoutes.length > 0
  let reason = `${side} completed chart setup and technical evidence align.`
  if (!chartCurrent) reason = 'Waiting for recent completed candles; historical or forming candles cannot confirm a trade.'
  else if (!sessionIntact) reason = 'Waiting for consecutive completed candles from the current market session.'
  else if (!withinEntryWindow(now, instrument)) reason = `Outside the entry window (${marketHours(instrument, now)}). Open trades are due for automatic square-off at ${squareOffLabel(instrument, now)}.`
  else if (side === 'WAIT' || analysis.pattern === 'NO_CONFIRMED_PATTERN') reason = 'Waiting for a confirmed chart pattern at a valid structure / location.'
  else if (!atr) reason = 'Waiting for a valid ATR(14) risk estimate.'
  else if (!coreIndicators) reason = 'Waiting for EMA(20/50), RSI(14), momentum and Supertrend to warm up on at least 50 completed candles.'
  else if (coverage < tradingEvidenceRules.minimumCoverage) reason = `Insufficient technical evidence: ${coverage}% coverage. Need ≥70% technical coverage; missing inputs are not reweighted.`
  else if (!directionalRoute) reason = 'Waiting for an EMA trajectory/crossover, Supertrend trajectory/flip or support/resistance break/reversal in the setup direction.'
  else if (dominant < requiredScore || directionalLead < requiredGap || !scoreDominates(dominant, opposing)) reason = `Evidence is weak or conflicting: ${dominant}/100 support versus ${opposing}/100 opposition. Need positive support ≥1.5× opposition${requiredScore > 0 ? `, ≥${requiredScore} support and ≥${requiredGap} lead for elevated VIX` : ''}.`
  else if (!finite(stopLoss) || stopLoss <= 0 || !finite(rewardRisk) || rewardRisk < tradingEvidenceRules.minimumRewardRisk) reason = 'Chart target fails the ATR / reward-to-risk check. The stop covers chart invalidation and at least 1 ATR; the target is not stretched to force a trade.'
  const checks = [
    { label: 'Recent completed candles', passed: chartCurrent, detail: chartCurrent ? `Latest completed candle ${analysis.latestCandleTime}` : 'Saved or forming candles cannot create a current entry.' },
    { label: 'Confirmed price pattern', passed: side !== 'WAIT' && analysis.pattern !== 'NO_CONFIRMED_PATTERN', detail: side === 'WAIT' ? analysis.reason : analysis.setup },
    { label: 'Indicator warmup', passed: coreIndicators, detail: `${closed.length} closed candles · EMA20/50, RSI and Supertrend require at least 50.` },
    { label: 'ATR risk', passed: Boolean(atr), detail: atr ? `ATR(14) ${atr.toFixed(2)} points · Stop covers at least 1 ATR.` : 'A current, positive ATR estimate is required.' },
    { label: 'Technical coverage', passed: coverage >= tradingEvidenceRules.minimumCoverage, detail: `${coverage}% available / ${tradingEvidenceRules.minimumCoverage}% required. Missing inputs are not reweighted.` },
    { label: 'Directional agreement', passed: side !== 'WAIT' && directionalRoute && dominant >= requiredScore && directionalLead >= requiredGap && scoreDominates(dominant, opposing), detail: `Matched route: ${directionalRoute ? matchingRoutes.map(route => route.name).join(' or ') : 'none'}. Bullish ${bullishScore}/100 · Bearish ${bearishScore}/100 · Need support ≥1.5× opposition; risk floors ${requiredScore} support / ${requiredGap} lead.` },
    { label: 'Reward/risk on confirmed setup', passed: finite(stopLoss) && stopLoss > 0 && finite(rewardRisk) && rewardRisk >= tradingEvidenceRules.minimumRewardRisk, detail: finite(rewardRisk) ? `${rewardRisk.toFixed(2)} : 1 after ATR stop adjustment / ${tradingEvidenceRules.minimumRewardRisk} : 1 required.` : 'A confirmed price setup and its validated entry, stop and target are required.' },
  ]
  const canConfirm = reason === `${side} completed chart setup and technical evidence align.`
  const riskySetup = canConfirm ? undefined : findRiskyLevelSetup({ analysis, candles: closed, checks, bullishScore, bearishScore, interval, now, instrument })
  return { version: 'technical-v2', instrument, interval, asOf: analysis.latestCandleTime, bullishScore, bearishScore, coverage, bias, canConfirm, reason, checks, riskySetup, historicalOutcomes, layers, sentiment, turns: chartCurrent ? trajectory.turns : [],
    bullishEvidence: [...new Set(bullishEvidence)], bearishEvidence: [...new Set(bearishEvidence)], missing, riskNotes, atr14: atr, vwap, atmVwap: atmBias !== undefined ? atmVwap : undefined, indiaVix: currentVix, requiredScore, requiredGap, quality: canConfirm ? dominant >= tradingEvidenceRules.strongScore && directionalLead >= tradingEvidenceRules.strongGap ? 'STRONG' : 'STANDARD' : undefined, stopLoss, observedFlowReports }
}

/** Score CE and PE independently before selecting an entry candidate. Shared indicators stay memory-cached. */
export function analyzeTradingEvidence(input: Parameters<typeof analyzeSetupEvidence>[0]): TradingEvidence {
  const roundPrice = (price: number) => Math.round(price * 100) / 100
  const base = analyzeSetupEvidence(input), { closed } = cachedCandleIndicators(input.candles, input.interval, input.now)
  const sides = (['CALL', 'PUT'] as const).map(side => {
    if (base.canConfirm && input.analysis.side === side) return { analysis: input.analysis, evidence: base, decision: buildCandidateDecision(input.analysis, base, side, closed, input.now, tradingEvidenceRules) }
    const d = side === 'CALL' ? 1 : -1
    const candidates = (input.analysis.detectedSetups ?? []).filter(setup => setup.side === side).sort((a, b) => {
      const eligible = (setup: typeof a) => {
        const entry = roundPrice(setup.entry), chartRisk = d * (entry - setup.stopLoss)
        const risk = Math.max(chartRisk, input.analysis.atr14 ?? 0)
        const stop = (d === 1 ? Math.floor((entry - risk) * 100) : Math.ceil((entry + risk) * 100)) / 100
        return chartRisk > 0 && stop > 0 && d * (roundPrice(setup.target) - entry) / (d * (entry - stop)) >= 1.5
      }
      return Number(eligible(b)) - Number(eligible(a)) || b.score - a.score
    })
    const candidate = candidates[0]
    const analysis: PriceActionAnalysis = candidate ? { ...input.analysis, ...candidate, detectedSetups: undefined, confidence: candidate.score } : input.analysis.side === side ? input.analysis : { ...input.analysis, side: 'WAIT', pattern: 'NO_CONFIRMED_PATTERN', setup: 'No completed setup', entry: undefined, stopLoss: undefined, target: undefined }
    const same = analysis.side === input.analysis.side && analysis.pattern === input.analysis.pattern && analysis.entry === input.analysis.entry && analysis.stopLoss === input.analysis.stopLoss && analysis.target === input.analysis.target
    const evidence = same ? base : analyzeSetupEvidence({ ...input, analysis, historicalReference: false })
    return { analysis, evidence, decision: buildCandidateDecision(analysis, evidence, side, closed, input.now, tradingEvidenceRules) }
  })
  // Preserve the existing selected setup when eligible; otherwise consider the other independent pipeline.
  const selected = base.canConfirm ? { analysis: input.analysis, evidence: base } : sides.find(item => item.evidence.canConfirm) ?? sides.find(item => item.evidence.riskySetup) ?? sides.find(item => item.decision.state === 'EARLY') ?? { analysis: input.analysis, evidence: base }
  const decisions = sides.map(item => item.decision)
  recordTradeDiagnostics(input.instrument, input.interval, input.analysis.latestCandleTime, input.now, decisions)
  return { ...selected.evidence, historicalOutcomes: base.historicalOutcomes, selectedAnalysis: selected.analysis, decisions }
}
