package storagehealth

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/vita/agent/hardware"
)

func TestCollectReportsStorageHealthAndHardwareInventoryDeterministically(t *testing.T) {
	root := t.TempDir()
	procMounts := filepath.Join(root, "proc", "mounts")
	sysBlock := filepath.Join(root, "sys", "block")
	writeFile(t, procMounts, stringsJoinLines(
		"/dev/sdc1 /readonly ext4 rw,relatime 0 0",
		"/dev/sda1 /full ext4 rw,relatime 0 0",
		"/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
		"/dev/sdb1 /var ext4 rw,relatime 0 0",
		"/dev/sdd1 /unknown ext4 rw,relatime 0 0",
		"/dev/sde1 /staterr ext4 rw,relatime 0 0",
		"proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
	))

	writeBlockSignals(t, sysBlock, "nvme0n1", "0", "0")
	writeBlockSignals(t, sysBlock, "sda", "0", "0")
	writeBlockSignals(t, sysBlock, "sdb", "1", "0")
	writeBlockSignals(t, sysBlock, "sdc", "0", "1")
	writeFile(t, filepath.Join(sysBlock, "sdd", "queue", "rotational"), "0\n")
	writeBlockSignals(t, sysBlock, "sde", "0", "0")

	statErr := errors.New("statfs denied")
	statfs := mapStatfs{
		"/":         {stats: FilesystemStats{Blocks: 1000, BlocksFree: 700, BlocksAvailable: 650, BlockSize: 4096}},
		"/full":     {stats: FilesystemStats{Blocks: 100, BlocksFree: 5, BlocksAvailable: 5, BlockSize: 4096}},
		"/readonly": {stats: FilesystemStats{Blocks: 100, BlocksFree: 50, BlocksAvailable: 40, BlockSize: 4096}},
		"/unknown":  {stats: FilesystemStats{Blocks: 100, BlocksFree: 20, BlocksAvailable: 10, BlockSize: 4096}},
		"/var":      {stats: FilesystemStats{Blocks: 200, BlocksFree: 100, BlocksAvailable: 80, BlockSize: 1024}},
		"/staterr":  {err: statErr},
	}
	discoverer := fakeDiscoverer{capabilities: hardware.Capabilities{
		CPU:    hardware.CPUCapabilities{Arch: "x86_64", Cores: 8, Model: "fixture cpu"},
		Memory: hardware.MemoryCapabilities{TotalMiB: 32768},
		Storage: []hardware.StorageDevice{
			{Name: "sdb", SizeMiB: 2048, Rotational: true},
			{Name: "nvme0n1", SizeMiB: 4096, NVMe: true},
		},
	}}

	report, err := Collect(context.Background(), Roots{
		ProcMounts: procMounts,
		SysBlock:   sysBlock,
		Statfs:     statfs.Statfs,
		Discoverer: discoverer,
	})
	if err != nil {
		t.Fatalf("Collect returned error: %v", err)
	}
	second, err := Collect(context.Background(), Roots{
		ProcMounts: procMounts,
		SysBlock:   sysBlock,
		Statfs:     statfs.Statfs,
		Discoverer: discoverer,
	})
	if err != nil {
		t.Fatalf("second Collect returned error: %v", err)
	}

	firstJSON, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal first report: %v", err)
	}
	secondJSON, err := json.Marshal(second)
	if err != nil {
		t.Fatalf("marshal second report: %v", err)
	}
	if string(firstJSON) != string(secondJSON) {
		t.Fatalf("Collect was not deterministic:\nfirst:  %s\nsecond: %s", firstJSON, secondJSON)
	}

	wantHealth := []MountHealth{
		{
			Device:         "/dev/nvme0n1p2",
			MountPoint:     "/",
			FSType:         "ext4",
			TotalBytes:     4096000,
			UsedBytes:      1228800,
			AvailableBytes: 2662400,
			UsedPercent:    30,
			NVMe:           true,
			Status:         StatusOK,
		},
		{
			Device:         "/dev/sda1",
			MountPoint:     "/full",
			FSType:         "ext4",
			TotalBytes:     409600,
			UsedBytes:      389120,
			AvailableBytes: 20480,
			UsedPercent:    95,
			Status:         StatusDegraded,
		},
		{
			Device:         "/dev/sdb1",
			MountPoint:     "/var",
			FSType:         "ext4",
			TotalBytes:     204800,
			UsedBytes:      102400,
			AvailableBytes: 81920,
			UsedPercent:    50,
			Rotational:     true,
			Status:         StatusOK,
		},
		{
			Device:         "/dev/sdc1",
			MountPoint:     "/readonly",
			FSType:         "ext4",
			TotalBytes:     409600,
			UsedBytes:      204800,
			AvailableBytes: 163840,
			UsedPercent:    50,
			ReadOnly:       true,
			Status:         StatusDegraded,
		},
		{
			Device:         "/dev/sdd1",
			MountPoint:     "/unknown",
			FSType:         "ext4",
			TotalBytes:     409600,
			UsedBytes:      327680,
			AvailableBytes: 40960,
			UsedPercent:    80,
			Status:         StatusUnknown,
		},
		{
			Device:     "/dev/sde1",
			MountPoint: "/staterr",
			FSType:     "ext4",
			Status:     StatusUnknown,
		},
	}
	if !reflect.DeepEqual(report.StorageHealth, wantHealth) {
		t.Fatalf("storage health = %#v, want %#v", report.StorageHealth, wantHealth)
	}

	wantInventory := HardwareInventory{
		Arch:          "x86_64",
		CPUCores:      8,
		CPUModel:      "fixture cpu",
		MemTotalBytes: 34359738368,
		Disks: []DiskInventory{
			{Name: "nvme0n1", SizeBytes: 4294967296, NVMe: true},
			{Name: "sdb", SizeBytes: 2147483648, Rotational: true},
		},
	}
	if !reflect.DeepEqual(report.HardwareInventory, wantInventory) {
		t.Fatalf("hardware inventory = %#v, want %#v", report.HardwareInventory, wantInventory)
	}
}

