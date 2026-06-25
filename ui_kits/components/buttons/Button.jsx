import React from 'react';

const SIZES = {
  sm: { height: 28, padding: '0 10px', fontSize: 12.5, radius: 'var(--radius-sm)' },
  md: { height: 34, padding: '0 14px', fontSize: 13.5, radius: 'var(--radius-control)' },
  lg: { height: 40, padding: '0 18px', fontSize: 15, radius: 'var(--radius-md)' },
};

export function Button({ children, variant = 'primary', size = 'md', icon = null, disabled = false, onClick }) {
  const [hover, setHover] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const fills = {
    primary: { background: hover ? 'var(--accent-hover)' : 'var(--accent)', color: 'var(--accent-fg)', border: '1px solid transparent', boxShadow: 'var(--shadow-1)' },
    secondary: { background: hover ? 'var(--surface-sunken)' : 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-1)' },
    ghost: { background: hover ? 'var(--surface-sunken)' : 'transparent', color: 'var(--text-secondary)', border: '1px solid transparent', boxShadow: 'none' },
    destructive: { background: hover ? 'var(--danger)' : 'var(--danger-subtle)', color: hover ? '#fff' : 'var(--danger)', border: '1px solid transparent', boxShadow: 'none' },
  };
  const v = fills[variant] || fills.primary;
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        height: s.height, padding: s.padding, fontFamily: 'var(--font-sans)', fontSize: s.fontSize, fontWeight: 600,
        borderRadius: s.radius, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap',
        transition: 'background var(--dur-fast) var(--ease-standard)', ...v }}>
      {icon ? <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{icon}</span> : null}
      {children}
    </button>
  );
}
