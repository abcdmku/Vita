package storagehealth

import (
	"bufio"
	"context"
	"fmt"
	"math/bits"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/vita/agent/hardware"
)

const (
	defaultProcMounts = "/proc/mounts"
	defaultSysBlock   = "/sys/block"

	degradedUsedPercentThreshold = 90
	bytesPerMiB                  = 1024 * 1024
)

type Status string

const (
	StatusOK       Status = "ok"
	StatusDegraded Status = "degraded"
	StatusUnknown  Status = "unknown"
)

type Report struct {
	StorageHealth     []MountHealth     `json:"storageHealth"`
	HardwareInventory HardwareInventory `json:"hardwareInventory"`
}

type MountHealth struct {
	Device         string `json:"device"`
	MountPoint     string `json:"mountPoint"`
	FSType         string `json:"fsType"`
	TotalBytes     uint64 `json:"totalBytes"`
	UsedBytes      uint64 `json:"usedBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	UsedPercent    uint64 `json:"usedPercent"`
	Rotational     bool   `json:"rotational"`
	NVMe           bool   `json:"nvme"`
	ReadOnly       bool   `json:"readOnly"`
	Status         Status `json:"status"`
}

type HardwareInventory struct {
	Arch          string          `json:"arch"`
	CPUCores      int             `json:"cpuCores"`
	CPUModel      string          `json:"cpuModel"`
	MemTotalBytes uint64          `json:"memTotalBytes"`
	Disks         []DiskInventory `json:"disks"`
}

type DiskInventory struct {
	Name       string `json:"name"`
	SizeBytes  uint64 `json:"sizeBytes"`
	Rotational bool   `json:"rotational"`
	NVMe       bool   `json:"nvme"`
}

type Roots struct {
	ProcMounts string
	SysBlock   string
	Statfs     StatfsFunc
	Discoverer hardware.Discoverer
}

type StatfsFunc func(string) (FilesystemStats, error)

type FilesystemStats struct {
	Blocks          uint64
	BlocksFree      uint64
	BlocksAvailable uint64
	BlockSize       uint64
}

type mountEntry struct {
	device     string
	mountPoint string
	fsType     string
	options    string
}

type blockInfo struct {
	name            string
	rotational      bool
	rotationalKnown bool
	nvme            bool
	readOnly        bool
	readOnlyKnown   bool
}

func Collect(ctx context.Context, roots Roots) (Report, error) {
	if err := ctx.Err(); err != nil {
		return Report{}, err
	}

	roots = roots.withDefaults()

	capabilities, err := roots.Discoverer.Discover(ctx)
	if err != nil {
		return Report{}, err
	}

	mounts, err := collectMountHealth(ctx, roots)
	if err != nil {
		return Report{}, err
	}

	return Report{
		StorageHealth:     mounts,
		HardwareInventory: hardwareInventory(capabilities),
	}, nil
}

func (r Roots) withDefaults() Roots {
	if r.ProcMounts == "" {
		r.ProcMounts = defaultProcMounts
	}
	if r.SysBlock == "" {
		r.SysBlock = defaultSysBlock
	}
	if r.Statfs == nil {
		r.Statfs = defaultStatfs
	}
	if r.Discoverer == nil {
		r.Discoverer = hardware.NewDiscoverer()
	}
	return r
}

func collectMountHealth(ctx context.Context, roots Roots) ([]MountHealth, error) {
	mounts, err := readMounts(ctx, roots.ProcMounts)
	if err != nil {
		return nil, err
	}

	blocks := readBlockMetadata(ctx, roots.SysBlock)
	out := make([]MountHealth, 0, len(mounts))
	for _, mount := range mounts {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !isRelevantMount(mount) {
			continue
		}

		health := MountHealth{
			Device:     mount.device,
			MountPoint: mount.mountPoint,
			FSType:     mount.fsType,
			Status:     StatusUnknown,
		}

		stats, statErr := roots.Statfs(mount.mountPoint)
		if statErr == nil {
			if usage, ok := filesystemUsage(stats); ok {
				health.TotalBytes = usage.total
				health.UsedBytes = usage.used
				health.AvailableBytes = usage.available
				health.UsedPercent = usage.percent
				health.Status = StatusOK
			}
		}

		mountReadOnly := mountHasOption(mount.options, "ro")
		block, hasBlock := lookupBlockInfo(blocks, blockDeviceName(mount.device))
		if hasBlock {
			health.Rotational = block.rotational
			health.NVMe = block.nvme
			if block.readOnlyKnown {
				health.ReadOnly = mountReadOnly || block.readOnly
			} else {
				health.ReadOnly = mountReadOnly
			}
			if health.Status == StatusOK && !mountReadOnly && (!block.readOnlyKnown || !block.rotationalKnown) {
				health.Status = StatusUnknown
			}
		} else {
			health.NVMe = strings.HasPrefix(blockDeviceName(mount.device), "nvme")
			health.ReadOnly = mountReadOnly
			if health.Status == StatusOK && !mountReadOnly {
				health.Status = StatusUnknown
			}
		}

		if health.ReadOnly || (health.TotalBytes > 0 && health.UsedPercent >= degradedUsedPercentThreshold) {
			health.Status = StatusDegraded
		}

		out = append(out, health)
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Device != out[j].Device {
			return out[i].Device < out[j].Device
		}
		if out[i].MountPoint != out[j].MountPoint {
			return out[i].MountPoint < out[j].MountPoint
		}
		return out[i].FSType < out[j].FSType
	})
	return out, nil
}

type usageStats struct {
	total     uint64
	used      uint64
	available uint64
	percent   uint64
}

func filesystemUsage(stats FilesystemStats) (usageStats, bool) {
	if stats.BlockSize == 0 || stats.Blocks == 0 || stats.BlocksFree > stats.Blocks {
		return usageStats{}, false
	}

	total, ok := checkedMul(stats.Blocks, stats.BlockSize)
	if !ok || total == 0 {
		return usageStats{}, false
	}
	usedBlocks := stats.Blocks - stats.BlocksFree
	used, ok := checkedMul(usedBlocks, stats.BlockSize)
	if !ok {
		return usageStats{}, false
	}
	available, ok := checkedMul(stats.BlocksAvailable, stats.BlockSize)
	if !ok {
		return usageStats{}, false
	}
	if available > total {
		available = total
	}

	return usageStats{
		total:     total,
		used:      used,
		available: available,
		percent:   percent(used, total),
	}, true
}

func checkedMul(left uint64, right uint64) (uint64, bool) {
	if left == 0 || right == 0 {
		return 0, true
	}
	if left > ^uint64(0)/right {
		return 0, false
	}
	return left * right, true
}

func percent(used uint64, total uint64) uint64 {
	if total == 0 {
		return 0
	}
	if used > total {
		used = total
	}
	hi, lo := bits.Mul64(used, 100)
	q, _ := bits.Div64(hi, lo, total)
	if q > 100 {
		return 100
	}
	return q
}

func readMounts(ctx context.Context, path string) ([]mountEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read mounts %s: %w", path, err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	scanner := bufio.NewScanner(strings.NewReader(string(content)))
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	mounts := []mountEntry{}
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		mounts = append(mounts, mountEntry{
			device:     decodeMountField(fields[0]),
			mountPoint: decodeMountField(fields[1]),
			fsType:     decodeMountField(fields[2]),
			options:    fields[3],
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("parse mounts %s: %w", path, err)
	}
	return mounts, nil
}

func isRelevantMount(mount mountEntry) bool {
	if mount.device == "" || mount.mountPoint == "" || mount.fsType == "" {
		return false
	}
	if strings.HasPrefix(mount.device, "/dev/") {
		return true
	}
	return mount.mountPoint == "/"
}

func readBlockMetadata(ctx context.Context, sysBlock string) map[string]blockInfo {
	entries, err := os.ReadDir(sysBlock)
	if err != nil {
		return map[string]blockInfo{}
	}

	blocks := make(map[string]blockInfo, len(entries))
	for _, entry := range entries {
		if ctx.Err() != nil {
			return blocks
		}
		// /sys/block entries are commonly SYMLINKS (e.g. sda -> ../devices/.../sda),
		// not directories, so do NOT filter on IsDir(): that would drop every real
		// block device on Linux and a read-only device would never become degraded.
		// Mirror the hardware discoverer (discoverStorage), which reads entries
		// symlink-faithfully and lets the per-signal sysfs reads (which follow the
		// symlink) decide what is actually present.
		name := entry.Name()
		devicePath := filepath.Join(sysBlock, name)
		rotational, rotationalKnown := readKnownSysfsBool(filepath.Join(devicePath, "queue", "rotational"))
		readOnly, readOnlyKnown := readKnownSysfsBool(filepath.Join(devicePath, "ro"))
		blocks[name] = blockInfo{
			name:            name,
			rotational:      rotational,
			rotationalKnown: rotationalKnown,
			nvme:            strings.HasPrefix(name, "nvme"),
			readOnly:        readOnly,
			readOnlyKnown:   readOnlyKnown,
		}
	}
	return blocks
}

func readKnownSysfsBool(path string) (bool, bool) {
	content, err := os.ReadFile(path)
	if err != nil {
		return false, false
	}
	value := strings.TrimSpace(string(content))
	if value != "0" && value != "1" {
		return false, false
	}
	return hardware.ReadSysfsBool(path), true
}

func lookupBlockInfo(blocks map[string]blockInfo, name string) (blockInfo, bool) {
	if name == "" {
		return blockInfo{}, false
	}
	if block, ok := blocks[name]; ok {
		return block, true
	}

	names := make([]string, 0, len(blocks))
	for candidate := range blocks {
		names = append(names, candidate)
	}
	sort.Slice(names, func(i, j int) bool {
		if len(names[i]) != len(names[j]) {
			return len(names[i]) > len(names[j])
		}
		return names[i] < names[j]
	})
	for _, candidate := range names {
		if partitionBelongsToDevice(name, candidate) {
			return blocks[candidate], true
		}
	}
	return blockInfo{}, false
}

func partitionBelongsToDevice(partition string, device string) bool {
	if partition == device || !strings.HasPrefix(partition, device) {
		return false
	}
	suffix := strings.TrimPrefix(partition, device)
	if suffix == "" {
		return false
	}
	if strings.HasPrefix(device, "nvme") || strings.HasPrefix(device, "mmcblk") || strings.HasPrefix(device, "loop") || strings.HasPrefix(device, "md") {
		if !strings.HasPrefix(suffix, "p") {
			return false
		}
		suffix = strings.TrimPrefix(suffix, "p")
	}
	return isUnsignedDecimal(suffix)
}

func blockDeviceName(device string) string {
	if device == "" {
		return ""
	}
	return filepath.Base(device)
}

func mountHasOption(options string, option string) bool {
	for _, field := range strings.Split(options, ",") {
		if field == option {
			return true
		}
	}
	return false
}

func decodeMountField(value string) string {
	var out strings.Builder
	out.Grow(len(value))
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+3 < len(value) && isOctal(value[i+1]) && isOctal(value[i+2]) && isOctal(value[i+3]) {
			decoded, err := strconv.ParseUint(value[i+1:i+4], 8, 8)
			if err == nil {
				out.WriteByte(byte(decoded))
				i += 3
				continue
			}
		}
		out.WriteByte(value[i])
	}
	return out.String()
}

func hardwareInventory(capabilities hardware.Capabilities) HardwareInventory {
	disks := make([]DiskInventory, 0, len(capabilities.Storage))
	for _, disk := range capabilities.Storage {
		disks = append(disks, DiskInventory{
			Name:       disk.Name,
			SizeBytes:  disk.SizeMiB * bytesPerMiB,
			Rotational: disk.Rotational,
			NVMe:       disk.NVMe,
		})
	}
	sort.Slice(disks, func(i, j int) bool {
		return disks[i].Name < disks[j].Name
	})

	return HardwareInventory{
		Arch:          capabilities.CPU.Arch,
		CPUCores:      capabilities.CPU.Cores,
		CPUModel:      capabilities.CPU.Model,
		MemTotalBytes: capabilities.Memory.TotalMiB * bytesPerMiB,
		Disks:         disks,
	}
}

func isOctal(value byte) bool {
	return value >= '0' && value <= '7'
}

func isUnsignedDecimal(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
