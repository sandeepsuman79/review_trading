import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import './index.css';
import Navbar from './components/Navbar';
import ProfilePage from './pages/ProfilePage';
import FeedPage from './pages/FeedPage';
import PostDetail from './pages/PostDetail';
import { postsData } from './data/posts';

export default function App() {
  const [posts, setPosts] = useState(postsData);

  const handleVote = (postId, option) => {
    setPosts(prev => prev.map(p => {
      if (p.id !== postId) return p;
      const poll = { ...p.poll };
      poll.votes = { ...poll.votes, [option]: (poll.votes[option] || 0) + 1 };
      return { ...p, poll };
    }));
  };

  const handleReaction = (postId, type) => {
    setPosts(prev => prev.map(p => {
      if (p.id !== postId) return p;
      const reactions = { ...p.reactions, [type]: (p.reactions[type] || 0) + 1 };
      return { ...p, reactions };
    }));
  };

  const handleComment = (postId, comment) => {
    setPosts(prev => prev.map(p => {
      if (p.id !== postId) return p;
      return { ...p, comments: [...(p.comments || []), comment] };
    }));
  };

  return (
    <Router>
      <Navbar />
      <Routes>
        <Route path="/" element={<ProfilePage />} />
        <Route path="/feed" element={
          <FeedPage
            posts={posts}
            onVote={handleVote}
            onReaction={handleReaction}
            onComment={handleComment}
          />
        } />
        <Route path="/post/:id" element={
          <PostDetail
            posts={posts}
            onVote={handleVote}
            onReaction={handleReaction}
            onComment={handleComment}
          />
        } />
      </Routes>
    </Router>
  );
}
