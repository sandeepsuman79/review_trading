import { isCommodity } from '../analysis/commodities'
import type { CSSProperties, ReactNode } from 'react'
import type { AngelOneCandle } from '../api/angelOne'
import type { InstitutionalFlow, MarketContext, MarketOutlook } from '../api/marketContext'
import type { PriceActionAnalysis } from '../analysis/priceAction'
import { buildMarketDashboard, signedMarketValue, type AnalysisTile } from '../analysis/marketDashboard'
import MarketNews from './MarketNews'
import { useInstitutionalFlows } from '../hooks/useInstitutionalFlows'

function time(value?: string | null) {
  return value ? `${new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST` : 'Not available'
}

function reportDate(value: string) {
  return new Date(value).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
}

const icons: Record<string, string> = { chart: '↗', indicators: '≋', oi: '▥', flows: '⇄', news: '▤', global: '◎' }

function AnalysisCard({ tile, children }: { tile: AnalysisTile; children?: ReactNode }) {
  const tone = tile.score === undefined ? 'missing' : tile.score > .15 ? 'bullish' : tile.score < -.15 ? 'bearish' : 'neutral'
  return (
    <section className={`agent-analysis-tile analysis-${tone}`} aria-label={`${tile.title} analysis`}>
      <div className="agent-analysis-tile-heading"><h3><span aria-hidden="true">{icons[tile.key]}</span>{tile.title}</h3><span className="agent-analysis-weight" title="Planned dashboard weight">{tile.weight}%</span></div>
      <div className="agent-analysis-score-row"><strong>{tile.score === undefined ? '—' : signedMarketValue(tile.score)}</strong><div className="agent-analysis-score-track" aria-hidden="true"><span style={{ left: `${tile.score !== undefined && tile.score < 0 ? 50 + tile.score / 2 * 50 : 50}%`, width: `${Math.abs(tile.score ?? 0) / 2 * 50}%` }} /></div></div>
      <div className="agent-analysis-badges"><span className="agent-analysis-bias">{tone === 'missing' ? 'Unavailable' : tone === 'bullish' ? 'Bullish' : tone === 'bearish' ? 'Bearish' : 'Neutral / mixed'}</span>{tile.status !== 'Unavailable' && <small>{tile.status}</small>}</div>
      <dl className={`agent-analysis-values${tile.key === 'global' ? ' agent-global-values' : ''}`}>{tile.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={tile.rowDetails?.[label] ? `global-cue-${tile.rowDetails[label].tone}` : undefined}><span>{value}</span>{tile.rowDetails?.[label]?.caption && <small className="agent-global-cue">{tile.rowDetails[label].caption}</small>}</dd></div>)}</dl>
      {tile.asOf && <p className="market-context-note">{tile.asOfDateOnly ? `Report date ${reportDate(tile.asOf)}` : `As of ${time(tile.asOf)}`}</p>}
      {children}
      <details className="agent-analysis-method"><summary>Score & source details</summary><p>{tile.note}</p>{tile.sourceUrl && <a href={tile.sourceUrl} target="_blank" rel="noopener noreferrer">View source ↗</a>}</details>
    </section>
  )
}

function FlowTrend({ history }: { history: InstitutionalFlow[] }) {
  const recent = history.slice(-5), max = Math.max(1, ...recent.map(flow => Math.abs(flow.fiiCash)))
  return (
    <div className="agent-flow-trend">
      <div className="agent-flow-trend-heading"><strong>FII cash · Observed sessions</strong><span>{recent.length}/5 saved</span></div>
      {recent.length ? <>
        <div className="agent-flow-bars" role="img" aria-label={recent.map(flow => `${reportDate(flow.asOf)}: ${signedMarketValue(flow.fiiCash)} crore`).join('; ')}>{recent.map(flow => <div key={flow.asOf} title={`${reportDate(flow.asOf)} · ₹${signedMarketValue(flow.fiiCash)} cr`}><span className={flow.fiiCash >= 0 ? 'positive' : 'negative'} style={{ '--flow-size': `${Math.abs(flow.fiiCash) / max * 45}%` } as CSSProperties} /><small>{new Date(flow.asOf).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })}</small></div>)}</div>
        <p className="market-context-note">{recent.length === 5 ? `FII last 5 observed reports: ₹${signedMarketValue(recent.reduce((sum, flow) => sum + flow.fiiCash, 0))} cr · Selling in ${recent.filter(flow => flow.fiiCash < 0).length}/5 reports` : 'Daily observations accumulate in this browser. A full five-session trend is not yet available.'}</p>
      </> : <p className="market-context-note">Waiting for a published daily flow report.</p>}
    </div>
  )
}

