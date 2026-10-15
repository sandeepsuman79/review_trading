const roots = new Set(['NATURALGAS', 'CRUDEOIL', 'SILVER', 'GOLD'])

/** Standard MCX futures only. Clients select the nearest live expiry, never an option or mini contract. */
export function commodityInstruments(master) {
  return master.filter(item => item?.exch_seg === 'MCX' && item.instrumenttype === 'FUTCOM'
    && roots.has(item.name) && /^\d+$/.test(String(item.token)) && typeof item.symbol === 'string' && item.symbol.endsWith('FUT'))
    .map(({ token, symbol, name, exch_seg, expiry, lotsize, tick_size, instrumenttype }) => ({ token: String(token), symbol, name, exch_seg, expiry, lotsize, tick_size, instrumenttype }))
}
