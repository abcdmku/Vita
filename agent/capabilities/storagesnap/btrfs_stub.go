//go:build !linux

package storagesnap

import (
	"context"
	"runtime"
)

type unsupportedBtrfsSystem struct {
	goos string
}

func newDefaultBtrfsSystem() btrfsSystem {
	return unsupportedBtrfsSystem{goos: runtime.GOOS}
}

func newBtrfsSystemAtTopLevel(string) btrfsSystem {
	return unsupportedBtrfsSystem{goos: runtime.GOOS}
}

func (u unsupportedBtrfsSystem) err() error {
	return &UnsupportedPlatformError{GOOS: u.goos}
}

func (u unsupportedBtrfsSystem) CreateReadOnlySnapshot(context.Context, string) (SnapshotInfo, error) {
	return SnapshotInfo{}, u.err()
}

func (u unsupportedBtrfsSystem) CreateWritableSnapshotFrom(context.Context, string, string) (SnapshotInfo, error) {
	return SnapshotInfo{}, u.err()
}

func (u unsupportedBtrfsSystem) DeleteSnapshot(context.Context, string) error {
	return u.err()
}

func (u unsupportedBtrfsSystem) ListSnapshots(context.Context) ([]SnapshotInfo, error) {
	return nil, u.err()
}

func (u unsupportedBtrfsSystem) SnapshotInfo(context.Context, string) (SnapshotInfo, error) {
	return SnapshotInfo{}, u.err()
}

func (u unsupportedBtrfsSystem) SwapDataWithSnapshot(context.Context, string) error {
	return u.err()
}

func (u unsupportedBtrfsSystem) QuotaLimit(context.Context) (QuotaLimit, error) {
	return QuotaLimit{}, u.err()
}

func (u unsupportedBtrfsSystem) SetQuota(context.Context, uint64) error {
	return u.err()
}

func (u unsupportedBtrfsSystem) ClearQuota(context.Context) error {
	return u.err()
}

func (u unsupportedBtrfsSystem) VerifyQuota(context.Context, uint64) error {
	return u.err()
}
