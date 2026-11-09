/** Validate finite, positive reward/risk geometry without a minimum ratio.
 * The reference target must remain ahead of entry and the stop behind it. */
export function hasValidRewardRisk(ratio: number) {
  return Number.isFinite(ratio) && ratio > 0
}
