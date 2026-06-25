import React from 'react';
const SHADOW = { '0': 'var(--shadow-0)', '1': 'var(--shadow-1)', '2': 'var(--shadow-2)', '3': 'var(--shadow-3)' };
export function Card({ title, action, children, padding = 16, elevation = '2' }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      boxShadow: SHADOW[elevation] || SHADOW['2'], overflow: 'hidden' }}>
      {title ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px',
          borderBottom: '1px solid var(--hairline)' }}>
          <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{title}</span>
          {action || null}
        </div>
      ) : null}
      <div style={{ padding }}>{children}</div>
    </div>
  );
}
