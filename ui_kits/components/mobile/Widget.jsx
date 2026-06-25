import React from 'react';
export function Widget({ title = 'SYSTEM · LIVE', children, width = '100%', translucent = false }) {
  return (
    <div style={{ width, padding: '14px 16px', borderRadius: 'var(--radius-xl)',
      background: translucent ? 'var(--surface-translucent)' : 'var(--surface)', backdropFilter: translucent ? 'var(--blur)' : 'none',
      WebkitBackdropFilter: translucent ? 'var(--blur)' : 'none', border: '1px solid var(--border)', boxShadow: 'var(--shadow-1)' }}>
      {title ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.1em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 11 }}>{title}</div> : null}
      {children}
    </div>
  );
}
