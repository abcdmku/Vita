import React from 'react';
export function LockClock({ time = '10:24', date = 'Tuesday, June 25' }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-secondary)' }}>{date}</div>
      <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 300, fontSize: 76, letterSpacing: '-0.03em', lineHeight: 1.02, color: 'var(--text)' }}>{time}</div>
    </div>
  );
}
