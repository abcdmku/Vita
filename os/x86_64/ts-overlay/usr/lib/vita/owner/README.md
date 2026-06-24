This directory contains public-only owner smoke-test material.
The image staging step regenerates the public credential and signed assertion from an in-memory
test authenticator key, then discards the signer. No owner private key is staged here or used by
the unprivileged TypeScript runtime.
