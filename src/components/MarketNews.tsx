import type { MarketContext, MarketOutlook } from '../api/marketContext'
import { buildNewsEvidence } from '../analysis/newsEvidence'

const sentimentOrder: Record<string, number> = { POSITIVE: 0, TEXT_POSITIVE: 0, NEGATIVE: 1, TEXT_NEGATIVE: 1, NEUTRAL: 2, TEXT_NEUTRAL: 2 }

function publishedTime(value: string, now: number) {
  const date = new Date(value)
  const day = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time)
  const label = day(date.getTime()) === day(now) ? 'Today' : day(date.getTime()) === day(now - 86_400_000) ? 'Yesterday' : date.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })
  return `${label} · ${date.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST`
}

export default function MarketNews({ context, outlook, now, loading, embedded = false, weight }: { context: MarketContext | null; outlook?: MarketOutlook; now: number; loading: boolean; embedded?: boolean; weight?: number }) {
  const news = buildNewsEvidence(context, outlook, now)
  const headlines = [...news.headlines].sort((a, b) => (sentimentOrder[a.status] ?? 3) - (sentimentOrder[b.status] ?? 3))
  const tone = news.score === undefined || news.score === 0 ? 'neutral' : news.score > 0 ? 'positive' : 'negative'
  const score = news.score === undefined ? '—' : `${news.score > 0 ? '+' : ''}${news.score.toFixed(2)}`
  const labels: Record<string, string> = { POSITIVE: '+ve', NEGATIVE: '-ve', NEUTRAL: 'Neutral', UNCLEAR: 'Unclear', UNRATED: outlook?.assessmentStatus ? 'Unavailable' : 'Pending analysis', STALE: 'Stale', TEXT_POSITIVE: 'Text +ve', TEXT_NEGATIVE: 'Text -ve', TEXT_NEUTRAL: 'Text neutral', TEXT_UNCLEAR: 'Text unclear' }
  return <section className={`market-news-panel news-${tone}${embedded ? ' is-embedded agent-analysis-tile' : ''}`} aria-label={embedded ? 'News analysis' : 'Market news and impact'}>
    <div className="market-news-heading"><h3>{embedded ? 'News' : 'News & market impact'}</h3>{weight !== undefined && <span className="agent-analysis-weight" title="Planned dashboard weight">{weight}%</span>}</div>
    <p className="market-context-note">{news.assessed}/{news.articles.length} headlines assessed{loading ? ' · Updating…' : ''} · {news.positive} positive · {news.negative} negative</p>
    {outlook?.assessmentStatus && <p className="market-context-note" role="status">{outlook.assessmentStatus.message}{outlook.assessmentStatus.textOnly > 0 ? ` ${outlook.assessmentStatus.textOnly} locally text-rated; excluded from market-impact scores.` : ''}</p>}
    <div className="market-news-score"><strong>{score}</strong><div className="market-news-score-track" aria-hidden="true"><span style={{ left: `${news.score !== undefined && news.score < 0 ? 50 + news.score * 25 : 50}%`, width: `${Math.abs(news.score ?? 0) * 25}%` }} /></div></div>
    <p className="market-context-note">Potential impact on {context?.instrument || 'the selected instrument'} · −2 to +2 · AI evidence ratings, not probabilities.</p>
    {headlines.length ? <ul className="market-news-list">{headlines.map(headline => <li key={headline.article.id} className={`news-item-${headline.status.replace('TEXT_', '').toLowerCase()}`}>
      <div className="market-news-article"><a href={headline.article.url} target="_blank" rel="noopener noreferrer">{headline.article.title}</a><div className="market-news-meta">{headline.topic} · {publishedTime(headline.article.publishedAt, now)} · {headline.article.publisher}</div>{headline.source && <div className="market-news-meta">{headline.source === 'LOCAL_FINBERT' ? 'Local text sentiment' : 'Gemini impact assessment'}{headline.assessedAt ? ` · Assessed ${publishedTime(headline.assessedAt, now)}` : ''}</div>}{headline.article.matchedCompanies.length > 0 && <div className="market-news-meta">{headline.article.matchedCompanies.join(' · ')}</div>}{headline.reason && <p className="market-news-reason">{headline.reason}</p>}</div>
      <span className="market-news-impact" title={headline.reason || (headline.eligible ? 'Awaiting a current AI assessment of this headline.' : 'This source is stale or unavailable; excluded from current analysis.')}>{labels[headline.status]}{headline.score !== undefined ? ` ${headline.score > 0 ? '+' : ''}${headline.score}` : ''}</span>
    </li>)}</ul> : <p className="market-news-empty">{loading ? 'Loading public news…' : 'No recent public headlines available. Chart analysis continues.'}</p>}
    {news.headlines.length > 0 && news.assessed === 0 && <p className="market-context-note">Headlines are loaded. Impact badges appear when the agent’s AI assessment is available; unclear or stale news stays unscored.</p>}
  </section>
}
