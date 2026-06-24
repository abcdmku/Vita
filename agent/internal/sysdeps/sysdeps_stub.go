//go:build !linux

package sysdeps

// SetRealtimeClock is unsupported off Linux.
func SetRealtimeClock(sec, nsec int64) error { return ErrUnsupported }

// RealtimeClock is unsupported off Linux.
func RealtimeClock() (sec, nsec int64, err error) { return 0, 0, ErrUnsupported }

// SetHostname is unsupported off Linux.
func SetHostname(name string) error { return ErrUnsupported }

// UnshareNetworkNamespace is unsupported off Linux.
func UnshareNetworkNamespace() error { return ErrUnsupported }

// SetNetworkNamespace is unsupported off Linux.
func SetNetworkNamespace(fd int) error { return ErrUnsupported }

// BindMount is unsupported off Linux.
func BindMount(source string, target string) error { return ErrUnsupported }

// EnsureSharedBindMount is unsupported off Linux.
func EnsureSharedBindMount(target string) error { return ErrUnsupported }

// UnmountDetach is unsupported off Linux.
func UnmountDetach(target string) error { return ErrUnsupported }

// SetLoopbackUp is unsupported off Linux.
func SetLoopbackUp() error { return ErrUnsupported }

// SetLinkUp is unsupported off Linux.
func SetLinkUp(name string) error { return ErrUnsupported }

// CreateVeth is unsupported off Linux.
func CreateVeth(hostName string, peerName string) error { return ErrUnsupported }

// DeleteLink is unsupported off Linux.
func DeleteLink(name string) error { return ErrUnsupported }

// MoveLinkToNetns is unsupported off Linux.
func MoveLinkToNetns(name string, netnsFD int) error { return ErrUnsupported }

// AddIPv4Address is unsupported off Linux.
func AddIPv4Address(name string, cidr string) error { return ErrUnsupported }

// AddIPAddress is unsupported off Linux.
func AddIPAddress(name string, cidr string) error { return ErrUnsupported }

// AddDefaultIPv4Route is unsupported off Linux.
func AddDefaultIPv4Route(name string, gateway string) error { return ErrUnsupported }

// CreateWireGuardLink is unsupported off Linux.
func CreateWireGuardLink(name string) error { return ErrUnsupported }

// SetWireGuardPrivateKey is unsupported off Linux.
func SetWireGuardPrivateKey(name string, privateKey []byte, listenPort int) error {
	return ErrUnsupported
}

// AddWireGuardPeer is unsupported off Linux.
func AddWireGuardPeer(name string, peer WireGuardPeer) error { return ErrUnsupported }

// SetWireGuardPeerAllowedIPs is unsupported off Linux.
func SetWireGuardPeerAllowedIPs(name string, publicKey []byte, allowedIPs []string) error {
	return ErrUnsupported
}

// ReplaceWireGuardPeers is unsupported off Linux.
func ReplaceWireGuardPeers(name string, peers []WireGuardPeer) error { return ErrUnsupported }

// WireGuardDevice is unsupported off Linux.
func WireGuardDevice(name string) (WireGuardDeviceStatus, error) {
	return WireGuardDeviceStatus{}, ErrUnsupported
}

// ApplyNftRuleset is unsupported off Linux.
func ApplyNftRuleset(ruleset []byte) error { return ErrUnsupported }

// ListNftTable is unsupported off Linux.
func ListNftTable(family string, table string) ([]byte, error) { return nil, ErrUnsupported }

// DeleteNftTable is unsupported off Linux.
func DeleteNftTable(family string, table string) error { return ErrUnsupported }
