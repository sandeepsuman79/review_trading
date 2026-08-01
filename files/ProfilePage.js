import React from 'react';
import { Link } from 'react-router-dom';
import { profileData } from '../data/posts';

export default function ProfilePage() {
  const p = profileData;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Cover */}
      <div style={{
        height: 220,
        background: p.coverColor,
        position: 'relative'
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 20px)'
        }} />
      </div>

      <div className="container">
        {/* Profile Header Card */}
        <div className="card" style={{ marginTop: -60, padding: '0 0 24px', marginBottom: 24 }}>
          <div style={{ padding: '0 28px', paddingTop: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, marginBottom: 16, marginTop: -44 }}>
              {/* Avatar */}
              <div style={{
                width: 100, height: 100, borderRadius: '50%',
                background: 'linear-gradient(135deg, #6C63FF, #FF6584)',
                border: '4px solid #fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 38, fontWeight: 700, color: '#fff',
                boxShadow: '0 4px 16px rgba(108,99,255,0.3)',
                flexShrink: 0
              }}>
                {p.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
              </div>
              <div style={{ paddingBottom: 8, flex: 1 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>{p.name}</h1>
                <p style={{ fontSize: 14, color: 'var(--primary)', fontWeight: 500 }}>{p.title}</p>
              </div>
              <Link to="/feed" className="btn btn-primary" style={{ marginBottom: 8 }}>
                View Feed →
              </Link>
            </div>

            <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 16, maxWidth: 600 }}>
              {p.bio}
            </p>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 16, color: 'var(--text-muted)', fontSize: 13 }}>
              <span>📍</span>
              <span>{p.location}</span>
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', gap: 28, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              {[
                { label: 'Posts', value: p.posts },
                { label: 'Followers', value: p.followers.toLocaleString() },
                { label: 'Following', value: p.following }
              ].map(s => (
                <div key={s.label} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--primary)' }}>{s.value}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Content Type Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 32 }}>
          {[
            { icon: '🖼️', type: 'Banners', desc: 'Daily inspiration banners & posters', color: '#D1FAE5', text: '#059669', freq: 'Daily' },
            { icon: '🎬', type: 'Trailers', desc: 'Weekly movie & show trailer reviews', color: '#FFE4E6', text: '#E11D48', freq: 'Weekly' },
            { icon: '📚', type: 'Book Reviews', desc: 'Weekly curated book summaries', color: '#E0F2FE', text: '#0284C7', freq: 'Weekly' },
            { icon: '👑', type: 'Leader Spotlights', desc: 'Monthly feature on inspiring leaders', color: '#FEF9C3', text: '#CA8A04', freq: 'Monthly' }
          ].map(item => (
            <div key={item.type} className="card" style={{ padding: 20 }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>{item.icon}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <h3 style={{ fontWeight: 600, fontSize: 15 }}>{item.type}</h3>
                <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 600, background: item.color, color: item.text }}>
                  {item.freq}
                </span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{item.desc}</p>
            </div>
          ))}
        </div>

        {/* Skills */}
        <div className="card" style={{ padding: 24, marginBottom: 32 }}>
          <h2 style={{ fontWeight: 600, fontSize: 16, marginBottom: 14 }}>Skills & Interests</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {p.skills.map(skill => (
              <span key={skill} style={{
                padding: '6px 14px', borderRadius: 999, background: 'var(--primary-light)',
                color: 'var(--primary)', fontSize: 13, fontWeight: 500,
                border: '1px solid #C7C3FF'
              }}>
                {skill}
              </span>
            ))}
          </div>
        </div>

        {/* Social Links */}
        <div className="card" style={{ padding: 24, marginBottom: 32 }}>
          <h2 style={{ fontWeight: 600, fontSize: 16, marginBottom: 14 }}>Connect With Me</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {Object.entries(p.socials).map(([platform, handle]) => (
              <div key={platform} style={{
                padding: '8px 16px', borderRadius: 10, background: 'var(--bg)',
                border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-secondary)'
              }}>
                <span style={{ fontWeight: 500, textTransform: 'capitalize', color: 'var(--primary)' }}>{platform}</span>
                {' '}{handle}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
