import React from 'react';
export function Switch({ on = false, disabled = false, onChange }) {
  const [val, setVal] = React.useState(on);
  React.useEffect(() => setVal(on), [on]);
  const toggle = () => { if (disabled) return; const n = !val; setVal(n); if (onChange) onChange(n); };
  return (
    <button role="switch" aria-checked={val} onClick={toggle} disabled={disabled}
      style={{ width: 38, height: 22, borderRadius: 'var(--radius-pill)', border: 'none', padding: 2, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1, background: val ? 'var(--accent)' : 'var(--border-strong)', display: 'inline-flex',
        justifyContent: val ? 'flex-end' : 'flex-start', alignItems: 'center', transition: 'background var(--dur-base) var(--ease-standard)' }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.3)',
        transition: 'all var(--dur-base) var(--ease-spring)' }} />
    </button>
  );
}
