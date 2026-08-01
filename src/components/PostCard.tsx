import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { CommentItem, PollItem, PostItem } from '../data/posts'

const TYPE_CONFIG = {
  banner: { label: 'Banner', bg: '#D1FAE5', text: '#059669', icon: '🖼️' },
  trailer: { label: 'Trailer', bg: '#FFE4E6', text: '#E11D48', icon: '🎬' },
  book: { label: 'Book Review', bg: '#E0F2FE', text: '#0284C7', icon: '📚' },
  leader: { label: 'Leader', bg: '#FEF9C3', text: '#CA8A04', icon: '👑' }
} as const
const FREQ_CONFIG = {
  daily: { label: 'Daily', bg: '#FEF3C7', text: '#D97706' },
  weekly: { label: 'Weekly', bg: '#DBEAFE', text: '#2563EB' },
  monthly: { label: 'Monthly', bg: '#F3E8FF', text: '#9333EA' }
} as const

type VoteOption = string

type PollWidgetProps = {
  poll: PollItem
  onVote: (option: VoteOption) => void
}

function PollWidget({ poll, onVote }: PollWidgetProps) {
  const [voted, setVoted] = useState<string | null>(null)
  const total = Object.values(poll.votes).reduce((a, b) => a + b, 0)

  const handleVote = (opt: VoteOption) => {
    if (voted) return
    setVoted(opt)
    onVote(opt)
  }

  return (
    <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 16, marginTop: 12 }}>
      <p style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 10 }}>
        📊 {poll.question}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {poll.options.map((opt) => {
          const count = (poll.votes[opt] || 0) + (voted === opt ? 1 : 0)
          const totalNow = total + (voted ? 1 : 0)
          const pct = totalNow > 0 ? Math.round((count / totalNow) * 100) : 0
          const isVoted = voted === opt

          return (
            <button
              key={opt}
              onClick={() => handleVote(opt)}
              style={{
                position: 'relative',
                border: 'none',
                background: 'none',
                padding: 0,
                textAlign: 'left',
                cursor: voted ? 'default' : 'pointer',
                borderRadius: 8,
                overflow: 'hidden'
              }}
            >
              <div style={{
                position: 'absolute', top: 0, left: 0, height: '100%',
                width: voted ? `${pct}%` : '0%',
                background: isVoted ? 'rgba(108,99,255,0.18)' : 'rgba(108,99,255,0.08)',
                borderRadius: 8,
                transition: 'width 0.4s ease'
              }} />
              <div style={{
                position: 'relative',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                border: `1px solid ${isVoted ? '#6C63FF' : 'var(--border)'}`,
                borderRadius: 8,
                fontSize: 13,
                color: isVoted ? '#6C63FF' : 'var(--text-primary)',
                fontWeight: isVoted ? 600 : 400
              }}>
                <span>{isVoted ? '✓ ' : ''}{opt}</span>
                {voted && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{pct}%</span>}
              </div>
            </button>
          )
        })}
      </div>
      {voted && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
          {total + 1} total votes
        </p>
      )}
    </div>
  )
}

type ReactionBarProps = {
  reactions: Record<string, number>
  onReaction: (type: string) => void
}

function ReactionBar({ reactions, onReaction }: ReactionBarProps) {
  const REACTIONS = [
    { key: 'like', emoji: '👍', label: 'Like' },
    { key: 'love', emoji: '❤️', label: 'Love' },
    { key: 'insightful', emoji: '💡', label: 'Insightful' }
  ]
  const [clicked, setClicked] = useState<string | null>(null)

  const handleClick = (key: string) => {
    if (clicked) return
    setClicked(key)
    onReaction(key)
  }

  return (
    <div style={{ display: 'flex', gap: 8, padding: '10px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', margin: '12px 0' }}>
      {REACTIONS.map((r) => {
        const count = reactions[r.key] || 0
        const isActive = clicked === r.key
        return (
          <button
            key={r.key}
            onClick={() => handleClick(r.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 12px', borderRadius: 999,
              border: `1px solid ${isActive ? '#6C63FF' : 'var(--border)'}`,
              background: isActive ? '#EEF0FF' : 'transparent',
              color: isActive ? '#6C63FF' : 'var(--text-secondary)',
              fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              cursor: clicked ? 'default' : 'pointer',
              transition: 'all 0.15s'
            }}
          >
            <span style={{ fontSize: 15 }}>{r.emoji}</span>
            <span>{count + (isActive ? 1 : 0)}</span>
          </button>
        )
      })}
    </div>
  )
}

