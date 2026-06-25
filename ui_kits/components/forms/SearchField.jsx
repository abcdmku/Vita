import React from 'react';
import { Icon } from '../icon/Icon';
export function SearchField({ placeholder = 'Search or run a command…', shortcut = '⌘K', value, onChange }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 38, padding: '0 12px', minWidth: 300,
      background: 'var(--surface)', border: '1px solid ' + (focus ? 'var(--accent)' : 'var(--border-strong)'),
      borderRadius: 'var(--radius-md)', boxShadow: focus ? '0 0 0 3px var(--focus-ring)' : 'var(--shadow-1)',
      transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)' }}>
      <span style={{ color: 'var(--accent)' }}><Icon name="search" size={17} /></span>
      <input value={value} placeholder={placeholder} onChange={onChange} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-sans)', fontSize: 14.5, color: 'var(--text)' }} />
      {shortcut ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '3px 7px' }}>{shortcut}</span> : null}
    </div>
  );
}
