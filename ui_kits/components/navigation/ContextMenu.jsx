import React from 'react';
import { Icon } from '../icon/Icon';
const DEFAULTS = [
  { icon: 'terminal', label: 'Open in Shell', shortcut: '⌘O' },
  { icon: 'code', label: 'Edit in Studio', shortcut: '⌘E' },
  { separator: true },
  { icon: 'folder', label: 'Reveal in Files' },
  { icon: 'share-2', label: 'Share…' },
  { separator: true },
  { icon: 'trash-2', label: 'Delete', shortcut: '⌘⌫', danger: true },
];
export function ContextMenu({ items = DEFAULTS, width = 220 }) {
  return (
    <div style={{ width, padding: 6, background: 'var(--surface-overlay)', backdropFilter: 'var(--blur-thick)', WebkitBackdropFilter: 'var(--blur-thick)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-popover)' }}>
      {items.map((it, i) => it.separator
        ? <div key={i} style={{ height: 1, background: 'var(--hairline)', margin: '5px 8px' }} />
        : (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 9px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: it.danger ? 'var(--danger)' : 'var(--text)' }}>
            <span style={{ color: it.danger ? 'var(--danger)' : 'var(--text-muted)' }}><Icon name={it.icon} size={16} /></span>
            <span style={{ flex: 1, fontFamily: 'var(--font-sans)', fontSize: 13.5 }}>{it.label}</span>
            {it.shortcut ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: it.danger ? 'var(--danger)' : 'var(--text-faint)' }}>{it.shortcut}</span> : null}
          </div>
        ))}
    </div>
  );
}
