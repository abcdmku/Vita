import React from 'react';
export function Tooltip({ label = 'Tooltip', shortcut, children }) {
  const [show, setShow] = React.useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show ? (
        <span style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap',
          display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 9px', borderRadius: 'var(--radius-sm)',
          background: 'var(--ink-800)', color: 'var(--ink-50)', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500,
          boxShadow: 'var(--shadow-3)', zIndex: 50 }}>
          {label}
          {shortcut ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--ink-300)' }}>{shortcut}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
