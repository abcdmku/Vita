#!/usr/bin/env node
// @vita/echo-cli — the packaged bin. A `bin` is an executable, not an importable module, so the
// packager generates a CMD app (a terminal-style surface). Real out-of-process execution lands with the
// capsule exec transport; until then the generated cmd surface echoes args locally (honest stub).
process.stdout.write(process.argv.slice(2).join(" ") + "\n");
