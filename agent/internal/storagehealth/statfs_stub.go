//go:build !linux

package storagehealth

import "errors"

var errUnsupported = errors.New("storage health unsupported on this platform")

func defaultStatfs(string) (FilesystemStats, error) {
	return FilesystemStats{}, errUnsupported
}
