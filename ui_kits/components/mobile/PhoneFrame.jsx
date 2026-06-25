import React from 'react';
export function PhoneFrame({ children, width = 300 }) {
  const height = Math.round(width * (620 / 300));
  return (
    <div style={{ width, height, borderRadius: Math.round(width * 0.146), background: '#0c0e12', padding: Math.round(width * 0.03), boxShadow: 'var(--shadow-4)' }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: Math.round(width * 0.12), overflow: 'hidden', background: 'var(--surface-base)' }}>
        <div style={{ position: 'absolute', top: Math.round(width * 0.037), left: '50%', transform: 'translateX(-50%)',
          width: Math.round(width * 0.32), height: Math.round(width * 0.08), background: '#0c0e12', borderRadius: Math.round(width * 0.04), zIndex: 5 }} />
        {children}
      </div>
    </div>
  );
}
