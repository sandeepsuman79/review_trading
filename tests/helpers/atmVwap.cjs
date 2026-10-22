// Explicit option-volume fixtures keep index tests independent of zero-volume spot candles.
module.exports = function atmVwapFixture(index, price, now, direction = 1) {
  const step = index === 'Nifty 50' ? 50 : 100
  const leg = (side, close) => ({ symbol: `FIXTURE-${side}`, token: side === 'CE' ? '1' : '2', exchange: index === 'Sensex' ? 'BFO' : 'NFO',
    close, vwap: 100, volume: 1000, asOf: new Date(now).toISOString(), coverage: 'FULL_SESSION' })
  return { index, strike: Math.round(price / step) * step, expiry: new Date(now + 7 * 86400000).toISOString().slice(0,10), fetchedAt: new Date(now).toISOString(),
    method: 'SESSION_HLC3_VOLUME', referenceIndexPrice: price, ce: leg('CE', 100 + direction * 10), pe: leg('PE', 100 - direction * 10) }
}
