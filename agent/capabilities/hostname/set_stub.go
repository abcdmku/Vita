//go:build !linux

package hostname

import "runtime"

func newDefaultHost() host {
	return newUnsupportedHost(runtime.GOOS)
}
