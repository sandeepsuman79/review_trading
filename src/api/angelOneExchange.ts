export function angelOneExchange(segment?: string) {
  const exchanges: Record<string, string> = { nse_cm: 'NSE', bse_cm: 'BSE', nse_fo: 'NFO', bse_fo: 'BFO', mcx_fo: 'MCX', NSE: 'NSE', BSE: 'BSE', NFO: 'NFO', BFO: 'BFO', MCX: 'MCX', CDS: 'CDS' }
  const exchange = exchanges[segment || '']
  if (!exchange) throw new Error('Unsupported Angel One exchange segment.')
  return exchange
}
