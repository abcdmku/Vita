//go:build !linux

package transport

import (
	"errors"
	"net"
)

func readUnixPeerInfo(net.Conn) (unixPeerInfo, error) {
	return unixPeerInfo{}, errors.New("unix peer auth is only implemented on linux")
}
