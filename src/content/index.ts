import { dailyReviews } from './daily'
import { weeklyReviews } from './weekly'
import { monthlyReviews } from './monthly'

export const reviewItems = [...dailyReviews, ...weeklyReviews, ...monthlyReviews]
