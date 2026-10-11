export type MarketArticle = {
  id: string
  title: string
  url: string
  publisher: string
  publishedAt: string
  category: 'india' | 'global' | 'companies' | 'globalCompanies'
  matchedCompanies: string[]
  description?: string
}
export type MarketContext = {
  instrument: string
  revision: string
  retrievedAt: string
  delayNotice: string
  constituents: {
    companies: Array<{ name: string; symbol: string; sector: string; asOf: string | null }>
    sourceUrl: string
    publisher: string
    fetchedAt: string | null
    status: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE'
    message: string | null
    weightsAvailable: boolean
  }
  globalWatchlist: Array<{ name: string; channel: string }>
  feeds: Array<{
    category: MarketArticle['category']
    name: string
    url: string
    status: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE'
    fetchedAt: string | null
    message: string | null
    items: MarketArticle[]
  }>
  articles: MarketArticle[]
}
export type MarketOutlook = {
  bias: 'BULLISH' | 'BEARISH' | 'MIXED' | 'NEUTRAL' | 'UNAVAILABLE'
  agreement: 'SUPPORTS_CHART' | 'CONFLICTS_WITH_CHART' | 'MIXED' | 'INSUFFICIENT'
  summary: string
  evidenceIds: string[]
  contextRevision: string
  contextRetrievedAt: string
}

export async function getMarketContext(instrument: string, signal?: AbortSignal): Promise<MarketContext> {
  const response = await fetch(`/api/market-context?${new URLSearchParams({ instrument })}`, { signal })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || 'Public market feeds are unavailable. Chart analysis continues.')
  if (data.instrument !== instrument || !Array.isArray(data.feeds) || !Array.isArray(data.articles) || !data.constituents || typeof data.revision !== 'string') {
    throw new Error('Market context returned an invalid response. Restart the backend and retry.')
  }
  return data
}
