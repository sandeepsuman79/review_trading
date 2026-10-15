import type { AngelOneCandle } from '../api/angelOne'
import type { GlobalQuote, InstitutionalFlow, MarketContext, MarketOutlook, PublicSnapshot } from '../api/marketContext'
import commodityMarkets from '../data/commodityMarkets.json'
import { isCommodity } from './commodities'
import globalMarkets from '../data/globalMarkets.json'
import type { PriceActionAnalysis } from './priceAction'
import { calculateSessionVwap, candleSession } from './vwap'
import { buildNewsEvidence } from './newsEvidence'

export type AnalysisTile = {
  key: string
  title: string
  weight: number
  score?: number
  coverage: number
  status: string
  rows: Array<[string, string]>
  note: string
  sourceUrl?: string
  asOf?: string
  asOfDateOnly?: boolean
  rowDetails?: Record<string, { tone: 'bullish' | 'bearish' | 'neutral' | 'missing'; caption?: string; vote?: number }>
}
export const flowHistoryKey = 'traders_institutional_flows_v1'
export const dashboardWeights = { chart: 22, indicators: 22, oi: 18, flows: 13, news: 12, global: 13 }
const clamp = (value: number) => Math.max(-1, Math.min(1, value))
const averageScore = (votes: number[]) => votes.length ? 2 * votes.reduce((sum, value) => sum + value, 0) / votes.length : undefined
export const formatMarketPrice = (value?: number | null) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
export const signedMarketValue = (value?: number | null) => value == null ? '—' : `${value > 0 ? '+' : ''}${formatMarketPrice(value)}`

function usable<T extends { asOf: string }>(snapshot: PublicSnapshot<T> | undefined, now: number, maxAge: number) {
  if (snapshot?.status !== 'AVAILABLE' || !snapshot.data || !snapshot.fetchedAt) return false
  const fetchedAge = now - Date.parse(snapshot.fetchedAt), dataAge = now - Date.parse(snapshot.data.asOf)
  return Number.isFinite(fetchedAge) && fetchedAge >= -60_000 && fetchedAge <= 10 * 60_000 && Number.isFinite(dataAge) && dataAge >= -60_000 && dataAge <= maxAge
}

export function globalMarketRows(context: MarketContext | null, now: number, instrument = context?.instrument) {
  const commodity = isCommodity(instrument)
  const inputs = commodity && (context?.marketType !== 'COMMODITY' || context.instrument !== instrument) ? undefined : context?.inputs
  const rows: Array<[string, string]> = []
  const details: NonNullable<AnalysisTile['rowDetails']> = {}
  const votes: number[] = []
  const specs = commodity ? commodityMarkets[instrument as keyof typeof commodityMarkets].benchmarks.map(spec => ({ ...spec, provider: 'yahoo', indiaSign: spec.cueSign, showCue: spec.cueSign !== 0 })) : globalMarkets
  for (const spec of specs) {
    const snapshot: PublicSnapshot<GlobalQuote> | undefined = spec.provider === 'nse' ? inputs?.giftNifty : inputs?.global.find(quote => quote.data?.symbol === spec.symbol)
    const data = snapshot?.data
    const valid = data && data.symbol === spec.symbol && Number.isFinite(data.price) && data.price > 0 && Number.isFinite(data.changePercent)
    if (!valid) {
      rows.push([spec.name, 'Unavailable'])
      details[spec.name] = { tone: 'missing' }
      continue
    }
    const fresh = usable(snapshot, now, 4 * 86_400_000)
    const move = spec.kind === 'yield' && data.change != null ? data.change : data.changePercent
    const direction = Math.sign(move)
    const arrow = direction > 0 ? '↑' : direction < 0 ? '↓' : '→'
    const formatted = spec.kind === 'yield' ? `${data.price.toFixed(3)}%` : spec.kind === 'commodity' ? `$${formatMarketPrice(data.price)} / ${'unit' in spec ? spec.unit : 'bbl'}` : spec.kind === 'fx' ? `₹${formatMarketPrice(data.price)} / USD` : formatMarketPrice(data.price)
    const change = spec.kind === 'yield' && data.change != null ? `${signedMarketValue(data.change * 100)} bps` : `${signedMarketValue(data.changePercent)}%${spec.kind === 'yield' ? ' relative' : ''}`
    rows.push([spec.name, `${formatted}\n${arrow} ${change}${fresh ? '' : ' (stale)'}`])
    const indiaDirection = direction * spec.indiaSign
    details[spec.name] = { tone: !fresh ? 'missing' : indiaDirection > 0 ? 'bullish' : indiaDirection < 0 ? 'bearish' : 'neutral', caption: fresh && spec.showCue ? `${indiaDirection > 0 ? 'Bullish' : indiaDirection < 0 ? 'Bearish' : 'Neutral'} ${commodity ? 'commodity reference' : 'India cue'}` : undefined, vote: fresh && spec.indiaSign !== 0 ? clamp(data.changePercent) * spec.indiaSign : undefined }
    if (fresh && spec.indiaSign !== 0) votes.push(clamp(data.changePercent) * spec.indiaSign)
  }
  return { rows, details, votes, count: specs.filter(spec => spec.indiaSign !== 0).length }
}

