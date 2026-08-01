import type { ReviewItem } from './types'

export const weeklyReviews: ReviewItem[] = [
  {
    id: 'weekly-01',
    category: 'Weekly',
    format: 'Book Review',
    title: 'Weekly Book Review',
    description: 'In-depth review of the week’s most discussed memoir.',
    likes: 52,
    dislikes: 7,
    votes: { yes: 61, no: 12 },
    opinions: ['Very insightful.', 'Would like a shorter summary version too.'],
  },
  {
    id: 'weekly-02',
    category: 'Weekly',
    format: 'About Leader',
    title: 'Leader Profile Spotlight',
    description: 'Guest opinions and leader highlights from this week’s top interviews.',
    likes: 43,
    dislikes: 5,
    votes: { yes: 49, no: 9 },
    opinions: ['Strong leadership story.', 'More background would help.'],
  },
]
