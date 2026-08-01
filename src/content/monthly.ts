import type { ReviewItem } from './types'

export const monthlyReviews: ReviewItem[] = [
  {
    id: 'monthly-01',
    category: 'Monthly',
    format: 'Banner',
    title: 'Monthly Highlights Banner',
    description: 'A larger monthly feature banner with community sentiment and vote summaries.',
    likes: 80,
    dislikes: 10,
    votes: { yes: 90, no: 20 },
    opinions: ['Excellent wrap-up.', 'Could add more poster variations.'],
  },
  {
    id: 'monthly-02',
    category: 'Monthly',
    format: 'Book Review',
    title: 'Monthly Feature Book Review',
    description: 'Comprehensive monthly review for a best-selling title with guest reactions.',
    likes: 68,
    dislikes: 9,
    votes: { yes: 82, no: 14 },
    opinions: ['Very helpful analysis.', 'More sample quotes would be nice.'],
  },
]
