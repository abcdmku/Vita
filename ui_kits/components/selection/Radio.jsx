import React from 'react';
export function Radio({ selected = false, label, name, disabled = false, onSelect }) {
  return (
    <label onClick={() => { if (!disabled && onSelect) onSelect(); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 9, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1, fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text)' }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface)', border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border-strong)'), boxShadow: 'var(--shadow-1)',
        transition: 'border-color var(--dur-fast)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: selected ? 'var(--accent)' : 'transparent', transition: 'background var(--dur-fast)' }} />
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
