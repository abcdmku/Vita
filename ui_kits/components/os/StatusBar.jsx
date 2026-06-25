import React from 'react';
export function StatusBar({ workspaces = 5, active = 1, path = '~/vita/src/kernel.ts', info = 'TS 5.9 · Ln 4, Col 18 · 10:24', branch = 'main' }) {
  return (
    <div style={{ height: 'var(--statusbar-h)', display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px',
      background: 'var(--surface-raised)', borderTop: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
      {Array.from({ length: workspaces }).map((_, i) => {
        const a = i + 1 === active;
        return <span key={i} style={{ padding: '2px 6px', borderRadius: 'var(--radius-xs)', fontWeight: 600,
          color: a ? 'var(--accent-fg)' : 'var(--text-muted)', background: a ? 'var(--accent)' : 'transparent' }}>{i + 1}</span>;
      })}
      <span style={{ marginLeft: 10, color: 'var(--text-muted)' }}>{path}</span>
      <span style={{ marginLeft: 'auto', color: 'var(--success)' }}>{branch} ✓</span>
      <span style={{ color: 'var(--text-faint)' }}>{info}</span>
    </div>
  );
}