// TestCollectMarksReadOnlySymlinkedBlockDeviceDegraded reproduces the real /sys/block
// layout, where each block device entry is a SYMLINK into /sys/devices (not a directory).
// readBlockMetadata must read those entries symlink-faithfully; if it filters to dir-only
// entries, the read-only signal is dropped and the device never becomes degraded.
func TestCollectMarksReadOnlySymlinkedBlockDeviceDegraded(t *testing.T) {
	root := t.TempDir()
	procMounts := filepath.Join(root, "proc", "mounts")
	sysBlock := filepath.Join(root, "sys", "block")
	// Real sysfs backing store lives under /sys/devices; /sys/block holds symlinks to it.
	devices := filepath.Join(root, "sys", "devices", "sdc")

	writeFile(t, procMounts, stringsJoinLines(
		"/dev/sdc1 /readonly ext4 rw,relatime 0 0",
	))

	writeFile(t, filepath.Join(devices, "queue", "rotational"), "0\n")
	writeFile(t, filepath.Join(devices, "ro"), "1\n")
	symlinkBlockDevice(t, sysBlock, "sdc", devices)

	statfs := mapStatfs{
		"/readonly": {stats: FilesystemStats{Blocks: 100, BlocksFree: 50, BlocksAvailable: 40, BlockSize: 4096}},
	}

	report, err := Collect(context.Background(), Roots{
		ProcMounts: procMounts,
		SysBlock:   sysBlock,
		Statfs:     statfs.Statfs,
		Discoverer: fakeDiscoverer{},
	})
	if err != nil {
		t.Fatalf("Collect returned error: %v", err)
	}

	if len(report.StorageHealth) != 1 {
		t.Fatalf("expected exactly one mount, got %d: %#v", len(report.StorageHealth), report.StorageHealth)
	}
	got := report.StorageHealth[0]
	if !got.ReadOnly {
		t.Fatalf("symlinked read-only block device was not detected as read-only: %#v", got)
	}
	if got.Status != StatusDegraded {
		t.Fatalf("read-only block device status = %q, want %q (symlinked /sys/block entry must still be read)", got.Status, StatusDegraded)
	}
}

func TestCollectReturnsErrorForUnreadableMountTable(t *testing.T) {
	_, err := Collect(context.Background(), Roots{
		ProcMounts: filepath.Join(t.TempDir(), "missing-mounts"),
		Statfs: func(string) (FilesystemStats, error) {
			return FilesystemStats{}, nil
		},
		Discoverer: fakeDiscoverer{},
	})
	if err == nil {
		t.Fatal("Collect returned nil error for missing mounts")
	}
}

type fakeDiscoverer struct {
	capabilities hardware.Capabilities
	err          error
}

func (d fakeDiscoverer) Discover(context.Context) (hardware.Capabilities, error) {
	if d.err != nil {
		return hardware.Capabilities{}, d.err
	}
	return d.capabilities, nil
}

type statfsResult struct {
	stats FilesystemStats
	err   error
}

type mapStatfs map[string]statfsResult

func (m mapStatfs) Statfs(path string) (FilesystemStats, error) {
	result, ok := m[path]
	if !ok {
		return FilesystemStats{}, errors.New("unexpected statfs path")
	}
	if result.err != nil {
		return FilesystemStats{}, result.err
	}
	return result.stats, nil
}

func writeBlockSignals(t *testing.T, sysBlock string, name string, rotational string, readOnly string) {
	t.Helper()

	writeFile(t, filepath.Join(sysBlock, name, "queue", "rotational"), rotational+"\n")
	writeFile(t, filepath.Join(sysBlock, name, "ro"), readOnly+"\n")
}

// symlinkBlockDevice mirrors the real /sys/block layout: the entry is a symlink that
// points at the backing device directory under /sys/devices, never a real directory.
func symlinkBlockDevice(t *testing.T, sysBlock string, name string, target string) {
	t.Helper()

	if err := os.MkdirAll(sysBlock, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", sysBlock, err)
	}
	rel, err := filepath.Rel(sysBlock, target)
	if err != nil {
		t.Fatalf("relpath %s -> %s: %v", sysBlock, target, err)
	}
	if err := os.Symlink(rel, filepath.Join(sysBlock, name)); err != nil {
		t.Skipf("symlink unsupported on this platform: %v", err)
	}
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func stringsJoinLines(lines ...string) string {
	return strings.Join(lines, "\n") + "\n"
}
