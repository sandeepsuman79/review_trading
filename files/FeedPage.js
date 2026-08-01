import React, { useState } from 'react';
import PostCard from '../components/PostCard';

const TYPES = ['All', 'banner', 'trailer', 'book', 'leader'];
const FREQS = ['All', 'daily', 'weekly', 'monthly'];

export default function FeedPage({ posts, onVote, onReaction, onComment }) {
  const [typeFilter, setTypeFilter] = useState('All');
  const [freqFilter, setFreqFilter] = useState('All');
  const [search, setSearch] = useState('');

  const filtered = posts.filter(p => {
    const matchType = typeFilter === 'All' || p.type === typeFilter;
    const matchFreq = freqFilter === 'All' || p.frequency === freqFilter;
    const matchSearch = !search || p.title.toLowerCase().includes(search.toLowerCase()) || p.description.toLowerCase().includes(search.toLowerCase());
    return matchType && matchFreq && matchSearch;
  });

  const FilterBtn = ({ label, active, onClick }) => (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px', borderRadius: 999, fontSize: 12, fontWeight: 500,
        border: `1px solid ${active ? '#6C63FF' : 'var(--border)'}`,
        background: active ? '#EEF0FF' : 'var(--surface)',
        color: active ? '#6C63FF' : 'var(--text-secondary)',
        cursor: 'pointer', transition: 'all 0.15s',
        textTransform: 'capitalize'
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', paddingBottom: 40 }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg,#6C63FF,#FF6584)', padding: '32px 0 28px', marginBottom: 0 }}>
        <div className="container">
          <h1 style={{ color: '#fff', fontSize: 24, fontWeight: 700, marginBottom: 6 }}>Community Feed</h1>
          <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14 }}>
            Daily banners, weekly trailers & book reviews, monthly leader spotlights — react, vote & comment!
          </p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', borderBottom: '1px solid var(--border)', padding: '14px 0', marginBottom: 24 }}>
        <div className="container">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              placeholder="🔍  Search posts..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 200, padding: '6px 12px', fontSize: 13 }}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TYPES.map(t => (
                <FilterBtn key={t} label={t === 'All' ? 'All Types' : t} active={typeFilter === t} onClick={() => setTypeFilter(t)} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {FREQS.map(f => (
                <FilterBtn key={f} label={f === 'All' ? 'All Schedules' : f} active={freqFilter === f} onClick={() => setFreqFilter(f)} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="container">
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
            <p style={{ fontSize: 16 }}>No posts match your filters.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 20 }}>
            {filtered.map(post => (
              <PostCard
                key={post.id}
                post={post}
                onVote={onVote}
                onReaction={onReaction}
                onComment={onComment}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
