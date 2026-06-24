//go:build !linux

package hardware

import (
	"context"
	"os"
	"runtime"
	"strings"
)

type unsupportedDiscoverer struct{}

func NewDiscoverer() Discoverer {
	return unsupportedDiscoverer{}
}

func (unsupportedDiscoverer) Discover(context.Context) (Capabilities, error) {
	return Capabilities{}, &UnsupportedPlatformError{GOOS: runtime.GOOS}
}

func ReadSysfsBool(path string) bool {
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(content)) == "1"
}
