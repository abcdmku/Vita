import React from 'react';
import { Icon } from '../icon/Icon';
export function Toast({ icon = 'code', app = 'Studio', title = 'Build passed', body = 'kernel.ts compiled · 0.8s', time = 'now', tone = 'accent' }) {
  const c = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--accent)';
  return (
    <div style={{ display: 'flex', gap: 11, width: 300, padding: '13px 14px', background: 'var(--surface-overlay)', backdropFilter: 'var(--blur-thick)',
      WebkitBackdropFilter: 'var(--blur-thick)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-popover)' }}>
      <span style={{ width: 34, height: 34, flexShrink: 0, borderRadius: 'var(--radius-md)', background: 'var(--surface)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: c }}><Icon name={icon} size={17} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{app}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>{time}</span>
        </div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)', marginTop: 2 }}>{title}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}>{body}</div>
      </div>
    </div>
  );
}
