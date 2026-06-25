import React from 'react';
export function SegmentedControl({ options = ['Light', 'Dark', 'Auto'], value, onChange }) {
  const [val, setVal] = React.useState(value != null ? value : options[0]);
  React.useEffect(() => { if (value != null) setVal(value); }, [value]);
  return (
    <div style={{ display: 'inline-flex', gap: 2, padding: 3, background: 'var(--surface-sunken)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
      {options.map((opt) => {
        const active = opt === val;
        return (
          <button key={opt} onClick={() => { setVal(opt); if (onChange) onChange(opt); }}
            style={{ height: 28, padding: '0 14px', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: active ? 600 : 500,
              color: active ? 'var(--text)' : 'var(--text-muted)', background: active ? 'var(--surface)' : 'transparent',
              boxShadow: active ? 'var(--shadow-1)' : 'none', transition: 'all var(--dur-fast) var(--ease-standard)' }}>
            {opt}
          </button>
        );
      })}
    </div>
  );
}
