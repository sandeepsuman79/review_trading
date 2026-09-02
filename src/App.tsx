import { useState } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import './index.css'
import Navbar from './components/Navbar'
import ProfilePage from './pages/ProfilePage'
import FeedPage from './pages/FeedPage'
import PostDetail from './pages/PostDetail'
import PredictionPage from './pages/PredictionPage'
import AngelOneLoginPage from './pages/AngelOneLoginPage'
import { postsData } from './data/posts'
import type { PostItem, CommentItem } from './data/posts'

export default function App() {
  const [posts, setPosts] = useState<PostItem[]>(postsData)

  const handleVote = (postId: number, option: string) => {
    
    setPosts((prev) => prev.map((p) => {
      if (p.id !== postId) return p
      const poll = { ...p.poll }
      const votes = { ...poll.votes, [option]: (poll.votes[option] || 0) + 1 }
      return { ...p, poll: { ...poll, votes } }
    }))
  }

  const handleReaction = (postId: number, type: string) => {
    setPosts((prev) => prev.map((p) => {
      if (p.id !== postId) return p
      const reactions = { ...p.reactions, [type]: (p.reactions[type] || 0) + 1 }
      return { ...p, reactions }
    }))
  }

  const handleComment = (postId: number, comment: CommentItem) => {
    setPosts((prev) => prev.map((p) => {
      if (p.id !== postId) return p
      return { ...p, comments: [...p.comments, comment] }
    }))
  }

  return (
    <Router>
      <Navbar />
      <Routes>
        <Route path="/" element={<ProfilePage />} />
        <Route
          path="/feed"
          element={<FeedPage posts={posts} onVote={handleVote} onReaction={handleReaction} onComment={handleComment} />}
        />
        <Route
          path="/post/:id"
          element={<PostDetail posts={posts} onVote={handleVote} onReaction={handleReaction} onComment={handleComment} />}
        />
        <Route path="/prediction" element={<PredictionPage />} />
        <Route path="/angelone/login" element={<AngelOneLoginPage />} />
      </Routes>
    </Router>
  )
}
