import { minimumRewardRisk } from '../analysis/tradeRisk'
import { protectionRules } from '../analysis/tradeProtection'
import AgentMonitoringPanel from './AgentMonitoringPanel'
import { contractExpiryNotice } from '../analysis/agentMonitoring'
import ScoreContributions from './ScoreContributions'
import type { CommodityContract } from '../analysis/commodities'
import { isCommodity, tradeDirection } from '../analysis/commodities'
import { timeframeInfo } from '../analysis/timeframes'
import { squareOffTime, squareOffLabel } from '../analysis/tradingSession'
import TradeDecisionPanel from './TradeDecisionPanel'
import type { CSSProperties } from 'react'
import type { AngelOneCandle, AngelOneStreamTick } from '../api/angelOne'
import { candleIntervalMs, isFreshTick, tickTimestamp } from '../analysis/candleData'
import type { EarlyPrediction } from '../analysis/earlyPrediction'
import type { PredictionRecord } from '../analysis/predictionHistory'
import type { PriceActionAnalysis, PriceActionInterval } from '../analysis/priceAction'
import type { TradingEvidence } from '../analysis/tradingEvidence'

function price(value?: number) {
  return value === undefined ? '—' : value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function time(value?: number) {
  return value === undefined ? '—' : `${new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST`
}

function timeframe(interval: PriceActionInterval) {
  return timeframeInfo[interval].label
}

export default function AgentTradeCard({ analysis, evidence, prediction, activeTrade, pendingTrade, records = [], frontContract, replayCandles, instrument, interval, now, tick, streamConnected }: {
  records?: PredictionRecord[]
  frontContract?: CommodityContract
  replayCandles?: AngelOneCandle[]
  analysis: PriceActionAnalysis
  evidence?: TradingEvidence
  prediction: EarlyPrediction
  pendingTrade?: PredictionRecord
  activeTrade?: PredictionRecord
  instrument: string
  interval: PriceActionInterval
  now: number
  tick?: AngelOneStreamTick
  streamConnected: boolean
}) {
  const commodity = isCommodity(instrument)
  const heldContractNotice = activeTrade?.contract && activeTrade.contract.token !== frontContract?.token ? contractExpiryNotice(activeTrade.contract, now, frontContract) : undefined
  const unit = commodity ? 'futures' : 'index'
  const directionLabel = (value: string) => commodity ? tradeDirection(instrument, value) : value === 'CALL' ? 'CALL / CE' : value === 'PUT' ? 'PUT / PE' : value
  const plan = activeTrade ?? ('plan' in prediction ? prediction.plan : undefined)
  const early = evidence?.decisions?.find(decision => decision.state === 'EARLY')
  const side = activeTrade?.side ?? (prediction.side === 'WAIT' && early ? early.side : prediction.side)
  const tone = side === 'CALL' ? 'bullish' : side === 'PUT' ? 'bearish' : 'neutral'
  const risky = plan?.stage === 'RISKY'
  const status = activeTrade ? 'CONFIRMED · OPEN' : plan?.stage === 'CONFIRMED' ? `CONFIRMED SETUP · AWAITING ENTRY${evidence?.quality ? ` · ${evidence.quality}` : ''}` : risky ? 'RISKY · CONDITIONAL SETUP' : plan ? 'EARLY ANALYSIS · NO TRADE' : early ? `EARLY ${directionLabel(early.side)} CANDIDATE · NOT CONFIRMED` : 'WAIT · NO TRADE'
  const reason = activeTrade
    ? `Monitoring the live ${directionLabel(activeTrade.side)} trade. The agent records its profit or loss before another ${instrument} trade can start.`
    : early && !plan ? `Developing ${directionLabel(early.side)} candidate. Full confirmation is incomplete: ${early.checks.filter(check => check.status === 'FAIL').map(check => check.label).join(' · ')}.` : prediction.reason
  const entry = activeTrade?.entryPrice ?? plan?.entry
  const recordQuoteAt = activeTrade?.latestPriceAt
  const useTick = (!activeTrade?.contract || tick?.token === activeTrade.contract.token && tick.exchangeType === 5) && tick?.ltp !== undefined && Number.isFinite(tick.ltp) && tick.ltp > 0 && (!activeTrade || (tickTimestamp(tick) >= (recordQuoteAt ?? activeTrade.entryAt ?? 0)))
  const quote = useTick ? tick?.ltp : activeTrade?.latestPrice
  const quoteAt = useTick ? tickTimestamp(tick!) : recordQuoteAt
  const quoteIsLive = useTick ? isFreshTick(tick, now) : activeTrade?.latestPriceSource === 'LIVE' && quoteAt !== undefined && now - quoteAt >= -5_000 && now - quoteAt <= 60_000
  const freshEntryQuote = Boolean(tick && isFreshTick(tick, now) && now - tickTimestamp(tick) <= 30_000)
  const live = streamConnected && quoteIsLive
  const current = quote ?? analysis.currentPrice
  const quoteLabel = quote !== undefined ? live ? `Live ${unit} price` : activeTrade?.latestPriceSource === 'CANDLE' && !useTick ? 'Last candle close' : `Last ${unit} quote` : 'Last closed candle'
  // This is instrument price movement, not an option premium or a rupee return.
  const movement = activeTrade?.entryPrice !== undefined && quote !== undefined ? (quote - activeTrade.entryPrice) * (activeTrade.side === 'CALL' ? 1 : -1) : undefined
  const points = movement === 0 ? 0 : movement
  const trailingStop = activeTrade?.protection?.armed ? activeTrade.protection.stop : undefined
  const initialRisk = activeTrade?.entryPrice !== undefined ? Math.abs(activeTrade.entryPrice - activeTrade.stopLoss) : undefined
  const currentR = points !== undefined && initialRisk !== undefined && initialRisk > 0 ? points / initialRisk : undefined
  const effectiveStop = trailingStop ?? plan?.stopLoss
  const progress = plan && quote !== undefined && effectiveStop !== undefined && plan.target !== effectiveStop ? Math.max(0, Math.min(100, (quote - effectiveStop) / (plan.target - effectiveStop) * 100)) : undefined
  const endedSetup = !activeTrade && prediction.side === 'WAIT' && Boolean(evidence?.canConfirm)
  const marketBias = evidence?.bias ?? analysis.earlyBias
  const marketTone = endedSetup ? 'neutral' : marketBias === 'BULLISH' ? 'bullish' : marketBias === 'BEARISH' ? 'bearish' : 'neutral'
  const direction = marketBias === 'BULLISH' ? directionLabel('CALL') : marketBias === 'BEARISH' ? directionLabel('PUT') : 'NEUTRAL'
  const marketView = endedSetup ? 'SETUP ENDED · WAIT FOR A FRESH SETUP' : risky ? `RISKY ${directionLabel(plan.side)}` : marketBias === 'NEUTRAL' ? 'NEUTRAL' : evidence ? evidence.canConfirm && 'plan' in prediction && prediction.plan.stage === 'CONFIRMED' ? `CONFIRMED ${direction}` : `EARLY ${direction}` : analysis.earlyStage === 'TRIGGER' ? `${direction} TRIGGER` : analysis.earlyStage === 'CONFIRMED' ? `CONFIRMED ${direction}` : `EARLY ${direction}`
  const blockedSide = marketBias === 'BULLISH' ? 'CALL' : marketBias === 'BEARISH' ? 'PUT' : undefined
  const blockedDecision = evidence?.decisions?.find(decision => decision.side === blockedSide && decision.state !== 'CONFIRMED')
  const setupBlockers = blockedDecision?.checks.filter(check => check.status === 'FAIL') ?? []
  const bullishScore = evidence?.bullishScore ?? analysis.bullishScore, bearishScore = evidence?.bearishScore ?? analysis.bearishScore
  const bullishEvidence = evidence?.bullishEvidence ?? analysis.bullishEvidence, bearishEvidence = evidence?.bearishEvidence ?? analysis.bearishEvidence
  const strength = endedSetup ? 'ENTRY RETIRED' : risky ? 'PARTIAL ALIGNMENT' : evidence ? Math.max(bullishScore, bearishScore) < 30 ? 'NO BIAS' : marketBias === 'NEUTRAL' ? 'CONFLICTED' : Math.max(bullishScore, bearishScore) < evidence.requiredScore ? 'WEAK' : 'ALIGNED' : analysis.earlyStrength.replace(/_/g, ' ')
  const details = [['Structure', analysis.structure], ['Location', risky && plan.risk ? `Proposed ${plan.risk.levelType.toLowerCase()} reaction at ${price(plan.risk.level)}` : analysis.location], ['Last closed candle', analysis.candleBehavior], ['Setup', risky ? 'Risky level setup · Confirmation pending' : analysis.setup]]
  const historical = analysis.latestCandleTime && now - Date.parse(analysis.latestCandleTime) > 2 * candleIntervalMs(interval)

  return (
    <div className={`agent-trade-card agent-tone-${tone}`}>
      <div className="agent-trade-heading">
        <strong className="agent-trade-title"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true"><path d="M3 17l6-6 4 3 8-9M15 5h6v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>{activeTrade || plan?.stage === 'CONFIRMED' ? 'Agent Trade' : 'Trading Prediction Agent'}</strong>
        <span className={`agent-trade-status ${activeTrade ? 'is-open' : risky ? 'is-risky' : ''}`} role="status">{status}</span>
      </div>
      <div className="agent-trade-direction-row">
        <strong className="agent-trade-direction">{side === 'WAIT' ? 'WAIT' : `${directionLabel(side)} · ${side === 'CALL' ? 'BULLISH' : 'BEARISH'}`}</strong>
        <div className="agent-trade-instrument"><strong>{instrument}</strong>{plan?.contract && <span>{plan.contract.symbol} · Expiry {plan.contract.expiry}</span>}<span>Analysis: {timeframe(interval)} · {commodity ? 'MCX futures levels' : 'Index levels'}{activeTrade && activeTrade.interval !== interval ? ` · Open trade: ${timeframe(activeTrade.interval)}` : ''}</span></div>
      </div>
      {!streamConnected && <p className="agent-entry-status" role="status">Live stream disconnected · New entries paused; saved trade monitoring continues.</p>}
      {heldContractNotice && <p className="agent-entry-status" role="status">{heldContractNotice}</p>}
      {activeTrade?.entryAt !== undefined && now >= squareOffTime(activeTrade.entryAt, instrument) && <p className="agent-entry-status" role="status">{squareOffLabel(instrument, activeTrade.entryAt)} IST square-off is due · Waiting for an observed exit quote. No exit price has been assumed.</p>}
      {streamConnected && (!isFreshTick(tick, now) || !activeTrade && !freshEntryQuote) && <p className="agent-entry-status" role="status">Waiting for a fresh instrument quote · Entry requires a quote no more than 30 seconds old.</p>}
      <div className="early-prediction-result" aria-live="polite"><p>{reason}</p></div>
      {!activeTrade && plan?.stage !== 'CONFIRMED' && blockedDecision && setupBlockers.length > 0 && <div className="agent-risk-details" role="status" aria-label="Current setup blockers">
        <strong>{directionLabel(blockedDecision.side)} setup waiting for</strong>
        <ul>{setupBlockers.map(check => <li key={check.code}>{check.label}: {check.detail}</li>)}</ul>
        {analysis.setupDiagnostics?.map(detail => <p key={detail}>{detail}</p>)}
      </div>}
      {risky && plan.risk && <div className="agent-risk-details" role="status"><strong>Elevated-risk setup · {plan.risk.passedChecks}/7 full-confirmation checks passed</strong><p>{plan.risk.levelType === 'SUPPORT' ? 'Support' : 'Resistance'} {price(plan.risk.level)} · Matched route: {plan.risk.alignedIndicators.join(' or ')}</p><p>Still missing: {plan.risk.unmetChecks.join(' · ')}{plan.risk.opposedIndicators.length > 0 && ` · Conflicting indicators: ${plan.risk.opposedIndicators.join(' · ')}`}</p><p>The proposed levels pass ATR and {minimumRewardRisk.toFixed(2)}:1 reward/risk checks. Full confirmation still needs a valid completed setup and a fresh live quote.</p></div>}
      {!plan && current !== undefined && <div className="agent-quote-preview"><span>{quoteLabel}</span><strong>{price(current)}</strong><small>{time(quoteAt ?? (analysis.latestCandleTime ? Date.parse(analysis.latestCandleTime) : undefined))}</small></div>}
      {plan && <dl className="agent-trade-facts">
        <div><dt>{activeTrade ? `Entry (${unit})` : `Entry trigger (${unit})`}</dt><dd>{price(entry)}</dd></div>
        <div><dt>{quoteLabel}</dt><dd className={live ? 'agent-text-bullish' : ''}>{price(current)}</dd><small>{quoteAt !== undefined ? time(quoteAt) : analysis.latestCandleTime ? time(Date.parse(analysis.latestCandleTime)) : 'Waiting for data'}</small></div>
        <div><dt>{activeTrade ? 'Entry time' : 'Setup time'}</dt><dd className="agent-trade-time">{time(activeTrade?.entryAt ?? (pendingTrade?.id === plan?.id ? pendingTrade?.generatedAt : plan?.generatedAt))}</dd></div>
        <div><dt>{activeTrade ? 'Trade timeframe' : 'Analysis timeframe'}</dt><dd className="agent-trade-time">{timeframe(activeTrade?.interval ?? interval)}</dd></div>
        <div><dt>Initial stop-loss ({unit})</dt><dd className="agent-text-bearish">{price(plan?.stopLoss)}</dd><small>{activeTrade ? trailingStop !== undefined ? `Auto TSL ${price(trailingStop)} · Tightens only` : 'TSL waits for a fresh observed quote' : plan.stage === 'CONFIRMED' ? 'Auto TSL starts after observed entry' : 'TSL starts only after confirmed entry'}</small></div>
        {activeTrade && <div><dt>Current TSL ({unit})</dt><dd className="agent-text-bearish">{price(effectiveStop)}</dd><small>{trailingStop !== undefined ? 'Automatic · Tightens only' : 'Initial SL · Waiting for fresh quote'}</small></div>}
        <div><dt>Reference target ({unit})</dt><dd className="agent-text-bullish">{price(plan?.target)}</dd><small>Entry reward/risk reference · Profit can continue beyond it</small></div>
      </dl>}
      {plan && !activeTrade && <div className="agent-trade-progress" aria-label="Instrument price between initial stop and reference target">
        <div className="agent-trade-progress-track">{progress !== undefined && <span className="agent-trade-progress-marker" style={{ '--trade-progress': `${progress}%` } as CSSProperties} />}</div>
        <div className="agent-trade-progress-labels"><span>SL <strong>{price(effectiveStop)}</strong></span><span>{quote === undefined ? 'Waiting for quote' : `${live ? 'Now' : 'Last'} ${price(quote)}`}</span><span>REF <strong>{price(plan.target)}</strong></span></div>
      </div>}
      {plan && <div className="agent-trade-summary">
        <div><span>{activeTrade ? 'Unrealized profit / loss' : 'Trade profit / loss'}</span><strong className={points !== undefined ? points >= 0 ? 'agent-text-bullish' : 'agent-text-bearish' : ''}>{points === undefined ? '—' : `${points > 0 ? '+' : ''}${price(points)} pts`}</strong><small>{activeTrade ? live ? `${unit} points · Live quote` : `${unit} points · Last available quote` : 'Available after confirmed entry'}</small></div>
        <div><span>{activeTrade ? 'Current return / initial risk' : 'Planned reward : risk'}</span><strong>{activeTrade ? currentR === undefined ? '—' : `${currentR > 0 ? '+' : ''}${currentR.toFixed(2)}R` : `${plan.riskReward.toFixed(2)} : 1`}</strong><small>{activeTrade ? 'Open profit · Exit managed by TSL, reversal or square-off' : `Entry minimum ${minimumRewardRisk.toFixed(2)}:1 · Reference ${unit} levels`}</small></div>
      </div>}
      {plan && <p className="agent-trade-note">{activeTrade ? 'Agent-managed exit · One live trade per instrument' : plan.stage === 'CONFIRMED' ? 'Conditional entry · Current setup must remain confirmed · Trade tracking starts when entry is observed' : risky ? 'Risky conditional setup · Full confirmation incomplete' : 'Early analysis only · Not recorded as a trade'} · {plan.strategyVersion === 'technical-v2' ? 'Technical confirmation · Sentiment is reference only' : 'Recorded under the previous strategy'}<br />{plan.targetBasis}{activeTrade && <><br />Automatic TSL · {protectionRules.atrMultiplier}× completed-frame ATR, at least {protectionRules.minimumTrailR}R and two ticks · Break-even at +{protectionRules.breakEvenR}R · Exit uses an observed quote. {/recovering|waiting for complete candle history/i.test(activeTrade.outcomeNote) ? 'Paused for history recovery' : live ? 'Live monitoring' : 'Waiting for fresh quotes; local protection cannot execute offline'}.</>}</p>}

      <div className="agent-market-view">
        <div className="agent-market-view-heading"><strong className={`agent-text-${marketTone}`}>Technical analysis: {marketView}</strong><span>· {strength}</span></div>
        <p className="agent-analysis-time">{timeframe(interval)} analysis · {analysis.analyzedCandles} completed candles · Forming candle excluded{analysis.latestCandleTime && <> · Candle closed <time dateTime={new Date(Date.parse(analysis.latestCandleTime) + candleIntervalMs(interval)).toISOString()}>{time(Date.parse(analysis.latestCandleTime) + candleIntervalMs(interval))}</time></>}{historical ? ' · Historical snapshot' : ''}</p>
        <div className="agent-evidence-scores"><span className="agent-text-bullish">Bullish score: <strong>{bullishScore}/100</strong></span><span className="agent-text-bearish">Bearish score: <strong>{bearishScore}/100</strong></span></div>
        <p className="agent-score-note">Technical evidence scores, not probabilities.{evidence && ` Technical coverage: ${evidence.coverage}%.`} Sentiment cannot create or veto a confirmed trade.</p>
        {analysis.alignment && <details className="agent-evidence-checks agent-directional-routes"><summary>Directional alignment · EMA or Supertrend or support/resistance</summary>
          <p>One directional route plus completed price confirmation can qualify. The remaining technical score and risk checks still apply.</p>
          <ul>{(['CALL', 'PUT'] as const).map(routeSide => <li key={routeSide}><strong className={`agent-text-${routeSide === 'CALL' ? 'bullish' : 'bearish'}`}>{directionLabel(routeSide)}</strong><span>{analysis.alignment!.routes.filter(route => route.side === routeSide).map(route => route.name).join(' · ') || 'No directional route currently matched'}</span></li>)}</ul>
        </details>}
        <div className="agent-evidence-columns">
          {([['Bullish evidence', bullishEvidence, 'bullish'], ['Bearish evidence', bearishEvidence, 'bearish']] as const).map(([label, items, evidenceTone]) => (
            <details key={label} className="agent-evidence-disclosure">
              <summary className={`agent-text-${evidenceTone}`}>{label}</summary>
              {items.length ? <ul>{items.map(item => <li key={item}>{item}</li>)}</ul> : <p>None currently</p>}
            </details>
          ))}
        </div>
      </div>
      {evidence?.historicalOutcomes && <section className="agent-history-reference" aria-label="Historical probability reference">
        <strong>Similar historical conditions · {evidence.historicalOutcomes.status === 'READY' ? evidence.historicalOutcomes.bias.replace('MIXED', 'Mixed outcomes') : 'Insufficient history'}</strong>
        {evidence.historicalOutcomes.status === 'READY' && <>
          <div className="agent-evidence-scores"><span className="agent-text-bullish">Up: <b>{evidence.historicalOutcomes.upPercent!.toFixed(1)}%</b></span><span className="agent-text-bearish">Down: <b>{evidence.historicalOutcomes.downPercent!.toFixed(1)}%</b></span><span>Flat: <b>{evidence.historicalOutcomes.flatPercent!.toFixed(1)}%</b></span></div>
          <p className="agent-score-note">{evidence.historicalOutcomes.samples} similar past cases · {evidence.historicalOutcomes.sessions} sessions · Next {evidence.historicalOutcomes.horizonBars} candles · These are observed outcome rates, not live forecast probabilities.</p>
          <p className="agent-score-note">95% Wilson sampling ranges: Up {evidence.historicalOutcomes.upInterval!.map(value => `${value.toFixed(1)}%`).join('–')} · Down {evidence.historicalOutcomes.downInterval!.map(value => `${value.toFixed(1)}%`).join('–')}. Market dependence adds uncertainty.</p><details className="agent-evidence-checks"><summary>Comparison method</summary><p>{evidence.historicalOutcomes.message}</p></details>
        </>}
        {evidence.historicalOutcomes.status !== 'READY' && <p className="agent-score-note">{evidence.historicalOutcomes.message}</p>}
        <p className="agent-score-note">History provides directional context. Confirmation still needs a current price setup, ATR risk checks and a fresh live quote.{analysis.side === 'WAIT' && /indecis|doji/i.test(analysis.candleBehavior) && ' An indecisive candle alone confirms neither direction.'}</p>
        {analysis.side === 'WAIT' && (analysis.bullishTrigger !== undefined || analysis.bearishTrigger !== undefined) && <p className="agent-score-note">Watch levels: upside {price(analysis.bullishTrigger)} · downside {price(analysis.bearishTrigger)}. A break must form a valid completed setup.</p>}
      </section>}
      <dl className="agent-structure-details" tabIndex={0} aria-label="Scroll market structure details horizontally">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {evidence?.checks && <details className="agent-evidence-checks agent-confirmation-checks"><summary>Confirmation checks · {evidence.checks.filter(check => check.passed).length}/{evidence.checks.length} passed</summary>
        <ul>{evidence.checks.map(check => <li key={check.label}><strong className={check.passed ? 'agent-text-bullish' : 'agent-text-bearish'}>{check.passed ? '✓' : 'Waiting'} · {check.label}</strong><span>{check.detail}</span></li>)}</ul>
      </details>}
      <AgentMonitoringPanel instrument={instrument} records={records} plan={plan} active={Boolean(activeTrade)} now={now} frontContract={frontContract} candles={replayCandles} tick={tick} issuedAt={pendingTrade?.id === plan?.id ? pendingTrade?.generatedAt : undefined} />
      {evidence?.decisions && <TradeDecisionPanel retired={endedSetup} decisions={evidence.decisions} instrument={instrument} plan={plan} tick={tick} connected={streamConnected} now={now} active={Boolean(activeTrade)} issuedAt={pendingTrade?.generatedAt} />}
      {evidence && <details className="agent-evidence-checks"><summary>Inputs & confirmation checks · {evidence.coverage}% available</summary>
        <ScoreContributions layers={evidence.layers} />
        <p>Confirmation needs a completed chart setup, warmed-up EMA(20/50), RSI and Supertrend, ≥70% technical coverage, ≥{evidence.requiredScore} directional support and a ≥{evidence.requiredGap}-point lead. {commodity ? 'ATR provides commodity risk checks; India VIX is excluded.' : 'ATR and India VIX provide risk checks.'} Directional alignment accepts EMA trajectory/crossover OR Supertrend trajectory/flip OR support/resistance break/reversal. A completed price pattern and the score and risk checks are still required.</p>
        <ul>{evidence.riskNotes.map(note => <li key={note}>{note}</li>)}{evidence.missing.map(item => <li key={item}>Unavailable: {item}</li>)}</ul>
      </details>}
      {evidence && <section className="agent-sentiment-view" aria-label="Market sentiment reference">
        <div className="agent-market-view-heading"><strong className={`agent-text-${evidence.sentiment.bias === 'BULLISH' ? 'bullish' : evidence.sentiment.bias === 'BEARISH' ? 'bearish' : 'neutral'}`}>Market sentiment: {evidence.sentiment.bias}</strong><span>{evidence.sentiment.alignment.replace(/_/g, ' ')}</span></div>
        <div className="agent-evidence-scores"><span className="agent-text-bullish">Bullish: <strong>{evidence.sentiment.bullishScore}/100</strong></span><span className="agent-text-bearish">Bearish: <strong>{evidence.sentiment.bearishScore}/100</strong></span></div>
        <p className="agent-score-note">{commodity ? 'Commodity news · Global futures benchmarks · Currency reference. Equity flows and India VIX are excluded.' : 'FII/DII · Indian & global news · Global markets · PCR reference.'} Sentiment coverage: {evidence.sentiment.coverage}%. Evidence ratings, not probabilities.</p>
        <p className={evidence.sentiment.alignment === 'OPPOSES' ? 'agent-text-bearish' : 'agent-score-note'} role="status">{evidence.sentiment.reason}</p>
        <details className="agent-evidence-checks"><summary>Sentiment inputs · Reference only</summary>
          <ScoreContributions layers={evidence.sentiment.layers} />
          <p>PCR is shared with technical analysis; sentiment never adds a second PCR vote to the technical score.</p>
          <div className="agent-evidence-columns">{([['Bullish sentiment', evidence.sentiment.bullishEvidence, 'bullish'], ['Bearish sentiment', evidence.sentiment.bearishEvidence, 'bearish']] as const).map(([label, items, sentimentTone]) => <div key={label}><strong className={`agent-text-${sentimentTone}`}>{label}</strong>{items.length ? <ul>{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : <p>None currently</p>}</div>)}</div>
          {evidence.sentiment.missing.length > 0 && <ul>{evidence.sentiment.missing.map(item => <li key={item}>Unavailable: {item}</li>)}</ul>}
        </details>
      </section>}
    </div>
  )
}
