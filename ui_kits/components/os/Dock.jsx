import React from 'react';
import { AppTile } from './AppTile';
export function Dock({ apps = [{ icon: 'terminal', active: true }, { icon: 'code' }, { icon: 'folder' }, { icon: 'mail' }, { icon: 'globe' }], settings = true }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 9, padding: '8px 11px', background: 'var(--surface-translucent)',
      backdropFilter: 'var(--blur-thick)', WebkitBackdropFilter: 'var(--blur-thick)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-2xl)', boxShadow: 'var(--shadow-3)' }}>
      {apps.map((a, i) => <AppTile key={i} icon={a.icon} active={a.active} size={46} />)}
      {settings ? <span style={{ width: 1, height: 36, background: 'var(--hairline)', margin: '0 2px' }} /> : null}
      {settings ? <AppTile icon="settings" size={46} /> : null}
    </div>
  );
}
