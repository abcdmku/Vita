//go:build linux

package hardware

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverAcceleratorsReportsUndetailedPCIDevicesSeparately(t *testing.T) {
	pciDevicesPath := t.TempDir()
	fixtures := []struct {
		name   string
		vendor string
		class  string
		device string
	}{
		{name: "0000:00:01.0", vendor: "0x10de", class: "0x030000", device: "0x2684"},
		{name: "0000:00:02.0", vendor: "0x8086", class: "0x030000", device: "0x46a6"},
		{name: "0000:00:03.0", vendor: "0x1002", class: "0x030000", device: "0x744c"},
		{name: "0000:00:04.0", vendor: "0x8086", class: "0x048000", device: "0x7d1d"},
		{name: "0000:00:05.0", vendor: "0x1022", class: "0x048000", device: "0x1502"},
	}
	for _, fixture := range fixtures {
		writePCIDeviceFixture(t, pciDevicesPath, fixture.name, fixture.vendor, fixture.class, fixture.device)
	}

	partialPath := filepath.Join(pciDevicesPath, "0000:00:06.0")
	if err := os.MkdirAll(partialPath, 0o700); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	writeFixtureFile(t, filepath.Join(partialPath, "vendor"), "0x10de\n")
	writeFixtureFile(t, filepath.Join(partialPath, "class"), "0x030000\n")

	accelerators, detectedDevices, err := discoverAccelerators(context.Background(), pciDevicesPath, "x86_64")
	if err != nil {
		t.Fatalf("discoverAccelerators returned error: %v", err)
	}

	if len(accelerators) != 1 {
		t.Fatalf("accelerators = %#v, want CPU-only typed accelerator list", accelerators)
	}
	assertSDKValidAccelerator(t, accelerators[0])
	if accelerators[0].Kind != AcceleratorCPU {
		t.Fatalf("accelerators = %#v, want CPU-only typed accelerator list", accelerators)
	}

	if len(detectedDevices) != len(fixtures) {
		t.Fatalf("detectedDevices = %#v, want %d complete PCI detections", detectedDevices, len(fixtures))
	}
	for _, fixture := range fixtures {
		want := DetectedDevice{
			Class:    fixture.class,
			VendorID: fixture.vendor,
			DeviceID: fixture.device,
		}
		if !hasDetectedDevice(detectedDevices, want) {
			t.Fatalf("detectedDevices = %#v, missing %#v", detectedDevices, want)
		}
	}
}

func writePCIDeviceFixture(t *testing.T, root string, name string, vendor string, class string, device string) {
	t.Helper()

	devicePath := filepath.Join(root, name)
	if err := os.MkdirAll(devicePath, 0o700); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	writeFixtureFile(t, filepath.Join(devicePath, "vendor"), vendor+"\n")
	writeFixtureFile(t, filepath.Join(devicePath, "class"), class+"\n")
	writeFixtureFile(t, filepath.Join(devicePath, "device"), device+"\n")
}

func writeFixtureFile(t *testing.T, path string, content string) {
	t.Helper()

	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
}

func hasDetectedDevice(devices []DetectedDevice, want DetectedDevice) bool {
	for _, device := range devices {
		if device == want {
			return true
		}
	}
	return false
}
