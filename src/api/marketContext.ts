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
export type PublicSnapshot<T> = {
  status: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE'
  sourceUrl: string
  fetchedAt: string | null
  message: string | null
  data: T | null
}
export type InstitutionalFlow = { asOf: string; fiiCash: number; diiCash: number; netFlow: number; unit: 'INR_CRORE' }
export type GlobalQuote = { symbol: string; price: number; changePercent: number; change?: number | null; asOf: string; expiry?: string; timeBasis?: 'RECEIVED' | 'EXCHANGE' }
export type IndiaVixSnapshot = PublicSnapshot<GlobalQuote>
export type MarketInputs = {
  openInterest: PublicSnapshot<{ asOf: string; expiry: string; symbol: string; pcr: number; callWall: number; putWall: number; maxPain: number; callOi: number; putOi: number; callOiChange: number | null; putOiChange: number | null; unit: 'CONTRACTS' }>
  institutional: PublicSnapshot<InstitutionalFlow>
  participantPositions: PublicSnapshot<{ asOf: string; longPercent: number; shortPercent: number }>
  global: Array<PublicSnapshot<GlobalQuote> & { name: string }>
  giftNifty: PublicSnapshot<GlobalQuote>
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
  inputs?: MarketInputs
}
export type MarketOutlook = {
  bias: 'BULLISH' | 'BEARISH' | 'MIXED' | 'NEUTRAL' | 'UNAVAILABLE'
  agreement: 'SUPPORTS_CHART' | 'CONFLICTS_WITH_CHART' | 'MIXED' | 'INSUFFICIENT'
  summary: string
  evidenceIds: string[]
  contextRevision: string
  contextRetrievedAt: string
  articleSentiments?: Array<{ articleId: string; sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNCLEAR'; impactScore?: number; reason?: string; source?: 'GEMINI' | 'LOCAL_FINBERT'; scope?: 'MARKET_IMPACT' | 'TEXT_ONLY'; assessedAt?: string }>
  assessmentStatus?: { state: 'CACHED' | 'LOCAL' | 'UNAVAILABLE'; message: string; retryAt: string | null; assessed: number; total: number; textOnly: number }
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

export async function getIndiaVix(signal?: AbortSignal): Promise<IndiaVixSnapshot> {
  const response = await fetch('/api/india-vix', { signal })
  const snapshot = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(snapshot.message || 'India VIX public sources are unavailable.')
  if (!['AVAILABLE', 'STALE', 'UNAVAILABLE'].includes(snapshot.status) || (snapshot.data && (snapshot.data.symbol !== '^INDIAVIX' || !Number.isFinite(snapshot.data.price) || snapshot.data.price <= 0 || !Number.isFinite(snapshot.data.changePercent) || !Number.isFinite(Date.parse(snapshot.data.asOf))))) {
    throw new Error('India VIX source returned an invalid quote.')
  }
  return snapshot
}
