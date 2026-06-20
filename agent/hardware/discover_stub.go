//go:build !linux

package hardware

import (
	"context"
	"runtime"
)

type unsupportedDiscoverer struct{}

func NewDiscoverer() Discoverer {
	return unsupportedDiscoverer{}
}

func (unsupportedDiscoverer) Discover(context.Context) (Capabilities, error) {
	return Capabilities{}, &UnsupportedPlatformError{GOOS: runtime.GOOS}
}
