import React from 'react';

const H = { sm: 28, md: 34, lg: 40 };

export function Input({ value, placeholder = '', type = 'text', size = 'md', prefix = null, invalid = false, disabled = false, onChange }) {
  const [focus, setFocus] = React.useState(false);
  const height = H[size] || 34;
  const borderColor = invalid ? 'var(--danger)' : focus ? 'var(--accent)' : 'var(--border-strong)';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height, padding: '0 12px', minWidth: 220,
      background: disabled ? 'var(--surface-sunken)' : 'var(--surface)', border: '1px solid ' + borderColor,
      borderRadius: 'var(--radius-control)', boxShadow: focus ? '0 0 0 3px var(--focus-ring)' : 'var(--shadow-1)',
      transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)', opacity: disabled ? 0.6 : 1 }}>
      {prefix ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' }}>{prefix}</span> : null}
      <input type={type} value={value} placeholder={placeholder} disabled={disabled} onChange={onChange}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
          fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text)' }} />
    </div>
  );
}
