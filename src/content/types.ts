export type ReviewCategory = 'Daily' | 'Weekly' | 'Monthly'
export type ReviewFormat = 'Banner' | 'Trailer' | 'Book Review' | 'About Leader'

export interface ReviewItem {
  id: string
  category: ReviewCategory
  format: ReviewFormat
  title: string
  description: string
  likes: number
  dislikes: number
  votes: {
    yes: number
    no: number
  }
  opinions: string[]
}
