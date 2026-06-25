import React from 'react';
import { Icon } from '../icon/Icon';
export function AppTile({ icon = 'terminal', active = false, size = 48, label }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), background: 'var(--surface)',
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
        boxShadow: active ? 'var(--glow-accent), var(--shadow-1)' : 'var(--shadow-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
        <Icon name={icon} size={Math.round(size * 0.46)} />
      </div>
      {active ? <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--accent)' }} /> : null}
      {label ? <span style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-muted)' }}>{label}</span> : null}
    </div>
  );
}
