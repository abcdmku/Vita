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
	roots linuxDiscoveryRoots
}

type linuxDiscoveryRoots struct {
	procCPUInfo   string
	procMemInfo   string
	sysBlock      string
	sysClassNet   string
	sysClassTPM   string
	sysClassTPMRM string
	pciDevices    string
}

func NewDiscoverer() Discoverer {
	return LinuxDiscoverer{roots: defaultLinuxDiscoveryRoots()}
}

func (d LinuxDiscoverer) Discover(ctx context.Context) (Capabilities, error) {
	if err := ctx.Err(); err != nil {
		return Capabilities{}, err
	}

	roots := d.roots.withDefaults()

	cpuInfo, err := readTextFile(ctx, roots.procCPUInfo)
	if err != nil {
		return Capabilities{}, err
	}
	cpu, hardwareVirtualization, err := parseCPUInfo(cpuInfo, runtime.GOARCH)
	if err != nil {
		return Capabilities{}, err
	}

	memInfo, err := readTextFile(ctx, roots.procMemInfo)
	if err != nil {
		return Capabilities{}, err
	}
	memory, err := parseMemInfo(memInfo)
	if err != nil {
		return Capabilities{}, err
	}

	storage, err := discoverStorage(ctx, roots.sysBlock)
	if err != nil {
		return Capabilities{}, err
	}
	network, err := discoverNetwork(ctx, roots.sysClassNet)
	if err != nil {
		return Capabilities{}, err
	}
	tpm, err := discoverTPM(ctx, roots.sysClassTPM, roots.sysClassTPMRM)
	if err != nil {
		return Capabilities{}, err
	}
	accelerators, detectedDevices, err := discoverAccelerators(ctx, roots.pciDevices, cpu.Arch)
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
		Accelerators:    accelerators,
		DetectedDevices: detectedDevices,
	}, nil
}

func newLinuxDiscovererForTest(roots linuxDiscoveryRoots) LinuxDiscoverer {
	return LinuxDiscoverer{roots: roots.withDefaults()}
}

func defaultLinuxDiscoveryRoots() linuxDiscoveryRoots {
	return linuxDiscoveryRoots{
		procCPUInfo:   defaultProcCPUInfo,
		procMemInfo:   defaultProcMemInfo,
		sysBlock:      defaultSysBlock,
		sysClassNet:   defaultSysClassNet,
		sysClassTPM:   defaultSysClassTPM,
		sysClassTPMRM: defaultSysClassTPMRM,
		pciDevices:    defaultSysBusPCIDevices,
	}
}

func (r linuxDiscoveryRoots) withDefaults() linuxDiscoveryRoots {
	defaults := defaultLinuxDiscoveryRoots()
	if r.procCPUInfo == "" {
		r.procCPUInfo = defaults.procCPUInfo
	}
	if r.procMemInfo == "" {
		r.procMemInfo = defaults.procMemInfo
	}
	if r.sysBlock == "" {
		r.sysBlock = defaults.sysBlock
	}
	if r.sysClassNet == "" {
		r.sysClassNet = defaults.sysClassNet
	}
	if r.sysClassTPM == "" {
		r.sysClassTPM = defaults.sysClassTPM
	}
	if r.sysClassTPMRM == "" {
		r.sysClassTPMRM = defaults.sysClassTPMRM
	}
	if r.pciDevices == "" {
		r.pciDevices = defaults.pciDevices
	}
	return r
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

func discoverAccelerators(ctx context.Context, pciDevicesPath string, arch string) ([]AcceleratorCapability, []DetectedDevice, error) {
	entries, err := os.ReadDir(pciDevicesPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []AcceleratorCapability{cpuAccelerator(arch)}, []DetectedDevice{}, nil
		}
		return nil, nil, &DiscoveryError{Source: pciDevicesPath, Err: err}
	}

	detectedDevices := make([]DetectedDevice, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}

		devicePath := filepath.Join(pciDevicesPath, entry.Name())
		vendor := readTrimmedLower(filepath.Join(devicePath, "vendor"))
		class := readTrimmedLower(filepath.Join(devicePath, "class"))
		device := readTrimmedLower(filepath.Join(devicePath, "device"))
		if vendor == "" || class == "" || device == "" {
			continue
		}

		if isAcceleratorPCIDevice(vendor, class) {
			detectedDevices = append(detectedDevices, DetectedDevice{
				Class:    class,
				VendorID: vendor,
				DeviceID: device,
			})
		}
	}

	sort.Slice(detectedDevices, func(i, j int) bool {
		if detectedDevices[i].Class != detectedDevices[j].Class {
			return detectedDevices[i].Class < detectedDevices[j].Class
		}
		if detectedDevices[i].VendorID != detectedDevices[j].VendorID {
			return detectedDevices[i].VendorID < detectedDevices[j].VendorID
		}
		return detectedDevices[i].DeviceID < detectedDevices[j].DeviceID
	})

	return []AcceleratorCapability{cpuAccelerator(arch)}, detectedDevices, nil
}

func isAcceleratorPCIDevice(vendor string, class string) bool {
	switch {
	case strings.HasPrefix(class, pciClassDisplayPrefix):
		return vendor == "0x10de" || vendor == "0x1002" || vendor == "0x8086"
	case strings.HasPrefix(class, pciClassProcessingPrefix):
		return vendor == "0x8086" || vendor == "0x1022"
	default:
		return false
	}
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

func ReadSysfsBool(path string) bool {
	return readSysfsBool(path)
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
