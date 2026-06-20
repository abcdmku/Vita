package hardware

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"testing"
)

func TestParseCPUInfoFromFixtures(t *testing.T) {
	tests := []struct {
		name               string
		goarch             string
		content            string
		wantCPU            CPUCapabilities
		wantVirtualization bool
	}{
		{
			name:   "x86 cpuinfo",
			goarch: "amd64",
			content: `processor	: 0
vendor_id	: GenuineIntel
cpu family	: 6
model		: 85
model name	: Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr vmx aes

processor	: 1
vendor_id	: GenuineIntel
cpu family	: 6
model		: 85
model name	: Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr vmx aes
`,
			wantCPU: CPUCapabilities{
				Arch:  "x86_64",
				Cores: 2,
				Model: "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz",
			},
			wantVirtualization: true,
		},
		{
			name:   "arm64 cpuinfo",
			goarch: "arm64",
			content: `processor	: 0
BogoMIPS	: 108.00
Features	: fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid virt
CPU implementer	: 0x41

processor	: 1
BogoMIPS	: 108.00
Features	: fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid virt
CPU implementer	: 0x41

Model		: Raspberry Pi 5 Model B Rev 1.0
`,
			wantCPU: CPUCapabilities{
				Arch:  "arm64",
				Cores: 2,
				Model: "Raspberry Pi 5 Model B Rev 1.0",
			},
			wantVirtualization: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cpu, virtualization, err := parseCPUInfo(tt.content, tt.goarch)
			if err != nil {
				t.Fatalf("parseCPUInfo returned error: %v", err)
			}
			if cpu != tt.wantCPU {
				t.Fatalf("CPU = %#v, want %#v", cpu, tt.wantCPU)
			}
			if virtualization != tt.wantVirtualization {
				t.Fatalf("virtualization = %t, want %t", virtualization, tt.wantVirtualization)
			}
		})
	}
}

func TestParseMemInfoFromFixtures(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    MemoryCapabilities
	}{
		{
			name: "one GiB",
			content: `MemTotal:        1048576 kB
MemFree:          524288 kB
`,
			want: MemoryCapabilities{TotalMiB: 1024},
		},
		{
			name: "eight GiB",
			content: `MemTotal:        8388608 kB
MemAvailable:    4194304 kB
`,
			want: MemoryCapabilities{TotalMiB: 8192},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			memory, err := parseMemInfo(tt.content)
			if err != nil {
				t.Fatalf("parseMemInfo returned error: %v", err)
			}
			if memory != tt.want {
				t.Fatalf("Memory = %#v, want %#v", memory, tt.want)
			}
		})
	}
}

func TestParseCPUInfoRejectsMalformedInput(t *testing.T) {
	tests := []struct {
		name    string
		content string
	}{
		{name: "empty", content: ""},
		{name: "missing model", content: "processor\t: 0\nflags\t: vmx\n"},
		{name: "missing processor", content: "model name\t: Example CPU\nflags\t: vmx\n"},
		{name: "only numeric model", content: "processor\t: 0\nmodel\t: 85\nflags\t: vmx\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("parseCPUInfo panicked: %v", recovered)
				}
			}()

			cpu, virtualization, err := parseCPUInfo(tt.content, "amd64")
			if err == nil {
				t.Fatalf("parseCPUInfo returned %#v, %t, nil; want error", cpu, virtualization)
			}

			var parseErr *ParseError
			if !errors.As(err, &parseErr) {
				t.Fatalf("parseCPUInfo error = %T %v, want ParseError", err, err)
			}
		})
	}
}

func TestParseMemInfoRejectsMalformedInput(t *testing.T) {
	tests := []struct {
		name    string
		content string
	}{
		{name: "empty", content: ""},
		{name: "missing MemTotal", content: "MemFree: 1024 kB\n"},
		{name: "not numeric", content: "MemTotal: nope kB\n"},
		{name: "zero", content: "MemTotal: 0 kB\n"},
		{name: "missing unit", content: "MemTotal: 1024\n"},
		{name: "unsupported unit", content: "MemTotal: 1024 bytes\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("parseMemInfo panicked: %v", recovered)
				}
			}()

			memory, err := parseMemInfo(tt.content)
			if err == nil {
				t.Fatalf("parseMemInfo returned %#v, nil; want error", memory)
			}

			var parseErr *ParseError
			if !errors.As(err, &parseErr) {
				t.Fatalf("parseMemInfo error = %T %v, want ParseError", err, err)
			}
		})
	}
}

