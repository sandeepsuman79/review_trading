# My Profile Portal — React App

A full-featured personal profile web app with community engagement features.

## Features

- **Profile Page** — Your photo, bio, stats, skills, and social links
- **Feed Page** — Daily/Weekly/Monthly posts with type filters:
  - 🖼️ Banners (Daily)
  - 🎬 Trailers (Weekly)
  - 📚 Book Reviews (Weekly)
  - 👑 Leader Spotlights (Monthly)
- **Voting Polls** — Users can vote on poll options per post
- **Reactions** — Like 👍, Love ❤️, Insightful 💡
- **Comments** — Guests can add their name and opinion
- **Filter & Search** — Filter by type, frequency, or keyword
- **Post Detail Page** — Full post view with all interactions

## Getting Started

### 1. Install dependencies
```bash
npm install
```

### 2. Start development server
```bash
npm start
```

The app will open at **http://localhost:3000**

## Customization

### Update your profile info:
Edit `src/data/posts.js` → `profileData` object:
- Change `name`, `title`, `bio`, `location`
- Update `socials` with your real handles
- Replace `avatar: null` with an image URL if desired

### Add a real profile picture:
In `src/pages/ProfilePage.js`, replace the avatar div with:
```jsx
<img src="YOUR_IMAGE_URL" alt="Profile" style={{ width:100, height:100, borderRadius:'50%', objectFit:'cover', border:'4px solid #fff' }} />
```

### Add new posts:
Edit `src/data/posts.js` → `postsData` array. Each post can have:
- `type`: banner | trailer | book | leader
- `frequency`: daily | weekly | monthly
- `title`, `description`, `image`, `date`
- `poll` with `question`, `options`, `votes`
- `reactions` with like, love, insightful counts
- `comments` array

## Folder Structure
```
src/
├── components/
│   ├── Navbar.js       # Top navigation
│   └── PostCard.js     # Post card with poll, reactions, comments
├── pages/
│   ├── ProfilePage.js  # Your profile/about page
│   ├── FeedPage.js     # All posts with filters
│   └── PostDetail.js   # Single post full view
├── data/
│   └── posts.js        # All data: profile info + posts
├── App.js              # Main app with routing
├── index.js            # Entry point
└── index.css           # Global styles
```
