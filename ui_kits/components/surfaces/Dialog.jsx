import React from 'react';
export function Dialog({ title = 'Delete file?', message, children, confirmLabel = 'Delete', cancelLabel = 'Cancel', tone = 'danger', width = 400, overlay = false, onConfirm, onCancel }) {
  const confirmBg = tone === 'danger' ? 'var(--danger)' : 'var(--accent)';
  const panel = (
    <div style={{ width, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-popover)', overflow: 'hidden' }}>
      <div style={{ padding: '20px 22px' }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 17, color: 'var(--text)' }}>{title}</div>
        {message ? <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-secondary)', marginTop: 8 }}>{message}</div> : null}
        {children}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 22px', background: 'var(--surface-sunken)', borderTop: '1px solid var(--hairline)' }}>
        <button onClick={onCancel} style={{ height: 34, padding: '0 14px', borderRadius: 'var(--radius-control)', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-1)' }}>{cancelLabel}</button>
        <button onClick={onConfirm} style={{ height: 34, padding: '0 14px', borderRadius: 'var(--radius-control)', border: 'none', background: confirmBg, color: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>{confirmLabel}</button>
      </div>
    </div>
  );
  if (!overlay) return panel;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,13,18,.4)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>{panel}</div>
  );
}
