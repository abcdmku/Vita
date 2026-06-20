# ADR 0004: LUKS2 and Btrfs Storage

## Status

Accepted.

## Context

Spec section 5 sets storage to LUKS2 plus Btrfs with separate immutable OS and encrypted mutable data. Section 10.1 defines the disk layout as EFI/boot, recovery, immutable dm-verity Root A and Root B slots, and encrypted data containing system state, user data, app state, snapshots, and local backup cache. Section 10.2 requires LUKS2 encryption for authoritative data, TPM-assisted unlock where supported, an offline recovery key, Btrfs checksums, subvolumes, quotas, and read-only snapshots.

Alternatives considered were unencrypted data volumes, ext4 or XFS for the authoritative data plane, ZFS, and a custom physical filesystem. Unencrypted storage conflicts with the security baseline. ext4 and XFS do not provide the same integrated snapshot and subvolume model. ZFS adds licensing, packaging, and operational complexity. A custom filesystem is explicitly out of scope for v1.

## Decision

Use LUKS2 for encryption of authoritative mutable data and Btrfs inside that encrypted volume for checksummed, quota-aware, snapshotting storage. Keep the OS root immutable and separate from user, system, and app data.

## Consequences

The platform can support encrypted recovery, app-specific subvolumes, platform-controlled read-only snapshots, backup flows, and disk-full emergency handling without inventing a storage stack. The trade-off is that storage tooling must handle Btrfs behavior carefully, including quota management, snapshot retention, health reporting, and recovery-key workflows.
