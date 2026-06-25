import React from 'react';
export function Checkbox({ checked = false, label, disabled = false, onChange }) {
  const [on, setOn] = React.useState(checked);
  React.useEffect(() => setOn(checked), [checked]);
  const toggle = () => { if (disabled) return; const n = !on; setOn(n); if (onChange) onChange(n); };
  return (
    <label onClick={toggle} style={{ display: 'inline-flex', alignItems: 'center', gap: 9, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1, fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text)' }}>
      <span style={{ width: 18, height: 18, borderRadius: 'var(--radius-xs)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: on ? 'var(--accent)' : 'var(--surface)', border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border-strong)'),
        boxShadow: 'var(--shadow-1)', color: 'var(--accent-fg)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
        transition: 'background var(--dur-fast), border-color var(--dur-fast)' }}>{on ? '\u2713' : ''}</span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
