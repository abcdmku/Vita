//go:build linux

package storagehealth

import (
	"golang.org/x/sys/unix"
)

func defaultStatfs(path string) (FilesystemStats, error) {
	var stats unix.Statfs_t
	if err := unix.Statfs(path, &stats); err != nil {
		return FilesystemStats{}, err
	}

	blockSize := uint64(0)
	if stats.Frsize > 0 {
		blockSize = uint64(stats.Frsize)
	}
	if blockSize == 0 && stats.Bsize > 0 {
		blockSize = uint64(stats.Bsize)
	}

	return FilesystemStats{
		Blocks:          stats.Blocks,
		BlocksFree:      stats.Bfree,
		BlocksAvailable: stats.Bavail,
		BlockSize:       blockSize,
	}, nil
}
