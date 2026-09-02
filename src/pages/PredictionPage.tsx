import { FormEvent, useEffect, useMemo, useState } from 'react'
import { predictions as staticPredictions } from '../data/predictions'
import type { IndexPrediction } from '../data/predictions'
import { createGttRule, getAngelOneProfile, getAngelOneRms, getGttRuleDetails, listGttRules, modifyGttRule, cancelGttRule, refreshAngelOneToken } from '../api/angelOne'
import type { AngelOneGttRule, AngelOneProfile, AngelOneRms } from '../api/angelOne'

const liveIndexSymbols = [
  { index: 'Nifty 50', symbol: 'NSEI', yahooSymbol: '^NSEI' },
  { index: 'Sensex', symbol: 'BSESN', yahooSymbol: '^BSESN' },
  { index: 'Bank Nifty', symbol: 'BANKNIFTY', yahooSymbol: '^NSEBANK' },
  { index: 'Nifty IT', symbol: 'NIFTY_IT', yahooSymbol: '^CNXIT' },
  { index: 'Nifty FMCG', symbol: 'NIFTY_FMCG', yahooSymbol: '^CNXFMCG' },
  { index: 'Nifty Pharma', symbol: 'NIFTY_PHARMA', yahooSymbol: '^CNXPHARMA' },
  { index: 'Nifty Midcap 100', symbol: 'NIFTY_MIDCAP_100', yahooSymbol: '^CNXMID100' },
]

type LiveIndexQuote = {
  symbol: string
  price: string
  previous_close?: string
  change?: string
  change_pct?: string
  provider?: string
  error?: string
}

type PredictionState = IndexPrediction & {
  source: 'static' | 'llm'
}

