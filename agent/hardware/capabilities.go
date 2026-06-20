package hardware

import (
	"bufio"
	"context"
	"fmt"
	"strconv"
	"strings"
)

type Capabilities struct {
	CPU             CPUCapabilities            `json:"cpu"`
	Memory          MemoryCapabilities         `json:"memory"`
	Storage         []StorageDevice            `json:"storage"`
	Networking      NetworkingCapabilities     `json:"networking"`
	TPM             TPMCapabilities            `json:"tpm"`
	Virtualization  VirtualizationCapabilities `json:"virtualization"`
	Accelerators    []AcceleratorCapability    `json:"accelerators"`
	DetectedDevices []DetectedDevice           `json:"detectedDevices,omitempty"`
}

type CPUCapabilities struct {
	Arch  string `json:"arch"`
	Cores int    `json:"cores"`
	Model string `json:"model"`
}

type MemoryCapabilities struct {
	TotalMiB uint64 `json:"totalMiB"`
}

type StorageDevice struct {
	Name       string `json:"name"`
	SizeMiB    uint64 `json:"sizeMiB"`
	Rotational bool   `json:"rotational"`
	NVMe       bool   `json:"nvme"`
}

type NetworkInterface struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

type NetworkingCapabilities struct {
	Interfaces []NetworkInterface `json:"interfaces"`
}

type TPMCapabilities struct {
	Present bool   `json:"present"`
	Version string `json:"version,omitempty"`
}

type VirtualizationCapabilities struct {
	Hardware bool `json:"hardware"`
}

type AcceleratorKind string

const (
	AcceleratorNVIDIACUDA AcceleratorKind = "nvidia.cuda"
	AcceleratorIntelNPU   AcceleratorKind = "intel.npu"
	AcceleratorAMDNPU     AcceleratorKind = "amd.npu"
	AcceleratorAMDRocm    AcceleratorKind = "amd.rocm"
	AcceleratorIntelGPU   AcceleratorKind = "intel.gpu"
	AcceleratorCPU        AcceleratorKind = "cpu"
)

type AcceleratorCapability struct {
	Kind         AcceleratorKind `json:"kind"`
	MemoryGB     uint64          `json:"memoryGB,omitempty"`
	Compute      string          `json:"compute,omitempty"`
	Generation   string          `json:"generation,omitempty"`
	MemoryModel  string          `json:"memoryModel,omitempty"`
	Architecture string          `json:"architecture,omitempty"`
}

type Accelerator = AcceleratorCapability

type DetectedDevice struct {
	Class    string `json:"class"`
	VendorID string `json:"vendorID"`
	DeviceID string `json:"deviceID"`
}

type Discoverer interface {
	Discover(context.Context) (Capabilities, error)
}

type UnsupportedPlatformError struct {
	GOOS string
}

func (e *UnsupportedPlatformError) Error() string {
	if e.GOOS == "" {
		return "hardware discovery unsupported on this platform"
	}
	return fmt.Sprintf("hardware discovery unsupported on %s", e.GOOS)
}

type DiscoveryError struct {
	Source string
	Err    error
}

func (e *DiscoveryError) Error() string {
	if e.Source == "" {
		return fmt.Sprintf("hardware discovery failed: %v", e.Err)
	}
	return fmt.Sprintf("hardware discovery failed reading %s: %v", e.Source, e.Err)
}

func (e *DiscoveryError) Unwrap() error {
	return e.Err
}

type ParseError struct {
	Source string
	Reason string
}

func (e *ParseError) Error() string {
	if e.Source == "" {
		return fmt.Sprintf("parse hardware capability input: %s", e.Reason)
	}
	return fmt.Sprintf("parse %s: %s", e.Source, e.Reason)
}

func normalizeArchitecture(goarch string) string {
	switch goarch {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "arm64"
	default:
		return goarch
	}
}

func cpuAccelerator(arch string) AcceleratorCapability {
	return AcceleratorCapability{
		Kind:         AcceleratorCPU,
		Architecture: arch,
	}
}

func parseCPUInfo(content string, goarch string) (CPUCapabilities, bool, error) {
	source := "/proc/cpuinfo"
	if strings.TrimSpace(content) == "" {
		return CPUCapabilities{}, false, &ParseError{Source: source, Reason: "empty content"}
	}

	arch := normalizeArchitecture(goarch)
	if arch == "" {
		return CPUCapabilities{}, false, &ParseError{Source: source, Reason: "empty architecture"}
	}

	cores := 0
	model := ""
	hardwareVirtualization := false

	scanner := bufio.NewScanner(strings.NewReader(content))
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}

		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		normalizedValue := strings.TrimSpace(value)
		if normalizedValue == "" {
			continue
		}

		switch normalizedKey {
		case "processor":
			if _, err := strconv.Atoi(normalizedValue); err == nil {
				cores++
				continue
			}
			if model == "" {
				model = normalizedValue
			}
		case "model name", "hardware", "cpu model":
			if model == "" {
				model = normalizedValue
			}
		case "model":
			if model == "" && !isUnsignedDecimal(normalizedValue) {
				model = normalizedValue
			}
		case "flags", "features":
			if hasVirtualizationFlag(normalizedValue) {
				hardwareVirtualization = true
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return CPUCapabilities{}, false, &ParseError{Source: source, Reason: err.Error()}
	}

	if cores == 0 {
		return CPUCapabilities{}, false, &ParseError{Source: source, Reason: "missing processor entries"}
	}
	if model == "" {
		return CPUCapabilities{}, false, &ParseError{Source: source, Reason: "missing CPU model"}
	}

	return CPUCapabilities{
		Arch:  arch,
		Cores: cores,
		Model: model,
	}, hardwareVirtualization, nil
}

func parseMemInfo(content string) (MemoryCapabilities, error) {
	source := "/proc/meminfo"
	if strings.TrimSpace(content) == "" {
		return MemoryCapabilities{}, &ParseError{Source: source, Reason: "empty content"}
	}

	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		key, value, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(key) != "MemTotal" {
			continue
		}

		fields := strings.Fields(value)
		if len(fields) != 2 {
			return MemoryCapabilities{}, &ParseError{Source: source, Reason: "malformed MemTotal"}
		}

		totalKiB, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil || totalKiB == 0 {
			return MemoryCapabilities{}, &ParseError{Source: source, Reason: "invalid MemTotal value"}
		}
		if strings.ToLower(fields[1]) != "kb" {
			return MemoryCapabilities{}, &ParseError{Source: source, Reason: "unsupported MemTotal unit"}
		}

		totalMiB := totalKiB / 1024
		if totalMiB == 0 {
			return MemoryCapabilities{}, &ParseError{Source: source, Reason: "MemTotal rounds to zero MiB"}
		}
		return MemoryCapabilities{TotalMiB: totalMiB}, nil
	}
	if err := scanner.Err(); err != nil {
		return MemoryCapabilities{}, &ParseError{Source: source, Reason: err.Error()}
	}

	return MemoryCapabilities{}, &ParseError{Source: source, Reason: "missing MemTotal"}
}

func hasVirtualizationFlag(value string) bool {
	for _, flag := range strings.Fields(strings.ToLower(value)) {
		switch flag {
		case "vmx", "svm", "virt":
			return true
		}
	}
	return false
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
