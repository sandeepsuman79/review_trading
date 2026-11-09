import type { CandleAssessment } from './candleAgent'
import type { CandidateDecision, TradeReasonCode } from './tradeDecision'

/** Legacy score fields stay zero for export compatibility; CANDLE_ONLY makes
 * explicit that no percentage score or indicator coverage gate is evaluated. */
export function candleAgentDecisions(assessment: CandleAssessment): CandidateDecision[] {
  return (['CALL', 'PUT'] as const).map(side => {
    const signal = assessment.signal?.side === side ? assessment.signal : undefined
    const plan = assessment.plan?.side === side ? assessment.plan : undefined
    const checks = assessment.checks.map(c => ({ code: c.code as TradeReasonCode, label: c.label,
      status: c.code === 'CANDLE_RISK' && !signal ? 'NOT_CHECKED' as const : c.code === 'CANDLE_PATTERN' && !signal ? 'FAIL' as const : c.passed ? 'PASS' as const : 'FAIL' as const,
      detail: c.code === 'CANDLE_PATTERN' && !signal ? `No accepted ${side} candlestick pattern.` : c.detail }))
    return { basis: 'CANDLE_ONLY', policy: assessment.policy, side, state: plan ? 'CONFIRMED' : signal ? 'REJECTED' : 'WAIT', supportScore: 0, opposingScore: 0, lead: 0, coverage: 0,
      requiredScore: 0, requiredGap: 0, setup: signal?.pattern ?? assessment.state, pattern: signal?.pattern ?? 'NO_CONFIRMED_PATTERN', routes: signal ? [signal.pattern] : [],
      entry: plan?.entry, stopLoss: plan?.stopLoss, target: plan?.target, riskReward: plan?.riskReward, checks,
      reasons: checks.filter(c => c.status === 'FAIL').map(c => c.code) }
  })
}