type CommentSectionProps = {
  comments: CommentItem[]
  onComment: (postId: number, comment: CommentItem) => void
  postId: number
}

function CommentSection({ comments, onComment, postId }: CommentSectionProps) {
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [showForm, setShowForm] = useState(false)

  const handleSubmit = () => {
    if (!text.trim() || !name.trim()) return
    onComment(postId, {
      id: Date.now(),
      author: name.trim(),
      avatar: name.trim().split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase(),
      text: text.trim(),
      time: 'Just now'
    })
    setText('')
    setShowForm(false)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
          💬 {comments.length} Comment{comments.length !== 1 ? 's' : ''}
        </p>
        <button
          onClick={() => setShowForm((v) => !v)}
          style={{
            padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 500,
            border: '1px solid var(--border)',
            background: showForm ? '#EEF0FF' : 'transparent',
            color: showForm ? '#6C63FF' : 'var(--text-secondary)',
            cursor: 'pointer'
          }}
        >
          {showForm ? 'Cancel' : '+ Add Comment'}
        </button>
      </div>

      {showForm && (
        <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <input
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <textarea
            placeholder="Share your thoughts..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <button
            onClick={handleSubmit}
            className="btn btn-primary"
            style={{ fontSize: 13, padding: '6px 16px' }}
          >
            Post Comment
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {comments.slice(0, 3).map((c) => (
          <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              flexShrink: 0,
              background: 'linear-gradient(135deg,#6C63FF,#FF6584)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              color: '#fff'
            }}>
              {c.avatar}
            </div>
            <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '8px 12px', flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)' }}>{c.author}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.time}</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{c.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

type PostCardProps = {
  post: PostItem
  onVote: (postId: number, option: string) => void
  onReaction: (postId: number, type: string) => void
  onComment: (postId: number, comment: CommentItem) => void
  showFull?: boolean
}

export default function PostCard({ post, onVote, onReaction, onComment, showFull = false }: PostCardProps) {
  const tc = TYPE_CONFIG[post.type]
  const fc = FREQ_CONFIG[post.frequency]

  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
      {post.image && (
        <div style={{ position: 'relative' }}>
          <img
            src={post.image}
            alt={post.title}
            style={{ width: '100%', height: 220, objectFit: 'cover', display: 'block' }}
          />
          <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 6 }}>
            <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: tc.bg, color: tc.text }}>
              {tc.icon} {tc.label}
            </span>
            <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: fc.bg, color: fc.text }}>
              {fc.label}
            </span>
          </div>
        </div>
      )}

      <div style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <h2 style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)', lineHeight: 1.4, flex: 1 }}>
            {post.title}
          </h2>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 12, flexShrink: 0 }}>
            {new Date(post.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          </span>
        </div>

        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 12 }}>
          {showFull ? post.description : `${post.description.slice(0, 160)}${post.description.length > 160 ? '...' : ''}`}
        </p>

        {!showFull && (
          <Link to={`/post/${post.id}`} style={{ fontSize: 13, color: 'var(--primary)', fontWeight: 500 }}>
            Read more →
          </Link>
        )}

        {post.poll && (
          <PollWidget poll={post.poll} onVote={(opt) => onVote(post.id, opt)} />
        )}

        <ReactionBar reactions={post.reactions} onReaction={(type) => onReaction(post.id, type)} />

        <CommentSection comments={post.comments} onComment={onComment} postId={post.id} />
      </div>
    </div>
  )
}