export default function MarketContextPanel({ context, loading, refresh, outlook, chartCurrent, analysis, candles, openingCandles, now, children, instrument = context?.instrument }: {
  instrument?: string
  context: MarketContext | null
  loading: boolean
  refresh: () => void
  outlook?: MarketOutlook
  chartCurrent: boolean
  analysis: PriceActionAnalysis
  candles: AngelOneCandle[]
  openingCandles: AngelOneCandle[]
  now: number
  children?: ReactNode
}) {
  const commodity = isCommodity(instrument)
  const { history: flowHistory, storageError: flowStorageError } = useInstitutionalFlows(context?.inputs?.institutional)
  const dashboard = buildMarketDashboard({ analysis, candles, openingCandles, context, outlook, chartCurrent, now, instrument })
  const evidence = new Set(dashboard.currentOutlook?.evidenceIds || [])

  return (
    <div className="market-context-panel" aria-label="Agent analysis dashboard">
      <div className="market-context-heading"><strong>What the agent analysed</strong><div className="agent-analysis-heading-actions"><span>Score: −2 bearish to +2 bullish</span><button type="button" onClick={refresh} disabled={loading} aria-label="Refresh market context" title="Refresh market context">{loading ? '…' : '↻'}</button></div></div>
      <p className="market-context-note">Free public feeds · May be delayed · Reviewed every minute · Headlines may refresh less often{loading ? ' · Updating…' : ''}</p>
      {!chartCurrent && <p className="market-context-note">Historical chart snapshot: waiting for recent completed candles.</p>}
      <p className="market-context-note">Swipe or scroll horizontally to view all cards.</p>
      <div className="agent-analysis-grid" tabIndex={0} role="region" aria-label="Scroll agent analysis cards horizontally">{children}{dashboard.tiles.map(tile => tile.key === 'news' ? <MarketNews key={tile.key} context={context} outlook={outlook} now={now} loading={loading} embedded weight={tile.weight} /> : <AnalysisCard key={tile.key} tile={tile}>
        {tile.key === 'flows' && !commodity && <><FlowTrend history={flowHistory} />{flowStorageError && <p className="market-context-note">Daily flow history could not be saved in this browser.</p>}{context?.inputs?.participantPositions.data && <p className="market-context-note"><a href={context.inputs.participantPositions.sourceUrl} target="_blank" rel="noopener noreferrer">Index futures positions ↗</a> · {reportDate(context.inputs.participantPositions.data.asOf)}</p>}</>}
        {tile.key === 'global' && <details className="agent-global-sources"><summary>Quote timestamps & sources</summary>{!commodity && context?.inputs?.giftNifty && <p><a href={context.inputs.giftNifty.sourceUrl} target="_blank" rel="noopener noreferrer">GIFT Nifty futures ↗</a> · {context.inputs.giftNifty.status.toLowerCase()} · {time(context.inputs.giftNifty.data?.asOf)}{context.inputs.giftNifty.data?.expiry ? ` · Expiry ${context.inputs.giftNifty.data.expiry}` : ''}</p>}{context?.inputs?.global.map(quote => <p key={quote.name}><a href={quote.sourceUrl} target="_blank" rel="noopener noreferrer">{quote.name} ↗</a> · {quote.status.toLowerCase()} · {time(quote.data?.asOf)}</p>)}</details>}
      </AnalysisCard>)}</div>
      <p className="market-context-note">Weights: Chart 22% · Indicators 22% · OI 18% · FII/DII 13% · News 12% · Global 13%. Scores are evidence ratings, not probabilities. Missing inputs remain unavailable. The trade agent retains its completed-candle confirmation and automatic-exit rules.</p>
      {context && <details className="agent-analysis-sources"><summary>Headlines & company sources</summary><div className="market-context-feeds">
        {context.feeds.map(feed => <details key={feed.category} className="market-context-feed"><summary>{feed.name} <span>{feed.status === 'AVAILABLE' ? `${feed.items.length} headlines` : feed.status.toLowerCase()}</span></summary><p className="market-context-note">Feed checked {time(feed.fetchedAt)}{feed.message ? ` · ${feed.message}` : ''}</p>{feed.items.length ? <ul>{feed.items.map(article => <li key={article.id} className={evidence.has(article.id) ? 'market-context-cited' : undefined}><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}</a><div className="market-context-note">{article.publisher} · {time(article.publishedAt)}{article.matchedCompanies.length ? ` · ${article.matchedCompanies.join(', ')}` : ''}{evidence.has(article.id) ? ' · Cited by outlook' : ''}</div></li>)}</ul> : <p className="market-context-note">{feed.status === 'AVAILABLE' ? 'No matching headlines in the last 48 hours.' : 'Current evidence unavailable.'}</p>}</details>)}
      </div>{!commodity && <><details className="market-context-companies"><summary>{context.instrument} companies · {context.constituents.companies.length} loaded · {context.constituents.status.toLowerCase()}</summary><p className="market-context-note"><a href={context.constituents.sourceUrl} target="_blank" rel="noopener noreferrer">{context.constituents.publisher}</a> · {time(context.constituents.fetchedAt)} · Current company weights and price breadth unavailable</p><div className="market-context-company-list">{context.constituents.companies.map(company => <span key={company.symbol}>{company.name}</span>)}</div></details><details className="market-context-companies"><summary>Global company watchlist</summary><p className="market-context-note">Potential sector exposure to investigate.</p><div className="market-context-company-list">{context.globalWatchlist.map(company => <span key={company.name}>{company.name} · {company.channel}</span>)}</div></details></>}</details>}
    </div>
  )
}