export function observedFlows(value: unknown, next?: InstitutionalFlow): InstitutionalFlow[] {
  const records = (Array.isArray(value) ? value : []).filter((item): item is InstitutionalFlow => item?.unit === 'INR_CRORE'
    && typeof item.asOf === 'string' && Number.isFinite(Date.parse(item.asOf))
    && [item.fiiCash, item.diiCash, item.netFlow].every(amount => typeof amount === 'number' && Number.isFinite(amount)))
  const byDay = new Map(records.map(record => [candleSession(record.asOf), record]))
  if (next) byDay.set(candleSession(next.asOf), next)
  return [...byDay.values()].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)).slice(-20)
}

export function openingRange(candles: AngelOneCandle[], session: string, now: number, instrument?: string) {
  const starts = isCommodity(instrument) ? [540, 545, 550] : [555, 560, 565] // 09:15, 09:20 and 09:25 IST; use the cached 5-minute chart.
  const bars = starts.map(minute => candles.find(bar => {
    const timestamp = Date.parse(bar[0]), local = new Date(timestamp + 330 * 60_000)
    return candleSession(bar[0]) === session && local.getUTCHours() * 60 + local.getUTCMinutes() === minute && timestamp + 300_000 <= now
  }))
  if (bars.some(bar => !bar)) return undefined
  return { low: Math.min(...bars.map(bar => bar![3])), high: Math.max(...bars.map(bar => bar![2])) }
}

