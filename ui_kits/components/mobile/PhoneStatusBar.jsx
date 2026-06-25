import React from 'react';
export function PhoneStatusBar({ time = '10:24' }) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 22px 0', color: 'var(--text)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13 }}>{time}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 9 }}>
          {[4, 6, 9].map((h, i) => <span key={i} style={{ width: 2.5, height: h, background: 'currentColor', borderRadius: 1 }} />)}
        </span>
        <span style={{ width: 18, height: 9, border: '1.3px solid currentColor', borderRadius: 2.5, padding: 1, display: 'flex' }}>
          <span style={{ width: '65%', background: 'currentColor', borderRadius: 1 }} />
        </span>
      </div>
    </div>
  );
}
