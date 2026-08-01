export interface CommentItem {
  id: number
  author: string
  avatar: string
  text: string
  time: string
}

export interface PollItem {
  question: string
  options: string[]
  votes: Record<string, number>
}

export interface PostItem {
  id: number
  type: 'banner' | 'trailer' | 'book' | 'leader'
  frequency: 'daily' | 'weekly' | 'monthly'
  title: string
  description: string
  image?: string
  videoUrl?: string
  date: string
  reactions: Record<string, number>
  comments: CommentItem[]
  poll: PollItem
  rating?: number
}

export interface ProfileData {
  name: string
  title: string
  bio: string
  location: string
  followers: number
  following: number
  posts: number
  avatar: string | null
  coverColor: string
  socials: Record<string, string>
  skills: string[]
}

export const profileData: ProfileData = {
  name: 'Your Name',
  title: 'Visionary Leader & Content Creator',
  bio: 'Passionate about inspiring others through knowledge, culture, and leadership. Sharing daily insights on books, leadership, and the stories that shape our world.',
  location: 'Agra, Uttar Pradesh, India',
  followers: 12400,
  following: 340,
  posts: 128,
  avatar: null,
  coverColor: 'linear-gradient(135deg, #6C63FF 0%, #FF6584 100%)',
  socials: {
    twitter: '@yourhandle',
    instagram: '@yourhandle',
    linkedin: 'linkedin.com/in/yourname'
  },
  skills: ['Leadership', 'Public Speaking', 'Book Reviews', 'Content Creation', 'Community Building']
}

export const postsData: PostItem[] = [
  {
    id: 1,
    type: 'banner',
    frequency: 'daily',
    title: 'Daily Inspiration – Rise Above Limits',
    description: "Every morning is a new opportunity to become a better version of yourself. Don't wait for the perfect moment — create it.",
    image: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=800&q=80',
    date: '2024-06-10',
    reactions: { like: 148, love: 52, insightful: 34 },
    comments: [
      { id: 1, author: 'Rahul Sharma', avatar: 'RS', text: 'Very motivating! This is exactly what I needed today.', time: '2h ago' },
      { id: 2, author: 'Priya Gupta', avatar: 'PG', text: 'Beautiful message. Sharing this with my team!', time: '1h ago' }
    ],
    poll: {
      question: 'Does this message inspire you?',
      options: ['Yes, absolutely!', 'Somewhat', 'Not really'],
      votes: { 'Yes, absolutely!': 98, Somewhat: 32, 'Not really': 8 }
    }
  },
  {
    id: 2,
    type: 'trailer',
    frequency: 'weekly',
    title: 'Weekly Trailer – The Legend Continues',
    description: 'This week\'s featured trailer: An epic journey of courage, sacrifice, and triumph. Watch the exclusive first look before it hits theaters.',
    image: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&q=80',
    videoUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    date: '2024-06-09',
    reactions: { like: 321, love: 145, insightful: 67 },
    comments: [
      { id: 1, author: 'Amit Verma', avatar: 'AV', text: 'Can\'t wait to watch this! Looks incredible.', time: '5h ago' },
      { id: 2, author: 'Sneha Patel', avatar: 'SP', text: 'The cinematography looks stunning!', time: '3h ago' }
    ],
    poll: {
      question: 'Are you excited about this film?',
      options: ['Super excited!', 'Might watch it', 'Not my type'],
      votes: { 'Super excited!': 215, 'Might watch it': 88, 'Not my type': 18 }
    }
  },
  {
    id: 3,
    type: 'book',
    frequency: 'weekly',
    title: 'Book Review – Atomic Habits by James Clear',
    description: 'Rating: ⭐⭐⭐⭐⭐ | This book completely changed how I think about personal growth. James Clear breaks down the science of habits into simple, actionable strategies. A must-read for anyone wanting to build a better life.',
    image: 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=800&q=80',
    date: '2024-06-08',
    rating: 5,
    reactions: { like: 402, love: 198, insightful: 156 },
    comments: [
      { id: 1, author: 'Vikram Nair', avatar: 'VN', text: 'I read this last year — completely changed my daily routine!', time: '8h ago' },
      { id: 2, author: 'Meena Joshi', avatar: 'MJ', text: 'Adding this to my reading list right now.', time: '6h ago' },
      { id: 3, author: 'Rohan Kapoor', avatar: 'RK', text: 'The 1% rule mentioned in this book is life-changing.', time: '4h ago' }
    ],
    poll: {
      question: 'Have you read this book?',
      options: ['Yes, loved it!', 'Currently reading', 'On my list', "Haven't heard of it"],
      votes: { 'Yes, loved it!': 187, 'Currently reading': 64, 'On my list': 115, "Haven't heard of it": 36 }
    }
  },
  {
    id: 4,
    type: 'leader',
    frequency: 'monthly',
    title: 'Leader of the Month – Dr. A.P.J. Abdul Kalam',
    description: 'This month we honour the Missile Man of India — a visionary scientist, beloved president, and eternal teacher. His words continue to inspire millions: Dream, dream, dream. Dreams transform into thoughts and thoughts result in action.',
    image: 'https://images.unsplash.com/photo-1569144157591-c60f3f82f137?w=800&q=80',
    date: '2024-06-01',
    reactions: { like: 589, love: 342, insightful: 201 },
    comments: [
      { id: 1, author: 'Ananya Singh', avatar: 'AS', text: 'A true legend. His life story is the greatest motivation.', time: '2d ago' },
      { id: 2, author: 'Suresh Tiwari', avatar: 'ST', text: 'We miss him deeply. His vision for India was unparalleled.', time: '1d ago' }
    ],
    poll: {
      question: 'What inspires you most about this leader?',
      options: ['Vision & Innovation', 'Humility & Simplicity', 'Dedication to Youth', 'Scientific Achievements'],
      votes: { 'Vision & Innovation': 210, 'Humility & Simplicity': 178, 'Dedication to Youth': 134, 'Scientific Achievements': 67 }
    }
  },
  {
    id: 5,
    type: 'banner',
    frequency: 'daily',
    title: 'Daily Quote – The Power of Consistency',
    description: 'Success is not built in a day. It is built daily — one focused effort at a time. Stay consistent, stay committed.',
    image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80',
    date: '2024-06-07',
    reactions: { like: 265, love: 87, insightful: 43 },
    comments: [],
    poll: {
      question: 'Do you practice daily consistency?',
      options: ['Yes, every day!', 'Working on it', 'Struggling with it'],
      votes: { 'Yes, every day!': 142, 'Working on it': 198, 'Struggling with it': 76 }
    }
  }
]
