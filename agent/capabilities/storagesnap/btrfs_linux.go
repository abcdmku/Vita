//go:build linux

package storagesnap

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	defaultTopLevelMount = "/run/vita-btrfs"
	dataSubvolumeName    = "@data"
	snapshotsHomeName    = "@snapshots"
	defaultVarMount      = "/var"

	btrfsPath      = "btrfs"
	findmntPath    = "findmnt"
	mountPath      = "mount"
	mountpointPath = "mountpoint"
	fallocatePath  = "fallocate"
)

type btrfsCLI struct {
	topLevel   string
	varMount   string
	btrfs      string
	findmnt    string
	mount      string
	mountpoint string
	fallocate  string
}

func newDefaultBtrfsSystem() btrfsSystem {
	return &btrfsCLI{
		topLevel:   defaultTopLevelMount,
		varMount:   defaultVarMount,
		btrfs:      btrfsPath,
		findmnt:    findmntPath,
		mount:      mountPath,
		mountpoint: mountpointPath,
		fallocate:  fallocatePath,
	}
}

func newBtrfsSystemAtTopLevel(topLevel string) btrfsSystem {
	return &btrfsCLI{
		topLevel:   topLevel,
		varMount:   topLevel,
		btrfs:      btrfsPath,
		findmnt:    findmntPath,
		mount:      mountPath,
		mountpoint: mountpointPath,
		fallocate:  fallocatePath,
	}
}

func (b *btrfsCLI) CreateReadOnlySnapshot(ctx context.Context, name string) (SnapshotInfo, error) {
	if err := validateSnapshotLabel(name, "name"); err != nil {
		return SnapshotInfo{}, err
	}
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return SnapshotInfo{}, err
	}
	dest := b.snapshotPath(name)
	if _, err := os.Stat(dest); err == nil {
		return SnapshotInfo{}, &InvalidRequestError{Reason: "snapshot already exists"}
	} else if !errors.Is(err, os.ErrNotExist) {
		return SnapshotInfo{}, fmt.Errorf("stat snapshot %q: %w", name, err)
	}
	if _, err := b.run(ctx, b.btrfs, "subvolume", "snapshot", "-r", b.dataPath(), dest); err != nil {
		return SnapshotInfo{}, fmt.Errorf("create read-only btrfs snapshot %q: %w", name, err)
	}
	return b.SnapshotInfo(ctx, name)
}

func (b *btrfsCLI) CreateWritableSnapshotFrom(ctx context.Context, sourceName string, targetName string) (SnapshotInfo, error) {
	if err := validateSnapshotLabel(sourceName, "source name"); err != nil {
		return SnapshotInfo{}, err
	}
	if err := validateSnapshotLabel(targetName, "target name"); err != nil {
		return SnapshotInfo{}, err
	}
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return SnapshotInfo{}, err
	}
	source := b.snapshotPath(sourceName)
	target := b.snapshotPath(targetName)
	if _, err := os.Stat(target); err == nil {
		return SnapshotInfo{}, &InvalidRequestError{Reason: "rollback restore snapshot already exists"}
	} else if !errors.Is(err, os.ErrNotExist) {
		return SnapshotInfo{}, fmt.Errorf("stat rollback restore snapshot %q: %w", targetName, err)
	}
	if _, err := b.run(ctx, b.btrfs, "subvolume", "snapshot", source, target); err != nil {
		return SnapshotInfo{}, fmt.Errorf("create writable btrfs snapshot %q from %q: %w", targetName, sourceName, err)
	}
	return b.SnapshotInfo(ctx, targetName)
}

func (b *btrfsCLI) DeleteSnapshot(ctx context.Context, name string) error {
	if err := validateSnapshotLabel(name, "name"); err != nil {
		return err
	}
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return err
	}
	if _, err := b.run(ctx, b.btrfs, "subvolume", "delete", b.snapshotPath(name)); err != nil {
		return fmt.Errorf("delete btrfs snapshot %q: %w", name, err)
	}
	return nil
}

func (b *btrfsCLI) ListSnapshots(ctx context.Context) ([]SnapshotInfo, error) {
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(b.snapshotsPath())
	if err != nil {
		return nil, fmt.Errorf("read btrfs snapshots directory: %w", err)
	}
	snapshots := make([]SnapshotInfo, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if err := validateSnapshotLabel(name, "name"); err != nil {
			return nil, err
		}
		info, err := b.SnapshotInfo(ctx, name)
		if err != nil {
			return nil, err
		}
		snapshots = append(snapshots, info)
	}
	return normalizeSnapshots(snapshots), nil
}

