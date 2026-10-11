import type { MarketContext, MarketOutlook } from '../api/marketContext'

function time(value: string | null) {
  return value ? `${new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST` : 'Not available'
}

export default function MarketContextPanel({ context, loading, refresh, outlook, chartCurrent }: { context: MarketContext | null; loading: boolean; refresh: () => void; outlook?: MarketOutlook; chartCurrent: boolean }) {
  const currentOutlook = outlook && context?.revision === outlook.contextRevision ? outlook : null
  const evidence = new Set(currentOutlook?.evidenceIds || [])
  return (
    <div className="market-context-panel" aria-label="Public market context">
      <div className="market-context-heading">
        <strong>News & company context</strong>
        <button type="button" onClick={refresh} disabled={loading} aria-label="Refresh market context" title="Refresh market context">{loading ? 'Updating…' : '↻'}</button>
      </div>
      <p className="market-context-note">Free public feeds · May be delayed · Updates every 5 minutes</p>
      {context && !chartCurrent && <p className="market-context-note">Historical chart snapshot: waiting for recent completed candles for a combined outlook.</p>}
      {currentOutlook && chartCurrent && <div className="market-context-outlook" role="status">
        <strong>Combined early outlook: {currentOutlook.bias.replace(/_/g, ' ')}</strong>
        <span> · {currentOutlook.agreement.replace(/_/g, ' ').toLowerCase()}</span>
        <p>{currentOutlook.summary}</p>
      </div>}
      {!context && <p className="market-context-note">{loading ? 'Loading Indian news, global news and company announcements…' : 'Public context unavailable. The chart agent continues with technical analysis.'}</p>}
      {context && <>
        {!currentOutlook && chartCurrent && <p className="market-context-note">News interpretation is unavailable or still being checked. Any chart-only setup is labelled by the agent.</p>}
        <div className="market-context-feeds">
          {context.feeds.map(feed => <details key={feed.category} className="market-context-feed">
            <summary>{feed.name} <span>{feed.status === 'AVAILABLE' ? `${feed.items.length} headlines` : feed.status.toLowerCase()}</span></summary>
            <p className="market-context-note">Feed checked {time(feed.fetchedAt)}{feed.message ? ` · ${feed.message}` : ''}</p>
            {feed.items.length ? <ul>{feed.items.map(article => <li key={article.id} className={evidence.has(article.id) ? 'market-context-cited' : undefined}>
              <a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}</a>
              <div className="market-context-note">{article.publisher} · Published {time(article.publishedAt)}{article.matchedCompanies.length ? ` · ${article.matchedCompanies.join(', ')}` : ''}{evidence.has(article.id) ? ' · Cited by outlook' : ''}</div>
            </li>)}</ul> : <p className="market-context-note">{feed.status === 'AVAILABLE' ? 'No matching headlines in the last 48 hours. This does not imply a neutral market.' : 'Current evidence is unavailable.'}</p>}
          </details>)}
        </div>
        <details className="market-context-companies">
          <summary>{context.instrument} companies · {context.constituents.companies.length} loaded · {context.constituents.status.toLowerCase()}</summary>
          <p className="market-context-note"><a href={context.constituents.sourceUrl} target="_blank" rel="noopener noreferrer">{context.constituents.publisher}</a> · Fetched {time(context.constituents.fetchedAt)} · Current weights and company price breadth unavailable</p>
          <div className="market-context-company-list">{context.constituents.companies.map(company => <span key={company.symbol}>{company.name}</span>)}</div>
        </details>
        <details className="market-context-companies">
          <summary>Global company watchlist</summary>
          <p className="market-context-note">Potential sector exposure to investigate; these companies are not Indian index constituents.</p>
          <div className="market-context-company-list">{context.globalWatchlist.map(company => <span key={company.name}>{company.name} · {company.channel}</span>)}</div>
        </details>
      </>}
    </div>
  )
}
