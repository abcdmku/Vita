Vita uses the **Lucide** icon library — no custom SVGs, no emoji. Color comes from `currentColor`; size via `size`.

<Icon name="terminal" size={20} />

Common names: terminal, code, folder, mail, globe, music, image, settings, search, wifi, bell, chevron-right.

`Icon` **auto-loads** the Lucide runtime from the CDN on first use, so it (and every component built on it — `AppTile`, `Dock`, `ListRow`, `MenuBar`, `CommandPalette`, …) works with no setup when online. To run offline, self-host Lucide and expose it as `window.lucide` before mount.
