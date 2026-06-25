import React from 'react';
export function WindowChrome({ title = 'shell — ~/vita', children, width = 520, height, focused = true, tiling = false, accentBorder = false }) {
  return (
    <div style={{ width, height, display: 'flex', flexDirection: 'column', background: 'var(--surface)',
      border: '1px solid ' + (accentBorder ? 'var(--accent)' : 'var(--border)'),
      borderRadius: tiling ? 'var(--radius-xs)' : 'var(--radius-window)',
      boxShadow: focused ? 'var(--shadow-window)' : 'var(--shadow-2)', overflow: 'hidden', opacity: focused ? 1 : 0.94 }}>
      <div style={{ height: tiling ? 30 : 38, display: 'flex', alignItems: 'center', gap: 11, padding: '0 14px',
        background: 'var(--surface-raised)', borderBottom: '1px solid var(--hairline)' }}>
        {!tiling ? (
          <div style={{ display: 'flex', gap: 7 }}>
            {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: '50%', background: focused ? 'var(--border-strong)' : 'var(--border)' }} />)}
          </div>
        ) : null}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: focused ? 'var(--text-secondary)' : 'var(--text-muted)' }}>{title}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
    </div>
  );
}
