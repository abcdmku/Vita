import React from 'react';
export function Tabs({ tabs = ['General', 'Appearance', 'Network'], value, onChange }) {
  const [val, setVal] = React.useState(value != null ? value : tabs[0]);
  React.useEffect(() => { if (value != null) setVal(value); }, [value]);
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
      {tabs.map((t) => {
        const a = t === val;
        return (
          <button key={t} onClick={() => { setVal(t); if (onChange) onChange(t); }}
            style={{ position: 'relative', padding: '10px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: a ? 600 : 500, color: a ? 'var(--text)' : 'var(--text-muted)',
              transition: 'color var(--dur-fast)' }}>
            {t}
            <span style={{ position: 'absolute', left: 10, right: 10, bottom: -1, height: 2, borderRadius: 2, background: a ? 'var(--accent)' : 'transparent' }} />
          </button>
        );
      })}
    </div>
  );
}
