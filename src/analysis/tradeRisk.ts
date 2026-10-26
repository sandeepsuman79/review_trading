/** Shared by setup selection, confirmation, observed entry and offline replay. */
export const minimumRewardRisk = 1.2
export function meetsMinimumRewardRisk(ratio: number) {
  // Price/tick arithmetic can place an exact boundary a few ulps below the floor.
  return Number.isFinite(ratio) && ratio + 1e-9 >= minimumRewardRisk
}
