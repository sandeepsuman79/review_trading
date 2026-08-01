import React from 'react';
import { useParams, Link } from 'react-router-dom';
import PostCard from '../components/PostCard';

export default function PostDetail({ posts, onVote, onReaction, onComment }) {
  const { id } = useParams();
  const post = posts.find(p => p.id === parseInt(id));

  if (!post) return (
    <div style={{ textAlign: 'center', padding: '80px 20px' }}>
      <div style={{ fontSize: 48 }}>😕</div>
      <p style={{ fontSize: 18, color: 'var(--text-secondary)', marginTop: 12 }}>Post not found.</p>
      <Link to="/feed" className="btn btn-primary" style={{ marginTop: 20, display: 'inline-flex' }}>Back to Feed</Link>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '32px 0 60px' }}>
      <div className="container" style={{ maxWidth: 720 }}>
        <Link to="/feed" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, padding: '6px 14px', borderRadius: 999, border: '1px solid var(--border)', background: '#fff' }}>
          ← Back to Feed
        </Link>
        <PostCard
          post={post}
          onVote={onVote}
          onReaction={onReaction}
          onComment={onComment}
          showFull={true}
        />
      </div>
    </div>
  );
}
