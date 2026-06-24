This directory is the x86_64 smoke-test authenticator, not production owner material.

The files are made root-only by `os/x86_64/ts-image.mjs`; the unprivileged TypeScript runtime is
granted access only to `/run/vita-owner-test-authenticator/signer.sock`. Production images must use
an external owner passkey instead of this test helper.
