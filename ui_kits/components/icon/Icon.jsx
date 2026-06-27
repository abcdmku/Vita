import React from 'react';

// Vita uses the Lucide icon library. This component renders one icon and, if the
// Lucide UMD runtime is not already on the page, loads it once from the local
// vendored copy — so <Icon> (and every component built on it) works fully offline.
// Path is relative to the DS-gallery base (DIRECTIONS.html lives at ui_kits/).
const LUCIDE_SRC = './_vendor/lucide.min.js';
let _loader = null;

function ensureLucide() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.lucide) return Promise.resolve(window.lucide);
  if (_loader) return _loader;
  _loader = new Promise((resolve) => {
    const existing = document.querySelector('script[data-lucide-cdn]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.lucide || null));
      existing.addEventListener('error', () => resolve(null));
      return;
    }
    const s = document.createElement('script');
    s.src = LUCIDE_SRC;
    s.async = true;
    s.setAttribute('data-lucide-cdn', '');
    s.onload = () => resolve(window.lucide || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return _loader;
}

export function Icon({ name = 'circle', size = 18, strokeWidth = 2, style }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    let cancelled = false;
    const paint = (lucide) => {
      const host = ref.current;
      if (!host || cancelled || !lucide || !lucide.createIcons) return;
      host.innerHTML = '<i data-lucide="' + name + '"></i>';
      lucide.createIcons({ attrs: { width: size, height: size, 'stroke-width': strokeWidth } });
    };
    if (window.lucide) paint(window.lucide);
    else ensureLucide().then(paint);
    return () => { cancelled = true; };
  }, [name, size, strokeWidth]);
  return (
    <span ref={ref} aria-hidden="true"
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, ...style }} />
  );
}
