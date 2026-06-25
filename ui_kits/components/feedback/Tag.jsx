import React from 'react';
import { Icon } from '../icon/Icon';
export function Tag({ children, mono = true, onRemove }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 24, padding: onRemove ? '0 5px 0 10px' : '0 10px',
      borderRadius: 'var(--radius-sm)', background: 'var(--surface)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-1)',
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>
      {children}
      {onRemove ? <button onClick={onRemove} aria-label="Remove" style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}><Icon name="x" size={13} /></button> : null}
    </span>
  );
}
