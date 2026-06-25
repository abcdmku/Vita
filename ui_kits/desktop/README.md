# Vita — Desktop UI kit

Full-screen recreations of the Vita desktop, 1280×800. Each `.html` links `../../styles.css` (tokens) + `kit.css` (kit classes) and is tagged as a Design-System card; key screens are also Starting Points.

| Screen | Theme | Shows |
|---|---|---|
| `index.html` (Desktop) | Light | Menu bar, shell window, ⌘K command launcher, dock |
| `Settings.html` | Light | Sidebar + Appearance pane (theme, accent, layout) |
| `Files.html` | Light | Breadcrumb toolbar, favorites sidebar, file list |
| `Shell.html` | Dark | Tabbed TypeScript REPL terminal |
| `Tiling.html` | Graphite | Editor + explorer + system panes, status bar |
| `Notifications.html` | Dark | Control Center + notification shade |
| `Lock.html` | Dark | Sign-in over a glow wallpaper |
| `Activity.html` | Light | Sample built-in app — system monitor |

Theme any screen by toggling `theme-dark` (and `mode-tiling`) on `.v-screen`.
