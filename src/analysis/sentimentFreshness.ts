/** Experimental reference weights, not fitted probabilities or technical-entry thresholds. */
export const sentimentAgeRules = {
  news: { halfLifeMs: 12 * 3_600_000, maxAgeMs: 48 * 3_600_000 },
  global: { halfLifeMs: 24 * 3_600_000, maxAgeMs: 4 * 86_400_000 },
  flows: { halfLifeMs: 3 * 86_400_000, maxAgeMs: 7 * 86_400_000 },
  pcr: { halfLifeMs: 15 * 60_000, maxAgeMs: 30 * 60_000 },
} as const

export type SentimentFreshness = { asOf: string; ageMs: number; halfLifeMs: number; factor: number }

/** Use publication/observation time. A successful fetch must never reset evidence age. */
export function sentimentFreshness(kind: keyof typeof sentimentAgeRules, asOf: string | undefined, now: number, maxAgeMs: number = sentimentAgeRules[kind].maxAgeMs): SentimentFreshness | undefined {
  const timestamp = asOf ? Date.parse(asOf) : NaN, age = now - timestamp
  // Match source gates' one-minute clock tolerance, without giving future data extra weight.
  if (!Number.isFinite(now) || !Number.isFinite(age) || age < -60_000 || age > maxAgeMs) return undefined
  const halfLifeMs = sentimentAgeRules[kind].halfLifeMs, ageMs = Math.max(0, age)
  return { asOf: asOf!, ageMs, halfLifeMs, factor: Math.min(1, Math.max(0, 2 ** (-ageMs / halfLifeMs))) }
}

export function sentimentAgeLabel(freshness: SentimentFreshness | undefined) {
  if (!freshness) return 'publication / observation age unavailable or expired; no sentiment vote'
  const hours = freshness.halfLifeMs / 3_600_000
  const halfLife = hours < 1 ? `${hours * 60}m` : hours < 24 ? `${hours}h` : `${hours / 24}d`
  return `observed ${freshness.asOf} · age weight ${(100 * freshness.factor).toFixed(1)}% (${halfLife} half-life)`
}
