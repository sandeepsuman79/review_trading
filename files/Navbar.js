import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function Navbar() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const links = [
    { to: '/', label: 'Profile' },
    { to: '/feed', label: 'Feed' },
  ];

  return (
    <nav style={{
      background: '#fff',
      borderBottom: '1px solid #E5E7EB',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      boxShadow: '0 1px 8px rgba(108,99,255,0.07)'
    }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60 }}>
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'linear-gradient(135deg, #6C63FF, #FF6584)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 16
          }}>P</div>
          <span style={{ fontWeight: 700, fontSize: 17, color: '#1A1A2E' }}>My Profile Portal</span>
        </Link>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {links.map(l => (
            <Link
              key={l.to}
              to={l.to}
              style={{
                padding: '7px 18px',
                borderRadius: 999,
                fontWeight: 500,
                fontSize: 14,
                background: location.pathname === l.to ? '#EEF0FF' : 'transparent',
                color: location.pathname === l.to ? '#6C63FF' : '#6B7280',
                border: location.pathname === l.to ? '1px solid #C7C3FF' : '1px solid transparent',
                transition: 'all 0.15s'
              }}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
