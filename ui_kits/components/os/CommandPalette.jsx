import React from 'react';
import { Icon } from '../icon/Icon';
const DEFAULTS = [
  { icon: 'terminal', title: 'Run kernel.ts', sub: 'TypeScript · main()', enter: true },
  { icon: 'folder', title: 'Open Files', sub: 'Application' },
  { icon: 'sun-moon', title: 'Toggle Dark Mode', sub: 'Command' },
];
export function CommandPalette({ query = '', placeholder = 'Search or run a command…', results = DEFAULTS, width = 520 }) {
  return (
    <div style={{ width, background: 'var(--surface-overlay)', backdropFilter: 'var(--blur-thick)', WebkitBackdropFilter: 'var(--blur-thick)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-popover)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--hairline)', color: 'var(--accent)' }}>
        <Icon name="search" size={19} />
        <span style={{ flex: 1, fontFamily: 'var(--font-sans)', fontSize: 16, color: query ? 'var(--text)' : 'var(--text-muted)' }}>{query || placeholder}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '3px 7px' }}>⌘K</span>
      </div>
      <div style={{ padding: 7 }}>
        {results.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 11px', borderRadius: 'var(--radius-md)', background: i === 0 ? 'var(--accent-subtle)' : 'transparent' }}>
            <span style={{ width: 30, height: 30, borderRadius: 'var(--radius-sm)', background: 'var(--surface)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: i === 0 ? 'var(--accent)' : 'var(--text-secondary)' }}>
              <Icon name={r.icon} size={16} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{r.title}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{r.sub}</div>
            </div>
            {r.enter ? <span style={{ color: 'var(--accent)' }}><Icon name="corner-down-left" size={15} /></span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
