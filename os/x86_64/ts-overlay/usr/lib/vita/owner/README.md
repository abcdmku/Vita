This directory contains public-only owner smoke-test material.
The image staging step validates these committed public/reject fixtures without regenerating them.
The assertion is intentionally stale once agentd mints a fresh random challenge, so the unprivileged
TypeScript runtime can prove fail-closed rejection without holding an owner signing key.

The separate root-owned smoke-test authenticator under /usr/lib/vita/owner-authenticator signs fresh
agentd challenges for the measured success marker. The TypeScript runtime can only reach it through
its Unix socket.
