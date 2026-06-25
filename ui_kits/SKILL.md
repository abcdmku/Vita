---
name: vita-design
description: Use this skill to generate well-branded interfaces and assets for Vita, a TypeScript-native operating system, either for production or throwaway prototypes/mocks. Contains design guidelines, colors, type, fonts, and a UI-kit of components and full screens for desktop + mobile, in light + dark.
user-invocable: true
---

Read the `readme.md` file in this skill, then explore the other files: `styles.css` and `tokens/` (the token layer), `guidelines/` (foundation specimens), `components/` (reusable React primitives with `.d.ts` contracts and `.prompt.md` usage), and `ui_kits/` (full-screen recreations for desktop + mobile).

If creating visual artifacts (slides, mocks, throwaway prototypes), copy the tokens/assets out and produce static HTML that links `styles.css` and uses the CSS custom properties — the screens in `ui_kits/` are the best starting points to copy. If working on production code, import the `components/*.jsx` and follow the rules in `readme.md` to design as an expert in the Vita brand.

Key rules: Geist + Geist Mono only; TypeScript-blue accent (#3178C6 light / #4F9DFF dark); icons are monospace tokens + simple geometric marks (no emoji, no SVG icon set); soft radii (sharp in tiling mode); sentence-case UI copy with monospace for code/paths/shortcuts.

If the user invokes this skill without other guidance, ask what they want to build, ask a few clarifying questions, and act as an expert designer who outputs HTML artifacts or production code as needed.
