//go:build !linux

package nodeconfig

import (
	"context"
	"runtime"
)

type unsupportedFileSystem struct{}

func newDefaultFileSystem() configFileSystem {
	return unsupportedFileSystem{}
}

func (unsupportedFileSystem) Read(context.Context) (configSnapshot, error) {
	return configSnapshot{}, &UnsupportedPlatformError{GOOS: runtime.GOOS}
}

func (unsupportedFileSystem) AtomicWrite(context.Context, []byte) error {
	return &UnsupportedPlatformError{GOOS: runtime.GOOS}
}

func (unsupportedFileSystem) Replace(context.Context, configSnapshot) error {
	return &UnsupportedPlatformError{GOOS: runtime.GOOS}
}