function formatProfileList(value: AngelOneProfile['exchanges']) {
  if (Array.isArray(value)) return value.join(', ')
  if (!value) return 'Not available'
  try {
    const parsed = JSON.parse(value.replace(/'/g, '"'))
    return Array.isArray(parsed) ? parsed.join(', ') : value
  } catch {
    return value
  }
}

const openAiKey = import.meta.env.VITE_OPENAI_API_KEY
const openAiUrl = import.meta.env.VITE_OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions'
const twelveDataKey = import.meta.env.VITE_TWELVEDATA_API_KEY

function formatChange(amount: string | undefined, percent: string | undefined) {
  if (!amount || !percent) return '–'
  const sign = amount.startsWith('-') ? '' : '+'
  return `${sign}${amount} (${percent})`
}

function parseJsonSafe(text: string) {
  const jsonMatch = text.match(/(?:\{|\[)[\s\S]*(?:\}|\])$/)
  if (!jsonMatch) return null

  try {
    return JSON.parse(jsonMatch[0])
  } catch (error) {
    return null
  }
}

export default function PredictionPage() {
  const [predictions, setPredictions] = useState<PredictionState[]>(
    staticPredictions.map((item) => ({ ...item, source: 'static' }))
  )
  const [liveQuotes, setLiveQuotes] = useState<Record<string, LiveIndexQuote>>({})
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [llmLoading, setLlmLoading] = useState(false)
  const [llmError, setLlmError] = useState('')
  const [angelProfile, setAngelProfile] = useState<AngelOneProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [angelRms, setAngelRms] = useState<AngelOneRms | null>(null)
  const [rmsError, setRmsError] = useState('')
  const [gttRules, setGttRules] = useState<AngelOneGttRule[]>([])
  const [gttForm, setGttForm] = useState({ id: '', tradingsymbol: '', symboltoken: '', exchange: 'NSE', transactiontype: 'BUY', producttype: 'DELIVERY', price: '', qty: '', triggerprice: '', disclosedqty: '0' })
  const [gttMessage, setGttMessage] = useState('')
  const [gttError, setGttError] = useState('')

  const twelveDataEnabled = Boolean(twelveDataKey)
  const llmEnabled = Boolean(openAiKey)

  useEffect(() => {
    fetchLiveQuotes()
    fetchAngelProfile()
  }, [])

  const activePredictions = useMemo(() => predictions, [predictions])

  async function fetchAngelProfile() {
    let token = localStorage.getItem('angelone_jwt_token')
    const refreshToken = localStorage.getItem('angelone_refresh_token')
    if (!token && !refreshToken) return

    setProfileLoading(true)
    setProfileError('')
    try {
      if (!token && refreshToken) {
        const refreshed = await refreshAngelOneToken('', refreshToken)
        token = refreshed.data?.jwtToken || null
        if (refreshed.data?.refreshToken) localStorage.setItem('angelone_refresh_token', refreshed.data.refreshToken)
        if (token) localStorage.setItem('angelone_jwt_token', token)
      }
      if (!token) throw new Error('Angel One session expired. Please log in again.')

      let result
      try {
        result = await getAngelOneProfile(token)
      } catch (error) {
        if (!(error instanceof Error) || !refreshToken) throw error
        const refreshed = await refreshAngelOneToken(token, refreshToken)
        token = refreshed.data?.jwtToken || null
        if (refreshed.data?.refreshToken) localStorage.setItem('angelone_refresh_token', refreshed.data.refreshToken)
        if (token) localStorage.setItem('angelone_jwt_token', token)
        if (!token) throw new Error('Angel One session expired. Please log in again.')
        result = await getAngelOneProfile(token)
      }
      if (!result.data) throw new Error(result.message || 'Profile data was not returned.')
      setAngelProfile(result.data)
      await loadGttRules(token)
      try {
        const rmsResult = await getAngelOneRms(token)
        if (!rmsResult.data) throw new Error(rmsResult.message || 'RMS data was not returned.')
        setAngelRms(rmsResult.data)
      } catch (error) {
        setRmsError(error instanceof Error ? error.message : 'Unable to load Angel One RMS limits.')
      }

    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Unable to load Angel One profile.')
    } finally {
      setProfileLoading(false)
    }
  }

  async function loadGttRules(token = localStorage.getItem('angelone_jwt_token')) {
    if (!token) return
    try {
      const result = await listGttRules(token, ['NEW', 'CANCELLED', 'ACTIVE', 'SENTTOEXCHANGE', 'FORALL'])
      setGttRules(Array.isArray(result.data) ? result.data : [])
    } catch (error) {
      setGttError(error instanceof Error ? error.message : 'Unable to load GTT rules.')
    }
  }

  async function submitGtt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const token = localStorage.getItem('angelone_jwt_token')
    if (!token) {
      setGttError('Please log in to manage GTT rules.')
      return
    }
    setGttError('')
    setGttMessage('')
    try {
      const result = gttForm.id ? await modifyGttRule(token, gttForm) : await createGttRule(token, gttForm)
      setGttMessage(result.message || 'GTT rule saved successfully.')
      setGttForm((current) => ({ ...current, id: '' }))
      await loadGttRules(token)
    } catch (error) {
      setGttError(error instanceof Error ? error.message : 'Unable to save GTT rule.')
    }
  }

  async function inspectGtt(id: string) {
    const token = localStorage.getItem('angelone_jwt_token')
    if (!token) return
    try {
      const result = await getGttRuleDetails(token, id)
      if (result.data && !Array.isArray(result.data) && typeof result.data !== 'string') {
        setGttForm((current) => ({ ...current, ...result.data as AngelOneGttRule }))
      }
    } catch (error) {
      setGttError(error instanceof Error ? error.message : 'Unable to load GTT details.')
    }
  }

  async function cancelGtt(rule: AngelOneGttRule) {
    const token = localStorage.getItem('angelone_jwt_token')
    if (!token || !rule.id) return
    try {
      await cancelGttRule(token, { id: rule.id, symboltoken: rule.symboltoken, exchange: rule.exchange })
      setGttMessage('GTT rule cancelled successfully.')
      await loadGttRules(token)
    } catch (error) {
      setGttError(error instanceof Error ? error.message : 'Unable to cancel GTT rule.')
    }
  }

  async function fetchYahooQuotes() {
    const yahooSymbols = liveIndexSymbols.map((item) => item.yahooSymbol).join(',')
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooSymbols)}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Yahoo quote fetch failed with status ${response.status}`)
    }

    const data = await response.json()
    if (!data?.quoteResponse?.result || !Array.isArray(data.quoteResponse.result)) {
      throw new Error('Yahoo quote response format invalid.')
    }

    const quoteMap: Record<string, LiveIndexQuote> = {}
    data.quoteResponse.result.forEach((quote: any) => {
      const item = liveIndexSymbols.find((entry) => entry.yahooSymbol === quote.symbol)
      if (!item) return

      const priceValue = quote.regularMarketPrice ?? quote.postMarketPrice ?? quote.preMarketPrice
      const changeValue = quote.regularMarketChange ?? quote.postMarketChange ?? quote.preMarketChange
      const changePctValue = quote.regularMarketChangePercent ?? quote.postMarketChangePercent ?? quote.preMarketChangePercent

      quoteMap[item.symbol] = {
        symbol: item.symbol,
        price: priceValue != null ? String(priceValue.toFixed ? priceValue.toFixed(2) : priceValue) : 'N/A',
        change: changeValue != null ? (changeValue.toFixed ? changeValue.toFixed(2) : String(changeValue)) : '',
        change_pct: changePctValue != null ? `${changePctValue.toFixed ? changePctValue.toFixed(2) : String(changePctValue)}%` : '',
        provider: 'Yahoo',
      }
    })

    return quoteMap
  }

  async function fetchTwelveDataQuotes() {
    const quotePromises = liveIndexSymbols.map(async (item) => {
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(item.symbol)}&apikey=${twelveDataKey}`
      const response = await fetch(url)
      const data = await response.json()

      if (data.status === 'error' || data.code) {
        return {
          symbol: item.symbol,
          price: 'N/A',
          error: data.message || 'Failed to fetch quote',
          provider: 'TwelveData',
        } as LiveIndexQuote
      }

      const price = data.close ?? data.price ?? data.current_price ?? 'N/A'
      const previousClose = data.previous_close ?? data.prev_close ?? ''
      const change = price !== 'N/A' && previousClose ? (Number(price) - Number(previousClose)).toFixed(2) : ''
      const changePct = previousClose ? `${((Number(price) - Number(previousClose)) / Number(previousClose) * 100).toFixed(2)}%` : ''

      return {
        symbol: item.symbol,
        price: String(price),
        previous_close: String(previousClose || ''),
        change,
        change_pct: changePct,
        provider: 'TwelveData',
      }
    })

    const quoteResults = await Promise.all(quotePromises)
    const quoteMap: Record<string, LiveIndexQuote> = {}
    quoteResults.forEach((quote) => {
      quoteMap[quote.symbol] = quote
    })
    return quoteMap
  }

  async function fetchLiveQuotes() {
    setQuoteLoading(true)
    setQuoteError('')

    try {
      let quotes = await fetchYahooQuotes()
      if (Object.keys(quotes).length === 0 && twelveDataEnabled) {
        quotes = await fetchTwelveDataQuotes()
      }
      if (Object.keys(quotes).length === 0) {
        throw new Error('No live quotes were returned.')
      }
      setLiveQuotes(quotes)
    } catch (error: any) {
      if (twelveDataEnabled) {
        try {
          const fallbackQuotes = await fetchTwelveDataQuotes()
          setLiveQuotes(fallbackQuotes)
          return
        } catch (fallbackError) {
          setQuoteError('Live quote fetch failed from all sources.')
        }
      } else {
        setQuoteError('Live quote fetch failed from public source. Add VITE_TWELVEDATA_API_KEY for a backup provider.')
      }
    } finally {
      setQuoteLoading(false)
    }
  }

  async function runLlmPrediction() {
    setLlmError('')
    setLlmLoading(true)

    if (!llmEnabled) {
      setLlmError('OpenAI API key is not configured in VITE_OPENAI_API_KEY.')
      setLlmLoading(false)
      return
    }

    try {
      const quoteSummaries = liveIndexSymbols.map((entry) => {
        const quote = liveQuotes[entry.symbol]
        return `- ${entry.index} (${entry.symbol}): price=${quote?.price ?? 'N/A'}, change=${formatChange(quote?.change, quote?.change_pct)}`
      }).join('\n')

      const prompt = `You are a market analyst that provides short trading edge predictions for Indian indices. Use the live price data and give one prediction per index. Return valid JSON only. Do not add any explanatory text outside of JSON.

Indices:
${quoteSummaries}

Respond in JSON format as an array of objects with keys: index, sentiment, entry, target, stoploss, chance, rationale. Ensure the 'index' name matches the following list exactly: ${liveIndexSymbols.map((item) => item.index).join(', ')}.`

      const payload = {
        model: 'gpt-3.5-turbo',
        temperature: 0.8,
        messages: [
          { role: 'system', content: 'You are a helpful trading assistant.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
      }

      const response = await fetch(openAiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAiKey}`,
        },
        body: JSON.stringify(payload),
      })

      const result = await response.json()
      const message = result?.choices?.[0]?.message?.content ?? ''
      const parsed = parseJsonSafe(message)

      if (!parsed || !Array.isArray(parsed)) {
        throw new Error('LLM returned unexpected response format.')
      }

      const updatedPredictions = parsed.map((item: any) => ({
        index: item.index ?? 'Unknown',
        sentiment: item.sentiment === 'Bearish' || item.sentiment === 'Neutral' ? item.sentiment : 'Bullish',
        entry: item.entry ?? 'N/A',
        target: item.target ?? 'N/A',
        stoploss: item.stoploss ?? 'N/A',
        chance: item.chance ?? 'N/A',
        rationale: item.rationale ?? 'No rationale provided.',
        source: 'llm' as const,
      }))

      setPredictions(updatedPredictions)
    } catch (error) {
      setLlmError('LLM prediction failed. Please check your OpenAI key or custom LLM API URL.')
    } finally {
      setLlmLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', paddingBottom: 40 }}>
      <div style={{ background: 'linear-gradient(135deg,#6C63FF,#FF6584)', padding: '32px 0 28px', marginBottom: 24 }}>
        <div className="container">
          <h1 style={{ color: '#fff', fontSize: 28, fontWeight: 700, marginBottom: 6 }}>Traders Prediction</h1>
          <p style={{ color: 'rgba(255,255,255,0.9)', fontSize: 14, maxWidth: 700, lineHeight: 1.7 }}>
            This dashboard pulls live index quotes and can optionally use an LLM to refresh prediction outlooks when API keys are configured.
          </p>
        </div>
      </div>

      <div className="container" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button
            type="button"
            onClick={fetchLiveQuotes}
            disabled={quoteLoading}
            style={{
              borderRadius: 999,
              padding: '10px 18px',
              border: 'none',
              cursor: quoteLoading ? 'not-allowed' : 'pointer',
              background: quoteLoading ? '#A5B4FC' : '#6C63FF',
              color: '#fff',
              fontWeight: 700,
            }}
          >
            {quoteLoading ? 'Refreshing Quotes…' : 'Refresh Live Quotes'}
          </button>
          <button
            type="button"
            onClick={runLlmPrediction}
            disabled={!llmEnabled || llmLoading}
            style={{
              borderRadius: 999,
              padding: '10px 18px',
              border: 'none',
              cursor: llmEnabled ? 'pointer' : 'not-allowed',
              background: llmEnabled ? '#10B981' : '#D1D5DB',
              color: '#fff',
              fontWeight: 700,
            }}
          >
            {llmEnabled ? (llmLoading ? 'Generating Predictions…' : 'Run LLM Predictions') : 'LLM Disabled'}
          </button>
        </div>
        <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
          {!twelveDataEnabled && (
            <div style={{ padding: 16, borderRadius: 18, background: '#FEF3C7', color: '#92400E' }}>
              Live quotes use public market data. Add <strong>VITE_TWELVEDATA_API_KEY</strong> for a backup provider if needed.
            </div>
          )}
          {!llmEnabled && (
            <div style={{ padding: 16, borderRadius: 18, background: '#DBEAFE', color: '#1E40AF' }}>
              Optional LLM prediction support is available when <strong>VITE_OPENAI_API_KEY</strong> or <strong>VITE_OPENAI_API_URL</strong> is configured.
            </div>
          )}
          {quoteError && (
            <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{quoteError}</div>
          )}
          {llmError && (
            <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{llmError}</div>
          )}
          {profileError && (
            <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{profileError}</div>
          )}
          {rmsError && (
            <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{rmsError}</div>
          )}
          {gttError && <div style={{ padding: 16, borderRadius: 18, background: '#FECACA', color: '#991B1B' }}>{gttError}</div>}
          {gttMessage && <div style={{ padding: 16, borderRadius: 18, background: '#D1FAE5', color: '#065F46' }}>{gttMessage}</div>}
        </div>
      </div>

      <div className="container" style={{ paddingBottom: 40 }}>
        {profileLoading && (
          <div className="card" style={{ padding: 20, marginBottom: 18 }}>Loading Angel One profile…</div>
        )}
        {angelProfile && (
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Angel One Profile</div>
                <h2 style={{ margin: '8px 0 4px' }}>{angelProfile.name || 'Investor'}</h2>
                <div style={{ color: 'var(--text-secondary)' }}>Client code: {angelProfile.clientcode || 'Not available'}</div>
              </div>
              <div style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                <div>{angelProfile.email || 'Email not available'}</div>
                <div>{angelProfile.mobileno || 'Mobile not available'}</div>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 6, marginTop: 16, color: 'var(--text-secondary)', fontSize: 14 }}>
              <div><strong>Exchanges:</strong> {formatProfileList(angelProfile.exchanges)}</div>
              <div><strong>Products:</strong> {formatProfileList(angelProfile.products)}</div>
              <div><strong>Last login:</strong> {angelProfile.lastlogintime || 'Not available'}</div>
              <div><strong>Broker:</strong> {angelProfile.brokerid || 'Not available'}</div>
            </div>
          </div>
        )}
        {angelRms && (
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Risk Management & Funds</div>
            <h2 style={{ margin: '8px 0 16px' }}>RMS Limits</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {[
                ['Net', 'net'],
                ['Available cash', 'availablecash'],
                ['Intraday pay-in', 'availableintradaypayin'],
                ['Limit margin', 'availablelimitmargin'],
                ['Collateral', 'collateral'],
                ['Unrealized M2M', 'm2munrealized'],
                ['Realized M2M', 'm2mrealized'],
                ['Utilized debits', 'utiliseddebits'],
                ['Utilized span', 'utilisedspan'],
                ['Option premium', 'utilisedoptionpremium'],
                ['Utilized exposure', 'utilisedexposure'],
                ['Utilized payout', 'utilisedpayout'],
              ].map(([label, key]) => (
                <div key={key} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>{label}</div>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{angelRms[key] ?? '0'}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="card" style={{ padding: 24, marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Good Till Triggered</div>
          <h2 style={{ margin: '8px 0 16px' }}>GTT Rule Management</h2>
          <form onSubmit={submitGtt} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 20 }}>
            {([['tradingsymbol', 'Trading symbol'], ['symboltoken', 'Symbol token'], ['price', 'Price'], ['qty', 'Quantity'], ['triggerprice', 'Trigger price'], ['disclosedqty', 'Disclosed qty']] as const).map(([key, label]) => (
              <label key={key} style={{ fontSize: 12 }}>{label}<input required={key !== 'disclosedqty'} value={gttForm[key]} onChange={(event) => setGttForm({ ...gttForm, [key]: event.target.value })} /></label>
            ))}
            <label style={{ fontSize: 12 }}>Exchange<select value={gttForm.exchange} onChange={(event) => setGttForm({ ...gttForm, exchange: event.target.value })}><option>NSE</option><option>BSE</option></select></label>
            <label style={{ fontSize: 12 }}>Side<select value={gttForm.transactiontype} onChange={(event) => setGttForm({ ...gttForm, transactiontype: event.target.value })}><option>BUY</option><option>SELL</option></select></label>
            <label style={{ fontSize: 12 }}>Product<select value={gttForm.producttype} onChange={(event) => setGttForm({ ...gttForm, producttype: event.target.value })}><option>DELIVERY</option><option>MARGIN</option></select></label>
            {gttForm.id && <label style={{ fontSize: 12 }}>Rule ID<input value={gttForm.id} readOnly /></label>}
            <button type="submit" style={{ border: 0, borderRadius: 10, background: '#6C63FF', color: '#fff', fontWeight: 700 }}>{gttForm.id ? 'Modify Rule' : 'Create Rule'}</button>
          </form>
          <div style={{ display: 'grid', gap: 10 }}>
            {gttRules.map((rule) => (
              <div key={rule.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <span><strong>#{rule.id}</strong> {rule.tradingsymbol || ''} {rule.transactiontype || ''} — {rule.status || 'UNKNOWN'}</span>
                <span style={{ display: 'flex', gap: 8 }}><button type="button" onClick={() => inspectGtt(rule.id || '')}>Details / Edit</button><button type="button" onClick={() => cancelGtt(rule)}>Cancel</button></span>
              </div>
            ))}
            {!gttRules.length && <div style={{ color: 'var(--text-secondary)' }}>No GTT rules found.</div>}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 18 }}>
          {activePredictions.map((item) => {
            const symbol = liveIndexSymbols.find((entry) => entry.index === item.index)?.symbol
            const quote = symbol ? liveQuotes[symbol] : undefined
            const sourceBadge = item.source === 'llm' ? 'LLM' : 'Static'

            return (
              <div key={`${item.index}-${sourceBadge}`} className="card" style={{ padding: '24px 24px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 14, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase' }}>Index</div>
                    <h2 style={{ margin: '8px 0 0', fontSize: 22, color: 'var(--text-primary)' }}>{item.index}</h2>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <span style={{ padding: '8px 14px', borderRadius: 999, fontWeight: 700, fontSize: 13, color: '#2563EB', background: 'rgba(37,99,235,0.12)' }}>
                      {sourceBadge}
                    </span>
                    {quote ? (
                      <div style={{ fontSize: 14, color: 'var(--text-secondary)', textAlign: 'right' }}>
                        <div>Live price: <strong>₹{quote.price}</strong></div>
                        <div>{formatChange(quote.change, quote.change_pct)}</div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>Live price unavailable</div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 18 }}>
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, padding: 16 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Entry</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{item.entry}</div>
                  </div>
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, padding: 16 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Target</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{item.target}</div>
                  </div>
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, padding: 16 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Stoploss</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{item.stoploss}</div>
                  </div>
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, padding: 16 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Chance</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{item.chance}</div>
                  </div>
                </div>

                <div style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.75 }}>{item.rationale}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
