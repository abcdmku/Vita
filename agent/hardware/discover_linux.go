//go:build linux

package hardware

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultProcCPUInfo       = "/proc/cpuinfo"
	defaultProcMemInfo       = "/proc/meminfo"
	defaultSysBlock          = "/sys/block"
	defaultSysClassNet       = "/sys/class/net"
	defaultSysClassTPM       = "/sys/class/tpm"
	defaultSysClassTPMRM     = "/sys/class/tpmrm"
	defaultSysBusPCIDevices  = "/sys/bus/pci/devices"
	blockSectorSizeBytes     = 512
	bytesPerMiB              = 1024 * 1024
	pciClassDisplayPrefix    = "0x03"
	pciClassProcessingPrefix = "0x0480"
)

type LinuxDiscoverer struct {
	CPUInfoPath       string
	MemInfoPath       string
	SysBlockPath      string
	SysClassNetPath   string
	SysClassTPMPath   string
	SysClassTPMRMPath string
	PCIDevicesPath    string
}

func NewDiscoverer() Discoverer {
	return LinuxDiscoverer{}
}

func (d LinuxDiscoverer) Discover(ctx context.Context) (Capabilities, error) {
	if err := ctx.Err(); err != nil {
		return Capabilities{}, err
	}

	d = d.withDefaults()

	cpuInfo, err := readTextFile(ctx, d.CPUInfoPath)
	if err != nil {
		return Capabilities{}, err
	}
	cpu, hardwareVirtualization, err := parseCPUInfo(cpuInfo, runtime.GOARCH)
	if err != nil {
		return Capabilities{}, err
	}

	memInfo, err := readTextFile(ctx, d.MemInfoPath)
	if err != nil {
		return Capabilities{}, err
	}
	memory, err := parseMemInfo(memInfo)
	if err != nil {
		return Capabilities{}, err
	}

	storage, err := discoverStorage(ctx, d.SysBlockPath)
	if err != nil {
		return Capabilities{}, err
	}
	network, err := discoverNetwork(ctx, d.SysClassNetPath)
	if err != nil {
		return Capabilities{}, err
	}
	tpm, err := discoverTPM(ctx, d.SysClassTPMPath, d.SysClassTPMRMPath)
	if err != nil {
		return Capabilities{}, err
	}
	accelerators, err := discoverAccelerators(ctx, d.PCIDevicesPath, cpu.Arch)
	if err != nil {
		return Capabilities{}, err
	}

	return Capabilities{
		CPU:     cpu,
		Memory:  memory,
		Storage: storage,
		Networking: NetworkingCapabilities{
			Interfaces: network,
		},
		TPM: tpm,
		Virtualization: VirtualizationCapabilities{
			Hardware: hardwareVirtualization,
		},
		Accelerators: accelerators,
	}, nil
}

func (d LinuxDiscoverer) withDefaults() LinuxDiscoverer {
	if d.CPUInfoPath == "" {
		d.CPUInfoPath = defaultProcCPUInfo
	}
	if d.MemInfoPath == "" {
		d.MemInfoPath = defaultProcMemInfo
	}
	if d.SysBlockPath == "" {
		d.SysBlockPath = defaultSysBlock
	}
	if d.SysClassNetPath == "" {
		d.SysClassNetPath = defaultSysClassNet
	}
	if d.SysClassTPMPath == "" {
		d.SysClassTPMPath = defaultSysClassTPM
	}
	if d.SysClassTPMRMPath == "" {
		d.SysClassTPMRMPath = defaultSysClassTPMRM
	}
	if d.PCIDevicesPath == "" {
		d.PCIDevicesPath = defaultSysBusPCIDevices
	}
	return d
}

func readTextFile(ctx context.Context, path string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", &DiscoveryError{Source: path, Err: err}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return string(content), nil
}

func discoverStorage(ctx context.Context, sysBlockPath string) ([]StorageDevice, error) {
	entries, err := os.ReadDir(sysBlockPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []StorageDevice{}, nil
		}
		return nil, &DiscoveryError{Source: sysBlockPath, Err: err}
	}

	devices := make([]StorageDevice, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		name := entry.Name()
		sizeMiB, ok := readBlockSizeMiB(filepath.Join(sysBlockPath, name, "size"))
		if !ok {
			continue
		}

		devices = append(devices, StorageDevice{
			Name:       name,
			SizeMiB:    sizeMiB,
			Rotational: readSysfsBool(filepath.Join(sysBlockPath, name, "queue", "rotational")),
			NVMe:       strings.HasPrefix(name, "nvme"),
		})
	}

	sort.Slice(devices, func(i, j int) bool {
		return devices[i].Name < devices[j].Name
	})
	return devices, nil
}

func discoverNetwork(ctx context.Context, sysClassNetPath string) ([]NetworkInterface, error) {
	entries, err := os.ReadDir(sysClassNetPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []NetworkInterface{}, nil
		}
		return nil, &DiscoveryError{Source: sysClassNetPath, Err: err}
	}

	interfaces := make([]NetworkInterface, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		name := entry.Name()
		interfaces = append(interfaces, NetworkInterface{
			Name: name,
			Kind: detectNetworkKind(sysClassNetPath, name),
		})
	}

	sort.Slice(interfaces, func(i, j int) bool {
		return interfaces[i].Name < interfaces[j].Name
	})
	return interfaces, nil
}

