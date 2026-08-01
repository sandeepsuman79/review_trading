import type { ReviewItem } from './types'

export const dailyReviews: ReviewItem[] = [
  {
    id: 'daily-01',
    category: 'Daily',
    format: 'Banner',
    title: 'Daily Book Launch Banner',
    description: 'A fresh banner for today’s new release with guest-first impressions and live opinion sharing.',
    likes: 18,
    dislikes: 2,
    votes: { yes: 26, no: 6 },
    opinions: ['Loved the color theme.', 'Needs a clearer call to action.'],
  },
  {
    id: 'daily-02',
    category: 'Daily',
    format: 'Trailer',
    title: 'Trailer Spotlight',
    description: 'Short trailer review with user reactions and quick review points.',
    likes: 34,
    dislikes: 4,
    votes: { yes: 40, no: 8 },
    opinions: ['Great pace!', 'Could use better sound design.'],
  },
]
