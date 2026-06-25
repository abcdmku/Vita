import React from 'react';
import { Icon } from '../icon/Icon';
export function MenuBar({ menus = ['File', 'Edit', 'View', 'Go', 'Window', 'Help'], time = '10:24' }) {
  return (
    <div style={{ height: 'var(--menubar-h)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 15px',
      background: 'var(--surface-translucent)', backdropFilter: 'var(--blur)', WebkitBackdropFilter: 'var(--blur)', borderBottom: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 1 }}>
          <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>Vita</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 11, color: 'var(--accent)' }}>.ts</span>
        </span>
        <div style={{ display: 'flex', gap: 15 }}>
          {menus.map((m) => <span key={m} style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 12.5, color: 'var(--text-secondary)' }}>{m}</span>)}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, color: 'var(--text-secondary)' }}>
        <Icon name="wifi" size={15} />
        <Icon name="battery-full" size={19} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)' }}>{time}</span>
      </div>
    </div>
  );
}