func (b *btrfsCLI) SnapshotInfo(ctx context.Context, name string) (SnapshotInfo, error) {
	if err := validateSnapshotLabel(name, "name"); err != nil {
		return SnapshotInfo{}, err
	}
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return SnapshotInfo{}, err
	}
	path := b.snapshotPath(name)
	stat, err := os.Stat(path)
	if err != nil {
		return SnapshotInfo{}, fmt.Errorf("stat btrfs snapshot %q: %w", name, err)
	}
	if !stat.IsDir() {
		return SnapshotInfo{}, &InvalidRequestError{Reason: "snapshot is not a subvolume directory"}
	}

	info := SnapshotInfo{Name: name, CreatedAt: stat.ModTime().UTC()}
	if show, err := b.run(ctx, b.btrfs, "subvolume", "show", path); err == nil {
		info.ID = parseSubvolumeID(show)
		if created, ok := parseCreationTime(show); ok {
			info.CreatedAt = created
		}
	}
	ro, err := b.snapshotReadOnly(ctx, path)
	if err != nil {
		return SnapshotInfo{}, err
	}
	info.ReadOnly = ro
	if sizes, err := b.snapshotSizes(ctx, path); err == nil {
		info.ReferencedBytes = sizes.referenced
		info.ExclusiveBytes = sizes.exclusive
	}
	return cloneSnapshotInfo(info), nil
}

func (b *btrfsCLI) SwapDataWithSnapshot(ctx context.Context, name string) error {
	if err := validateSnapshotLabel(name, "name"); err != nil {
		return err
	}
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Renameat2(RENAME_EXCHANGE) is the rollback commit point. No fallible work
	// is performed after this call returns nil.
	if err := unix.Renameat2(unix.AT_FDCWD, b.dataPath(), unix.AT_FDCWD, b.snapshotPath(name), unix.RENAME_EXCHANGE); err != nil {
		return fmt.Errorf("exchange @data with snapshot %q: %w", name, err)
	}
	return nil
}

func (b *btrfsCLI) QuotaLimit(ctx context.Context) (QuotaLimit, error) {
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return QuotaLimit{}, err
	}
	out, err := b.run(ctx, b.btrfs, "qgroup", "show", "--raw", "-f", b.dataPath())
	if err != nil {
		return QuotaLimit{}, fmt.Errorf("read btrfs qgroup limit: %w", err)
	}
	return parseQuotaLimit(out), nil
}

func (b *btrfsCLI) SetQuota(ctx context.Context, bytes uint64) error {
	if bytes == 0 {
		return &InvalidRequestError{Reason: "quota bytes must be positive"}
	}
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return err
	}
	if _, err := b.run(ctx, b.btrfs, "qgroup", "limit", strconv.FormatUint(bytes, 10), b.dataPath()); err != nil {
		return fmt.Errorf("set btrfs qgroup limit: %w", err)
	}
	return nil
}

func (b *btrfsCLI) ClearQuota(ctx context.Context) error {
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return err
	}
	if _, err := b.run(ctx, b.btrfs, "qgroup", "limit", "none", b.dataPath()); err != nil {
		return fmt.Errorf("clear btrfs qgroup limit: %w", err)
	}
	return nil
}

func (b *btrfsCLI) VerifyQuota(ctx context.Context, bytes uint64) error {
	if bytes < 2*1024*1024 {
		return &InvalidRequestError{Reason: "quota is too small to verify safely"}
	}
	if err := b.ensureTopLevelMounted(ctx); err != nil {
		return err
	}
	probeDir, err := os.MkdirTemp(b.dataPath(), ".vita-quota-probe-")
	if err != nil {
		return fmt.Errorf("create quota probe directory: %w", err)
	}
	defer os.RemoveAll(probeDir)

	under := filepath.Join(probeDir, "under")
	if _, err := b.run(ctx, b.fallocate, "-l", "1048576", under); err != nil {
		return fmt.Errorf("under-quota write failed: %w", err)
	}

	over := filepath.Join(probeDir, "over")
	_, err = b.run(ctx, b.fallocate, "-l", strconv.FormatUint(bytes+1048576, 10), over)
	if err == nil {
		return errors.New("over-quota write unexpectedly succeeded")
	}
	return nil
}

