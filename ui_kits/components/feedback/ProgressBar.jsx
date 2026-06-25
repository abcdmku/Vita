import React from 'react';
export function ProgressBar({ value = 40, max = 100, label, accent = 'var(--accent)', width = '100%' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div style={{ width, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>
          <span>{label}</span><span style={{ color: 'var(--text-secondary)' }}>{Math.round(pct)}%</span>
        </div>
      ) : null}
      <div style={{ height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--border-strong)', overflow: 'hidden' }}>
        <div style={{ width: pct + '%', height: '100%', background: accent, borderRadius: 'var(--radius-pill)',
          transition: 'width var(--dur-slow) var(--ease-decelerate)' }} />
      </div>
    </div>
  );
}
