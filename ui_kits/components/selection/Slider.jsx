import React from 'react';
export function Slider({ value = 60, min = 0, max = 100, accent = 'var(--accent)', width = 220 }) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div style={{ position: 'relative', width, height: 22, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--border-strong)' }} />
      <div style={{ position: 'absolute', left: 0, width: pct + '%', height: 6, borderRadius: 'var(--radius-pill)', background: accent }} />
      <div style={{ position: 'absolute', left: 'calc(' + pct + '% - 9px)', width: 18, height: 18, borderRadius: '50%', background: '#fff',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-2)' }} />
    </div>
  );
}
