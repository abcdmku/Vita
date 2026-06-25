import React from 'react';
const TONES = {
  neutral: { bg: 'var(--surface-sunken)', fg: 'var(--text-secondary)', bd: 'var(--border)' },
  accent: { bg: 'var(--accent-subtle)', fg: 'var(--accent)', bd: 'transparent' },
  success: { bg: 'var(--success-subtle)', fg: 'var(--success)', bd: 'transparent' },
  warning: { bg: 'var(--warning-subtle)', fg: 'var(--warning)', bd: 'transparent' },
  danger: { bg: 'var(--danger-subtle)', fg: 'var(--danger)', bd: 'transparent' },
};
export function Badge({ children, tone = 'neutral', dot = false }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 20, padding: '0 8px', borderRadius: 'var(--radius-pill)',
      background: t.bg, color: t.fg, border: '1px solid ' + t.bd, fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600 }}>
      {dot ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.fg }} /> : null}
      {children}
    </span>
  );
}
