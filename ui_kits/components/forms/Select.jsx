import React from 'react';
import { Icon } from '../icon/Icon';
export function Select({ value = 'Automatic', size = 'md', disabled = false, onClick }) {
  const [hover, setHover] = React.useState(false);
  const height = size === 'sm' ? 28 : size === 'lg' ? 40 : 34;
  return (
    <button onClick={onClick} disabled={disabled} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, height, padding: '0 8px 0 12px', minWidth: 160,
        background: hover ? 'var(--surface-sunken)' : 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-control)',
        boxShadow: 'var(--shadow-1)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--text)' }}>
      <span>{value}</span>
      <span style={{ color: 'var(--text-muted)' }}><Icon name="chevrons-up-down" size={15} /></span>
    </button>
  );
}
