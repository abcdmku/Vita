import React from 'react';
import { Icon } from '../icon/Icon';
export function ControlCenterTile({ icon = 'wifi', label = 'Wi-Fi', value = 'on', on = true, wide = false }) {
  return (
    <div style={{ width: wide ? '100%' : 'auto', minWidth: 120, height: 58, padding: '11px 12px', borderRadius: 'var(--radius-lg)',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      background: on ? 'var(--accent)' : 'var(--surface-raised)', border: '1px solid ' + (on ? 'transparent' : 'var(--border)'),
      color: on ? '#fff' : 'var(--text-secondary)' }}>
      <span style={{ color: on ? 'rgba(255,255,255,.9)' : 'var(--text-muted)' }}><Icon name={icon} size={16} /></span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: on ? 600 : 500 }}>{label}</span>
        {value ? <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11.5, opacity: 0.75 }}>{value}</span> : null}
      </div>
    </div>
  );
}