func discoverTPM(ctx context.Context, sysClassTPMPath string, sysClassTPMRMPath string) (TPMCapabilities, error) {
	if err := ctx.Err(); err != nil {
		return TPMCapabilities{}, err
	}

	tpmEntries, err := os.ReadDir(sysClassTPMPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return TPMCapabilities{}, &DiscoveryError{Source: sysClassTPMPath, Err: err}
	}
	for _, entry := range tpmEntries {
		if err := ctx.Err(); err != nil {
			return TPMCapabilities{}, err
		}
		if !strings.HasPrefix(entry.Name(), "tpm") {
			continue
		}

		version := readTPMVersion(filepath.Join(sysClassTPMPath, entry.Name(), "tpm_version_major"))
		return TPMCapabilities{
			Present: true,
			Version: version,
		}, nil
	}

	tpmRMEntries, err := os.ReadDir(sysClassTPMRMPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return TPMCapabilities{Present: false}, nil
		}
		return TPMCapabilities{}, &DiscoveryError{Source: sysClassTPMRMPath, Err: err}
	}
	for _, entry := range tpmRMEntries {
		if strings.HasPrefix(entry.Name(), "tpmrm") {
			return TPMCapabilities{Present: true, Version: "2.0"}, nil
		}
	}

	return TPMCapabilities{Present: false}, nil
}

func discoverAccelerators(ctx context.Context, pciDevicesPath string, arch string) ([]Accelerator, error) {
	entries, err := os.ReadDir(pciDevicesPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Accelerator{cpuAccelerator(arch)}, nil
		}
		return nil, &DiscoveryError{Source: pciDevicesPath, Err: err}
	}

	detected := map[AcceleratorKind]bool{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		devicePath := filepath.Join(pciDevicesPath, entry.Name())
		vendor := readTrimmedLower(filepath.Join(devicePath, "vendor"))
		class := readTrimmedLower(filepath.Join(devicePath, "class"))
		if vendor == "" || class == "" {
			continue
		}

		switch {
		case strings.HasPrefix(class, pciClassDisplayPrefix) && vendor == "0x10de":
			detected[AcceleratorNVIDIACUDA] = true
		case strings.HasPrefix(class, pciClassDisplayPrefix) && vendor == "0x1002":
			detected[AcceleratorAMDRocm] = true
		case strings.HasPrefix(class, pciClassDisplayPrefix) && vendor == "0x8086":
			detected[AcceleratorIntelGPU] = true
		case strings.HasPrefix(class, pciClassProcessingPrefix) && vendor == "0x8086":
			detected[AcceleratorIntelNPU] = true
		case strings.HasPrefix(class, pciClassProcessingPrefix) && vendor == "0x1022":
			detected[AcceleratorAMDNPU] = true
		}
	}

	accelerators := make([]Accelerator, 0, len(detected)+1)
	for _, kind := range []AcceleratorKind{
		AcceleratorNVIDIACUDA,
		AcceleratorIntelNPU,
		AcceleratorAMDNPU,
		AcceleratorAMDRocm,
		AcceleratorIntelGPU,
	} {
		if !detected[kind] {
			continue
		}
		accelerators = append(accelerators, acceleratorForKind(kind))
	}
	accelerators = append(accelerators, cpuAccelerator(arch))
	return accelerators, nil
}

func readBlockSizeMiB(sizePath string) (uint64, bool) {
	raw := readTrimmed(sizePath)
	if raw == "" {
		return 0, false
	}

	sectors, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || sectors == 0 {
		return 0, false
	}

	return sectors * blockSectorSizeBytes / bytesPerMiB, true
}

func readSysfsBool(path string) bool {
	return readTrimmed(path) == "1"
}

func readTrimmedLower(path string) string {
	return strings.ToLower(readTrimmed(path))
}

func readTrimmed(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(content))
}

func detectNetworkKind(sysClassNetPath string, name string) string {
	interfacePath := filepath.Join(sysClassNetPath, name)
	if _, err := os.Stat(filepath.Join(interfacePath, "wireless")); err == nil {
		return "wifi"
	}
	if _, err := os.Stat(filepath.Join(interfacePath, "phy80211")); err == nil {
		return "wifi"
	}

	switch readTrimmed(filepath.Join(interfacePath, "type")) {
	case "772":
		return "loopback"
	case "1":
		if strings.HasPrefix(name, "wl") {
			return "wifi"
		}
		return "ethernet"
	case "32":
		return "infiniband"
	}

	if strings.HasPrefix(name, "br") {
		return "bridge"
	}
	if strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") {
		return "virtual"
	}
	return "other"
}

func readTPMVersion(versionPath string) string {
	switch readTrimmed(versionPath) {
	case "2":
		return "2.0"
	case "1":
		return "1.2"
	default:
		return ""
	}
}

func acceleratorForKind(kind AcceleratorKind) Accelerator {
	accelerator := Accelerator{Kind: kind}
	if kind == AcceleratorIntelGPU {
		accelerator.MemoryModel = "shared"
	}
	return accelerator
}
