import React from 'react';
import { Icon } from '../icon/Icon';
const SIZES = { sm: 28, md: 34, lg: 40 };
export function IconButton({ icon = 'plus', size = 'md', variant = 'ghost', active = false, label, onClick }) {
  const [hover, setHover] = React.useState(false);
  const d = SIZES[size] || SIZES.md;
  const bg = active ? 'var(--accent-subtle)' : hover ? 'var(--surface-sunken)' : variant === 'solid' ? 'var(--surface)' : 'transparent';
  const color = active ? 'var(--accent)' : 'var(--text-secondary)';
  return (
    <button onClick={onClick} aria-label={label} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: d, height: d, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color, background: bg,
        border: variant === 'solid' ? '1px solid var(--border)' : '1px solid transparent', borderRadius: 'var(--radius-control)',
        cursor: 'pointer', transition: 'background var(--dur-fast) var(--ease-standard)' }}>
      <Icon name={icon} size={Math.round(d * 0.5)} />
    </button>
  );
}
