/** Saved policies keep their own evidence and protection on reload. */
export const isCandleStrategy = (version: string) => version === 'candle-v1' || version === 'candle-v2'
export const usesCurrentEntryWindow = (version: string) => version === 'technical-v2' || isCandleStrategy(version)
