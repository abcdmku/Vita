//go:build !linux

package nodetime

import "runtime"

func newDefaultClock() clock {
	return newUnsupportedClock(runtime.GOOS)
}