func TestDiscoverReturnsPopulatedCapabilities(t *testing.T) {
	capabilities, err := NewDiscoverer().Discover(context.Background())
	if runtime.GOOS != "linux" {
		var unsupported *UnsupportedPlatformError
		if !errors.As(err, &unsupported) {
			t.Fatalf("Discover error = %v, want UnsupportedPlatformError", err)
		}
		return
	}

	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	if capabilities.CPU.Arch != normalizeArchitecture(runtime.GOARCH) {
		t.Fatalf("CPU.Arch = %q, want %q", capabilities.CPU.Arch, normalizeArchitecture(runtime.GOARCH))
	}
	if capabilities.CPU.Cores < 1 {
		t.Fatalf("CPU.Cores = %d, want >= 1", capabilities.CPU.Cores)
	}
	if capabilities.CPU.Model == "" {
		t.Fatal("CPU.Model is empty")
	}
	if capabilities.Memory.TotalMiB == 0 {
		t.Fatal("Memory.TotalMiB = 0, want > 0")
	}
	if !hasCPUAccelerator(capabilities.Accelerators, capabilities.CPU.Arch) {
		t.Fatalf("Accelerators = %#v, want CPU accelerator for %q", capabilities.Accelerators, capabilities.CPU.Arch)
	}
	for _, accelerator := range capabilities.Accelerators {
		assertSDKValidAccelerator(t, accelerator)
	}
	if _, err := json.Marshal(capabilities); err != nil {
		t.Fatalf("capabilities are not JSON serializable: %v", err)
	}
}

func hasCPUAccelerator(accelerators []AcceleratorCapability, arch string) bool {
	for _, accelerator := range accelerators {
		if accelerator.Kind == AcceleratorCPU && accelerator.Architecture == arch {
			return true
		}
	}
	return false
}

func assertSDKValidAccelerator(t *testing.T, accelerator AcceleratorCapability) {
	t.Helper()

	switch accelerator.Kind {
	case AcceleratorNVIDIACUDA:
		if accelerator.MemoryGB == 0 || accelerator.Compute == "" {
			t.Fatalf("CUDA accelerator missing required SDK fields: %#v", accelerator)
		}
		if accelerator.Generation != "" || accelerator.MemoryModel != "" || accelerator.Architecture != "" {
			t.Fatalf("CUDA accelerator has fields outside SDK union: %#v", accelerator)
		}
	case AcceleratorIntelNPU, AcceleratorAMDNPU:
		if accelerator.Generation == "" {
			t.Fatalf("NPU accelerator missing required SDK fields: %#v", accelerator)
		}
		if accelerator.MemoryGB != 0 || accelerator.Compute != "" || accelerator.MemoryModel != "" || accelerator.Architecture != "" {
			t.Fatalf("NPU accelerator has fields outside SDK union: %#v", accelerator)
		}
	case AcceleratorAMDRocm:
		if accelerator.MemoryGB == 0 {
			t.Fatalf("ROCm accelerator missing required SDK fields: %#v", accelerator)
		}
		if accelerator.Compute != "" || accelerator.Generation != "" || accelerator.MemoryModel != "" || accelerator.Architecture != "" {
			t.Fatalf("ROCm accelerator has fields outside SDK union: %#v", accelerator)
		}
	case AcceleratorIntelGPU:
		if accelerator.MemoryModel != "shared" && accelerator.MemoryModel != "dedicated" {
			t.Fatalf("Intel GPU accelerator missing required SDK fields: %#v", accelerator)
		}
		if accelerator.MemoryGB != 0 || accelerator.Compute != "" || accelerator.Generation != "" || accelerator.Architecture != "" {
			t.Fatalf("Intel GPU accelerator has fields outside SDK union: %#v", accelerator)
		}
	case AcceleratorCPU:
		if accelerator.Architecture != "x86_64" && accelerator.Architecture != "arm64" {
			t.Fatalf("CPU accelerator missing required SDK architecture: %#v", accelerator)
		}
		if accelerator.MemoryGB != 0 || accelerator.Compute != "" || accelerator.Generation != "" || accelerator.MemoryModel != "" {
			t.Fatalf("CPU accelerator has fields outside SDK union: %#v", accelerator)
		}
	default:
		t.Fatalf("unknown accelerator kind: %#v", accelerator)
	}
}
