import React from 'react';
import { Icon } from '../icon/Icon';
export function ListRow({ icon, title = 'Item', subtitle, trailing, indent = 0, active = false, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 12px', paddingLeft: 12 + indent * 16,
        borderRadius: 'var(--radius-md)', cursor: 'pointer',
        background: active ? 'var(--accent-subtle)' : hover ? 'var(--surface-sunken)' : 'transparent', transition: 'background var(--dur-fast)' }}>
      {icon ? (
        <span style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 'var(--radius-sm)', background: 'var(--surface)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
          <Icon name={icon} size={15} />
        </span>
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 500, color: active ? 'var(--accent)' : 'var(--text)' }}>{title}</div>
        {subtitle ? <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{subtitle}</div> : null}
      </div>
      {trailing != null ? <div style={{ flexShrink: 0, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-muted)' }}>{trailing}</div> : null}
    </div>
  );
}