func (b *btrfsCLI) ensureTopLevelMounted(ctx context.Context) error {
	if b == nil {
		return &InvalidRequestError{Reason: "missing btrfs cli"}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if b.isMountpoint(ctx, b.topLevel) {
		return nil
	}

	fstype, err := b.captureFindmnt(ctx, "FSTYPE")
	if err != nil {
		return err
	}
	if fstype != "btrfs" {
		return &InvalidRequestError{Reason: "/var is not mounted from btrfs"}
	}
	source, err := b.captureFindmnt(ctx, "SOURCE")
	if err != nil {
		return err
	}
	if source == "" {
		return &InvalidRequestError{Reason: "/var mount source is empty"}
	}
	if err := os.MkdirAll(b.topLevel, 0o700); err != nil {
		return fmt.Errorf("create btrfs top-level mountpoint: %w", err)
	}
	if _, err := b.run(ctx, b.mount, "-t", "btrfs", "-o", "subvolid=5,compress=zstd:1", source, b.topLevel); err != nil {
		return fmt.Errorf("mount btrfs top-level: %w", err)
	}
	return nil
}

func (b *btrfsCLI) isMountpoint(ctx context.Context, path string) bool {
	cmd := exec.CommandContext(ctx, b.mountpoint, "-q", path)
	return cmd.Run() == nil
}

func (b *btrfsCLI) captureFindmnt(ctx context.Context, field string) (string, error) {
	out, err := b.run(ctx, b.findmnt, "-n", "-o", field, "--target", b.varMount)
	if err != nil {
		return "", fmt.Errorf("find /var mount %s: %w", field, err)
	}
	return strings.TrimSpace(string(out)), nil
}

func (b *btrfsCLI) run(ctx context.Context, executable string, args ...string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %s", err, msg)
	}
	return out, nil
}

func (b *btrfsCLI) dataPath() string {
	return filepath.Join(b.topLevel, dataSubvolumeName)
}

func (b *btrfsCLI) snapshotsPath() string {
	return filepath.Join(b.topLevel, snapshotsHomeName)
}

func (b *btrfsCLI) snapshotPath(name string) string {
	return filepath.Join(b.snapshotsPath(), name)
}

type qgroupSizes struct {
	referenced uint64
	exclusive  uint64
}

func (b *btrfsCLI) snapshotReadOnly(ctx context.Context, path string) (bool, error) {
	out, err := b.run(ctx, b.btrfs, "property", "get", "-ts", path, "ro")
	if err != nil {
		return false, fmt.Errorf("read btrfs snapshot readonly property: %w", err)
	}
	return strings.Contains(strings.TrimSpace(string(out)), "ro=true"), nil
}

func (b *btrfsCLI) snapshotSizes(ctx context.Context, path string) (qgroupSizes, error) {
	out, err := b.run(ctx, b.btrfs, "qgroup", "show", "--raw", path)
	if err != nil {
		return qgroupSizes{}, err
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || strings.HasPrefix(fields[0], "-") || strings.EqualFold(fields[0], "qgroupid") {
			continue
		}
		referenced, refErr := strconv.ParseUint(fields[1], 10, 64)
		exclusive, exclErr := strconv.ParseUint(fields[2], 10, 64)
		if refErr == nil && exclErr == nil {
			return qgroupSizes{referenced: referenced, exclusive: exclusive}, nil
		}
	}
	return qgroupSizes{}, errors.New("qgroup sizes not found")
}

func parseSubvolumeID(raw []byte) uint64 {
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || key != "Subvolume ID" {
			continue
		}
		parsed, err := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
		if err == nil {
			return parsed
		}
	}
	return 0
}

func parseCreationTime(raw []byte) (time.Time, bool) {
	layouts := []string{
		"2006-01-02 15:04:05 -0700",
		"2006-01-02 15:04:05",
		time.RFC3339,
	}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || key != "Creation time" {
			continue
		}
		value = strings.TrimSpace(value)
		for _, layout := range layouts {
			parsed, err := time.Parse(layout, value)
			if err == nil {
				return parsed.UTC(), true
			}
		}
	}
	return time.Time{}, false
}

func parseQuotaLimit(raw []byte) QuotaLimit {
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || strings.EqualFold(fields[0], "qgroupid") || strings.HasPrefix(fields[0], "-") {
			continue
		}
		for _, field := range fields[3:] {
			if field == "none" || field == "---" || field == "0" {
				continue
			}
			parsed, err := strconv.ParseUint(field, 10, 64)
			if err == nil && parsed > 0 {
				return QuotaLimit{Set: true, Bytes: parsed}
			}
		}
	}
	return QuotaLimit{}
}
