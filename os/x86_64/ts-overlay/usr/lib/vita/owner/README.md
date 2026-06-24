This directory contains public-only owner smoke-test material.
The image staging step validates these committed public/reject fixtures without regenerating them.
The assertion is intentionally stale once agentd mints a fresh random challenge, so the unprivileged
TypeScript runtime can prove fail-closed rejection without holding an owner private key.