export function buildMarketDashboard({ analysis, candles, openingCandles, context, outlook, chartCurrent, now, instrument = context?.instrument }: {
  analysis: PriceActionAnalysis
  candles: AngelOneCandle[]
  openingCandles: AngelOneCandle[]
  context: MarketContext | null
  outlook?: MarketOutlook
  chartCurrent: boolean
  now: number
  instrument?: string
}) {
  const price = analysis.currentPrice
  const hasChart = price !== undefined && analysis.analyzedCandles >= 25
  const chartEvidence = (items: string[]) => items.filter(item => !/EMA|SMA|RSI|Supertrend/i.test(item))
  const bullish = chartEvidence(analysis.bullishEvidence).length, bearish = chartEvidence(analysis.bearishEvidence).length
  const chartScore = hasChart ? bullish + bearish > 0 ? 2 * (bullish - bearish) / (bullish + bearish) : 0 : undefined
  const last = candles[candles.length - 1], range = last ? openingRange(openingCandles, candleSession(last[0]), now, instrument) : undefined
  const vwapSeries = calculateSessionVwap(candles), vwap = vwapSeries[vwapSeries.length - 1]
  const votes: number[] = []
  if (price !== undefined && vwap !== undefined) votes.push(Math.sign(price - vwap))
  const ema20 = analysis.exponentialMovingAverage20, ema50 = analysis.exponentialMovingAverage50
  const emaDirection = price !== undefined && ema20 !== undefined && ema50 !== undefined ? price > ema20 && ema20 > ema50 ? 1 : price < ema20 && ema20 < ema50 ? -1 : 0 : undefined
  if (emaDirection !== undefined) votes.push(emaDirection)
  if (analysis.rsi14 !== undefined) votes.push(clamp((analysis.rsi14 - 50) / 25))
  if (analysis.supertrendDirection) votes.push(analysis.supertrendDirection === 'UP' ? 1 : -1)
  const commodity = isCommodity(instrument)
  const inputs = context?.inputs, oi = commodity ? undefined : inputs?.openInterest, flows = commodity ? undefined : inputs?.institutional, positions = commodity ? undefined : inputs?.participantPositions
  const freshOi = usable(oi, now, 4 * 86_400_000), freshFlows = usable(flows, now, 7 * 86_400_000)
  const freshPositions = usable(positions, now, 7 * 86_400_000)
  const news = buildNewsEvidence(context, outlook, now)
  const { articles, currentOutlook, positive, negative, neutral, assessed: classified } = news
  const eventMentions = [['RBI', /\bRBI\b/i], ['Fed', /\bFed(?:eral Reserve)?\b|\bFOMC\b/i], ['Results', /\bearnings\b|\bresults\b/i], ['Inflation', /\bCPI\b|\binflation\b/i]] as const
  const events = eventMentions.filter(([, regex]) => articles.some(article => regex.test(article.title))).map(([label]) => label)
  const global = globalMarketRows(context, now, instrument)
  const tiles: AnalysisTile[] = [
    { key: 'chart', title: 'Chart', weight: dashboardWeights.chart, score: chartScore, coverage: hasChart ? 1 : 0, status: chartCurrent ? 'Completed candles' : 'Historical / waiting',
      rows: [['Last close', formatMarketPrice(price)], ['vs previous close', price !== undefined && analysis.previousDayClose !== undefined ? signedMarketValue(price - analysis.previousDayClose) : '—'], ['Pattern', analysis.setup], ['Opening range (15m)', range ? `${formatMarketPrice(range.low)} – ${formatMarketPrice(range.high)}` : 'Unavailable']],
      note: 'Score: balance of bullish and bearish OHLC evidence. Opening range requires all three completed 5-minute bars.', asOf: analysis.latestCandleTime },
    { key: 'indicators', title: 'Indicators', weight: dashboardWeights.indicators, score: averageScore(votes), coverage: votes.length / 4, status: `${votes.length}/4 inputs available`,
      rows: [['VWAP', vwap === undefined || price === undefined ? 'Unavailable' : price > vwap ? 'Price above' : price < vwap ? 'Price below' : 'At VWAP'], ['EMA 20/50', emaDirection === undefined ? 'Warming up' : emaDirection > 0 ? 'Bullish' : emaDirection < 0 ? 'Bearish' : 'Mixed'], ['RSI (14)', formatMarketPrice(analysis.rsi14)], ['Supertrend', analysis.supertrendDirection === 'UP' ? 'Buy' : analysis.supertrendDirection === 'DOWN' ? 'Sell' : 'Unavailable']],
      note: 'Score: average of VWAP position, EMA alignment, RSI distance from 50, and Supertrend direction. Zero-volume VWAP is excluded.' },
    { key: 'oi', title: 'Open Interest', weight: dashboardWeights.oi, score: freshOi ? 2 * clamp((oi!.data!.pcr - 1) / .5) : undefined, coverage: freshOi ? 1 : 0, status: freshOi ? `Expiry ${oi!.data!.expiry}` : oi?.status === 'STALE' ? 'Stale snapshot' : 'Unavailable',
      rows: [['PCR', formatMarketPrice(oi?.data?.pcr)], ['Call OI wall', formatMarketPrice(oi?.data?.callWall)], ['Put OI wall', formatMarketPrice(oi?.data?.putWall)], ['Max pain', formatMarketPrice(oi?.data?.maxPain)], ['Call OI change', `${signedMarketValue(oi?.data?.callOiChange)}${oi?.data?.callOiChange == null ? '' : ' contracts'}`], ['Put OI change', `${signedMarketValue(oi?.data?.putOiChange)}${oi?.data?.putOiChange == null ? '' : ' contracts'}`]],
      note: freshOi ? 'Nearest expiry · OI in contracts. Score: PCR distance from 1; a context heuristic, not a trade trigger.' : oi?.message || 'Waiting for a verified option-chain source.', sourceUrl: oi?.sourceUrl, asOf: oi?.data?.asOf },
    { key: 'flows', title: 'FII / DII', weight: dashboardWeights.flows, score: freshFlows ? averageScore([clamp(flows!.data!.netFlow / (Math.abs(flows!.data!.fiiCash) + Math.abs(flows!.data!.diiCash) || 1))]) : undefined, coverage: freshFlows ? 1 : 0, status: freshFlows ? 'Published daily report' : flows?.status === 'STALE' ? 'Stale snapshot' : 'Unavailable',
      rows: [['FII cash', flows?.data ? `₹${signedMarketValue(flows.data.fiiCash)} cr` : '—'], ['DII cash', flows?.data ? `₹${signedMarketValue(flows.data.diiCash)} cr` : '—'], ['Net flow', flows?.data ? `₹${signedMarketValue(flows.data.netFlow)} cr` : '—'], ['FII index futures L/S', freshPositions ? `${positions!.data!.longPercent.toFixed(1)}% / ${positions!.data!.shortPercent.toFixed(1)}%` : 'Unavailable']],
      note: commodity ? 'Equity FII/DII cash flows and index futures positions are not applicable to MCX futures. Their weight remains unavailable.' : 'Market-wide daily flows, not intraday index flows. Score: net cash flow divided by combined absolute FII/DII flow.', sourceUrl: flows?.sourceUrl, asOf: flows?.data?.asOf, asOfDateOnly: true },
    { key: 'news', title: 'News', weight: dashboardWeights.news, score: news.score, coverage: articles.length ? classified / articles.length : 0, status: classified ? `${classified}/${articles.length} headlines assessed` : news.headlines.some(headline => headline.status === 'UNCLEAR') ? 'Headline impact unclear' : articles.length ? 'Awaiting assessment' : 'Unavailable',
      rows: [['Available headlines', String(articles.length)], ['Positive', classified ? String(positive) : '—'], ['Negative', classified ? String(negative) : '—'], ['Neutral', classified ? String(neutral) : '—'], ['Unrated / unclear', String(articles.length - classified)], ['Event mentions', events.join(' · ') || 'None in loaded headlines']],
      note: 'Score: mean assessed headline impact, from −2 to +2. Unclear, unrated and stale items are excluded. Older directional-only assessments use ±1. Event mentions are not a verified event calendar.', asOf: context?.retrievedAt },
    { key: 'global', title: 'Global', weight: dashboardWeights.global, score: averageScore(global.votes), coverage: global.votes.length / global.count, status: `${global.votes.length}/${global.count} quotes available`,
      rows: global.rows, rowDetails: global.details,
      note: commodity ? 'Delayed foreign futures benchmarks and USD/INR are commodity context only, with different expiry and units. Direct benchmark and currency moves are indicative, not forecasts or MCX prices. Dollar index and yields are reference only and have no directional vote. Stale quotes are excluded.' : 'Arrows show the actual market move. India cues use an inverse sign for oil, USD/INR and US yields as a context heuristic; they are not forecasts. Yield levels are percentages and yield changes are basis points (bps) when the previous session close is available. Score: capped percentage moves from available quotes; stale quotes are excluded.' },
  ]
  const coverage = chartCurrent ? tiles.reduce((sum, tile) => sum + (tile.score === undefined ? 0 : tile.weight * tile.coverage), 0) : 0
  const subtotal = coverage > 0 ? tiles.reduce((sum, tile) => sum + (tile.score ?? 0) * tile.weight * tile.coverage / 100, 0) : undefined
  return { tiles, coverage, subtotal, articles, currentOutlook }
}
