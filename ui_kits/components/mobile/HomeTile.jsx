import React from 'react';
import { Icon } from '../icon/Icon';
export function HomeTile({ icon = 'terminal', label = 'Shell', accent = false, size = 60 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>
      <div style={{ width: size, height: size, borderRadius: Math.round(size * 0.3),
        background: accent ? 'var(--accent)' : 'var(--surface)', border: '1px solid ' + (accent ? 'transparent' : 'var(--border)'),
        boxShadow: 'var(--shadow-1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: accent ? 'var(--accent-fg)' : 'var(--text-secondary)' }}>
        <Icon name={icon} size={Math.round(size * 0.42)} />
      </div>
      {label ? <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--text-secondary)' }}>{label}</span> : null}
    </div>
  );
}
