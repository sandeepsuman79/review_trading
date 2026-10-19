import type { AngelOneCandle } from '../api/angelOne'
import type { MultiTimeframeAssessment, AgentTimeframe } from '../analysis/multiTimeframe'
import { useScoreTrajectory } from './useScoreTrajectory'
export type TimeframeTrajectories = Record<AgentTimeframe, ReturnType<typeof useScoreTrajectory>>
/** Keep all three trackers mounted, regardless of selected index or collapsed UI. */
export function useTimeframeTrajectories(assessment: MultiTimeframeAssessment, contract = '', candles: Partial<Record<AgentTimeframe, AngelOneCandle[]>> = {}): TimeframeTrajectories {
  const five = assessment.reviews.find(review => review.interval === 'FIVE_MINUTE')!
  const fifteen = assessment.reviews.find(review => review.interval === 'FIFTEEN_MINUTE')!
  const hourly = assessment.reviews.find(review => review.interval === 'ONE_HOUR')!
  const FIVE_MINUTE = useScoreTrajectory(five.evidence, contract, five.analysis, five.current, candles.FIVE_MINUTE)
  const FIFTEEN_MINUTE = useScoreTrajectory(fifteen.evidence, contract, fifteen.analysis, fifteen.current, candles.FIFTEEN_MINUTE)
  const ONE_HOUR = useScoreTrajectory(hourly.evidence, contract, hourly.analysis, hourly.current, candles.ONE_HOUR)
  return { FIVE_MINUTE, FIFTEEN_MINUTE, ONE_HOUR }
}
