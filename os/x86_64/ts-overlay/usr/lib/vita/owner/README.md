This directory contains public-only owner smoke-test material.
The image staging step validates these committed public/reject fixtures without regenerating them.
The assertion is intentionally stale once agentd mints a fresh random challenge, so the unprivileged
TypeScript runtime can prove fail-closed rejection without holding an owner signing key.

The full on-device live-authenticator success round trip is deferred to a later Phase-2 slice with a
real external authenticator. The Go owner capability tests prove the success path with an in-memory
test signer over an agentd-issued challenge.
