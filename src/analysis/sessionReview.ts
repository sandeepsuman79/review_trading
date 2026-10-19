import type { AngelOneCandle } from '../api/angelOne'
import type { PredictionRecord } from './predictionHistory'
import { analyzeHistoricalOutcomes } from './historicalOutcomes'
import { isCommodity, mcxSession } from './commodities'
export const reviewDate = (now: number) => new Date(now + 330 * 60000).toISOString().slice(0, 10)
export function sessionReviewDue(instrument: string, now: number) {
  const weekday = new Date(now + 330 * 60000).getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const cutoff = isCommodity(instrument) ? mcxSession(now).close : Date.parse(`${reviewDate(now)}T15:15:00+05:30`)
  return now >= cutoff
}
const settled = (r: PredictionRecord) => r.stage === 'CONFIRMED' && ['TARGET_HIT', 'STOP_LOSS_HIT', 'EARLY_EXIT'].includes(r.status) && Number.isFinite(r.points) && Number.isFinite(r.entryAt) && Number.isFinite(r.exitAt) && r.exitAt! >= r.entryAt!
/** Small supervised classifier; chronological holdout remains unseen during fitting. */
export function learnTradeOutcomes(records: PredictionRecord[]) {
  const rows = records.filter(r => settled(r) && Number.isFinite(r.bullishScore) && Number.isFinite(r.bearishScore) && Number.isFinite(r.evidenceSummary?.coverage)).sort((a, b) => a.entryAt! - b.entryAt!)
  if (rows.length < 40) return { status: 'INSUFFICIENT_HISTORY', samples: rows.length, message: 'Need 40 verified trades with saved score/coverage snapshots: at least 30 training observations and 10 later holdout observations.' }
  const split = Math.floor(rows.length * .75), training = rows.slice(0, split)
  const boundary = rows[split].entryAt!
  const train = training.filter(r => r.exitAt! < boundary), holdout = rows.slice(split)
  if (train.length < 30) return { status: 'INSUFFICIENT_HISTORY', samples: rows.length, message: 'Not enough closed training outcomes before the holdout begins.' }
  const features = (r: PredictionRecord) => [1, (r.side === 'CALL' ? r.bullishScore : r.bearishScore) / 100, (r.side === 'CALL' ? r.bearishScore : r.bullishScore) / 100, (r.evidenceSummary?.coverage ?? 0) / 100]
  const weights = [0, 0, 0, 0], sigmoid = (v: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, v))))
  for (let epoch = 0; epoch < 250; epoch++) {
    const gradient = [0, 0, 0, 0]
    for (const r of train) {
      const x = features(r), error = sigmoid(x.reduce((sum, v, i) => sum + v * weights[i], 0)) - (r.points! > 0 ? 1 : 0)
      x.forEach((v, i) => { gradient[i] += error * v })
    }
    weights.forEach((w, i) => { weights[i] -= .2 * (gradient[i] / train.length + (i ? .01 * w : 0)) })
  }
  const correct = holdout.filter(r => (sigmoid(features(r).reduce((sum, v, i) => sum + v * weights[i], 0)) >= .5) === (r.points! > 0)).length
  const majorityWin = train.filter(r => r.points! > 0).length >= train.length / 2
  const baseline = holdout.filter(r => (r.points! > 0) === majorityWin).length / holdout.length
  return { status: 'TRAINED', samples: rows.length, training: train.length, holdout: holdout.length, accuracy: correct / holdout.length, majorityBaseline: baseline, weights, message: 'Logistic regression on recorded support, opposition and coverage. Chronological holdout; descriptive validation only. Compare against majority baseline before proposing changes.' }
}
export function buildSessionReview(instrument: string, records: PredictionRecord[], candles: AngelOneCandle[], now: number) {
  const date = reviewDate(now), matching = records.filter(r => r.instrument === instrument && r.strategyVersion === 'technical-v2' && r.generatedAt <= now)
  const today = matching.filter(r => reviewDate(r.generatedAt) === date && r.stage === 'CONFIRMED')
  const outcomes = today.filter(r => settled(r) && r.exitAt! <= now), wins = outcomes.filter(r => r.points! > 0).length
  const unresolved = today.filter(r => ['AMBIGUOUS', 'UNVERIFIED', 'ACTIVE', 'PENDING'].includes(r.status)).length
  const model = learnTradeOutcomes(matching.filter(r => r.exitAt !== undefined && r.exitAt <= now))
  const chartHistory = analyzeHistoricalOutcomes(candles, 'FIVE_MINUTE', now, instrument)
  const suggestions = [
    ...(unresolved ? ['Improve reconnect history and quote coverage before evaluating strategy accuracy.'] : []),
    ...(outcomes.length < 30 ? ['Collect more verified outcomes across multiple sessions before retuning thresholds.'] : []),
    ...(model.status === 'TRAINED' && model.accuracy! <= model.majorityBaseline! ? ['The learned score model does not beat its holdout baseline. Investigate features and regime changes; do not deploy it as an entry rule.'] : []),
    'Compare the 1.5× rule against prior rules on chronological held-out data, including costs and unresolved trades.',
    'Review reversal pressure against subsequent completed candles; measure false reversals before changing weights.',
  ]
  return { version: 1, instrument, date, generatedAt: now, scope: 'Saved browser history only', confirmed: today.length, entered: today.filter(r => r.entryAt !== undefined).length, settled: outcomes.length, wins, losses: outcomes.filter(r => r.points! < 0).length, flat: outcomes.filter(r => r.points === 0).length, unresolved, expired: today.filter(r => r.status === 'EXPIRED').length, winRate: outcomes.length ? wins / outcomes.length : null, points: outcomes.reduce((sum, r) => sum + r.points!, 0), historyTrades: matching.length, chartCandles: candles.length, model, chartHistory, suggestions }
}
export type SessionReport = ReturnType<typeof buildSessionReview>
