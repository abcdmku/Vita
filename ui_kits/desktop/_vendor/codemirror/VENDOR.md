# Vendored: CodeMirror 5 (offline, no runtime CDN)

The Vita dev-loop **Editor** app renders its code surface with CodeMirror 5. It is vendored here so the
app loads it same-origin and fully offline (spec §9.3 — no runtime CDN, no lifecycle scripts). Only
these third-party files are vendored; the Editor app's own HTML/CSS/JS is Vita's code.

- **Package:** CodeMirror 5
- **Version:** 5.65.16
- **License:** MIT (see `LICENSE`) — AGPL-clean, compatible with the Apache-2.0-SDK-only line.
- **Source:** cdnjs `https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/...` (fetched once, vendored).

## Files + Subresource Integrity (sha256, base64)

| file | integrity |
|---|---|
| `codemirror.min.js`   | `sha256-8QK7YfsqxFw6YRhH7dmUj6rQqyKoOi36mXS+UDEHmxU=` |
| `codemirror.min.css`  | `sha256-EQdxEqtpVdKf5BCFxiNlx9Si8ApXDHR14q7CqMvIX8Q=` |
| `javascript.min.js`   | `sha256-mbRvNRtLHOihTN8E/kI17LQptbe5hoZwNKfcGVpxClg=` |
| `css.min.js`          | `sha256-7gzgDzRqbX40WnSrMvLMYA6Lffh4socV19UhkvonTu4=` |
| `xml.min.js`          | `sha256-FAP2/AQmTDjpM4kXEGNu0HdhiYqnZN6Vo5qDLUM8vmY=` |
| `htmlmixed.min.js`    | `sha256-UG4SwfxoQ3wvXUWy18jNNB8jGtlMUSZmfAJyv+Y1nmo=` |
| `markdown.min.js`     | `sha256-bTExCkcZ0VHRmLYEhk+ny33KpQE4iIY1heBtfHCF89g=` |

Recompute with: `openssl dgst -sha256 -binary <file> | openssl base64 -A`.
