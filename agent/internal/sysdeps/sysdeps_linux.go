//go:build linux

package sysdeps

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	vethInfoPeer = 1
	nftPath      = "/usr/sbin/nft"

	ctrlAttrFamilyID   = 1
	ctrlAttrFamilyName = 2

	wgCmdGetDevice = 0
	wgCmdSetDevice = 1

	wgDeviceAIfindex    = 1
	wgDeviceAIfname     = 2
	wgDeviceAPrivateKey = 3
	wgDeviceAFlags      = 5
	wgDeviceAListenPort = 6
	wgDeviceAPeers      = 8

	wgPeerAPublicKey                   = 1
	wgPeerAFlags                       = 3
	wgPeerAEndpoint                    = 4
	wgPeerAPersistentKeepaliveInterval = 5
	wgPeerALastHandshakeTime           = 6
	wgPeerAAllowedIPs                  = 9

	wgAllowedIPAFamily   = 1
	wgAllowedIPAIPAddr   = 2
	wgAllowedIPACIDRMask = 3

	wgDeviceFReplacePeers           = 1 << 0
	wgPeerFReplaceAllowedIPs        = 1 << 1
	wireGuardKeyLength              = 32
	wireGuardGenericName            = "wireguard"
	wireGuardGenericVersion         = 1
	nlaTypeMask              uint16 = ^uint16(unix.NLA_F_NESTED | unix.NLA_F_NET_BYTEORDER)
)

var netlinkSeq uint32

// SetRealtimeClock sets CLOCK_REALTIME to the given Unix time (seconds + nanoseconds).
// Privileged: requires CAP_SYS_TIME.
func SetRealtimeClock(sec, nsec int64) error {
	return unix.ClockSettime(unix.CLOCK_REALTIME, &unix.Timespec{Sec: sec, Nsec: nsec})
}

// RealtimeClock reads CLOCK_REALTIME as (seconds, nanoseconds).
func RealtimeClock() (sec, nsec int64, err error) {
	var ts unix.Timespec
	if err = unix.ClockGettime(unix.CLOCK_REALTIME, &ts); err != nil {
		return 0, 0, err
	}
	return ts.Sec, ts.Nsec, nil
}

// SetHostname sets the kernel hostname. Privileged: requires CAP_SYS_ADMIN.
func SetHostname(name string) error {
	return unix.Sethostname([]byte(name))
}

// UnshareNetworkNamespace moves the current thread into a fresh network namespace.
// Privileged: requires CAP_SYS_ADMIN.
func UnshareNetworkNamespace() error {
	return unix.Unshare(unix.CLONE_NEWNET)
}

// SetNetworkNamespace moves the current thread into the network namespace
// referenced by fd. Privileged: requires CAP_SYS_ADMIN.
func SetNetworkNamespace(fd int) error {
	return unix.Setns(fd, unix.CLONE_NEWNET)
}

// BindMount bind-mounts source onto target.
// Privileged: requires CAP_SYS_ADMIN.
func BindMount(source string, target string) error {
	return unix.Mount(source, target, "none", unix.MS_BIND, "")
}

// EnsureSharedBindMount makes target a bind mount with shared propagation.
// Privileged: requires CAP_SYS_ADMIN.
func EnsureSharedBindMount(target string) error {
	mounted, shared, err := mountInfoForTarget(target)
	if err != nil {
		return err
	}
	if !mounted {
		if err := unix.Mount(target, target, "none", unix.MS_BIND, ""); err != nil {
			return err
		}
	}
	if shared {
		return nil
	}
	return unix.Mount("", target, "none", unix.MS_SHARED|unix.MS_REC, "")
}

// UnmountDetach lazily detaches a mount.
// Privileged: requires CAP_SYS_ADMIN.
func UnmountDetach(target string) error {
	return unix.Unmount(target, unix.MNT_DETACH)
}

// SetLoopbackUp marks the loopback interface up in the current network namespace.
// Privileged: requires CAP_NET_ADMIN in that namespace.
func SetLoopbackUp() error {
	return SetLinkUp("lo")
}

// SetLinkUp marks an interface up in the current network namespace.
// Privileged: requires CAP_NET_ADMIN in that namespace.
func SetLinkUp(name string) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)

	ifreq, err := unix.NewIfreq(name)
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifreq); err != nil {
		return err
	}
	ifreq.SetUint16(ifreq.Uint16() | uint16(unix.IFF_UP))
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifreq)
}

// CreateVeth creates a veth pair in the current network namespace.
// Privileged: requires CAP_NET_ADMIN in that namespace.
func CreateVeth(hostName string, peerName string) error {
	peer := append(ifInfoMsg(0, 0, 0), nlAttr(unix.IFLA_IFNAME, nulString(peerName))...)
	infoData := nlAttr(unix.IFLA_INFO_DATA|unix.NLA_F_NESTED, nlAttr(vethInfoPeer|unix.NLA_F_NESTED, peer))
	linkInfo := append(nlAttr(unix.IFLA_INFO_KIND, nulString("veth")), infoData...)
	payload := append(ifInfoMsg(0, 0, 0), nlAttr(unix.IFLA_IFNAME, nulString(hostName))...)
	payload = append(payload, nlAttr(unix.IFLA_LINKINFO|unix.NLA_F_NESTED, linkInfo)...)
	return netlinkRequest(unix.RTM_NEWLINK, unix.NLM_F_REQUEST|unix.NLM_F_ACK|unix.NLM_F_CREATE|unix.NLM_F_EXCL, payload)
}

// CreateWireGuardLink creates a WireGuard interface in the current network
// namespace. Privileged: requires CAP_NET_ADMIN in that namespace.
func CreateWireGuardLink(name string) error {
	linkInfo := nlAttr(unix.IFLA_INFO_KIND, nulString("wireguard"))
	payload := append(ifInfoMsg(0, 0, 0), nlAttr(unix.IFLA_IFNAME, nulString(name))...)
	payload = append(payload, nlAttr(unix.IFLA_LINKINFO|unix.NLA_F_NESTED, linkInfo)...)
	return netlinkRequest(unix.RTM_NEWLINK, unix.NLM_F_REQUEST|unix.NLM_F_ACK|unix.NLM_F_CREATE|unix.NLM_F_EXCL, payload)
}

// DeleteLink deletes an interface from the current network namespace.
// Privileged: requires CAP_NET_ADMIN in that namespace.
func DeleteLink(name string) error {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return err
	}
	return netlinkRequest(unix.RTM_DELLINK, unix.NLM_F_REQUEST|unix.NLM_F_ACK, ifInfoMsg(int32(iface.Index), 0, 0))
}

// MoveLinkToNetns moves an interface into the network namespace referenced by fd.
// Privileged: requires CAP_NET_ADMIN in the source namespace.
func MoveLinkToNetns(name string, netnsFD int) error {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return err
	}
	payload := append(ifInfoMsg(int32(iface.Index), 0, 0), nlAttrInt32(unix.IFLA_NET_NS_FD, int32(netnsFD))...)
	return netlinkRequest(unix.RTM_NEWLINK, unix.NLM_F_REQUEST|unix.NLM_F_ACK, payload)
}

// AddIPv4Address assigns an IPv4 CIDR address to an interface in the current
// network namespace.
// Privileged: requires CAP_NET_ADMIN in that namespace.
func AddIPv4Address(name string, cidr string) error {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil {
		return err
	}
	if !prefix.Addr().Is4() {
		return fmt.Errorf("address must be IPv4")
	}
	return addIPAddressPrefix(name, prefix)
}

// AddIPAddress assigns an IPv4 or IPv6 CIDR address to an interface in the
// current network namespace.
// Privileged: requires CAP_NET_ADMIN in that namespace.
func AddIPAddress(name string, cidr string) error {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil {
		return err
	}
	return addIPAddressPrefix(name, prefix)
}

func addIPAddressPrefix(name string, prefix netip.Prefix) error {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return err
	}
	addr := prefix.Addr()
	var family uint8
	var addrBytes []byte
	if addr.Is4() {
		v4 := addr.As4()
		family = unix.AF_INET
		addrBytes = v4[:]
	} else if addr.Is6() {
		v6 := addr.As16()
		family = unix.AF_INET6
		addrBytes = v6[:]
	} else {
		return fmt.Errorf("address must be IPv4 or IPv6")
	}
	payload := ifAddrMsg(family, uint8(prefix.Bits()), uint32(iface.Index), unix.RT_SCOPE_UNIVERSE)
	payload = append(payload, nlAttr(unix.IFA_LOCAL, addrBytes)...)
	payload = append(payload, nlAttr(unix.IFA_ADDRESS, addrBytes)...)
	return netlinkRequest(unix.RTM_NEWADDR, unix.NLM_F_REQUEST|unix.NLM_F_ACK|unix.NLM_F_CREATE|unix.NLM_F_EXCL, payload)
}

// AddDefaultIPv4Route adds a default IPv4 route via gateway and output interface
// in the current network namespace.
// Privileged: requires CAP_NET_ADMIN in that namespace.
func AddDefaultIPv4Route(name string, gateway string) error {
	addr, err := netip.ParseAddr(gateway)
	if err != nil {
		return err
	}
	if !addr.Is4() {
		return fmt.Errorf("gateway must be IPv4")
	}
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return err
	}
	gatewayBytes := addr.As4()
	payload := rtMsg(unix.AF_INET, 0, unix.RT_TABLE_MAIN, unix.RTPROT_STATIC, unix.RT_SCOPE_UNIVERSE, unix.RTN_UNICAST)
	payload = append(payload, nlAttr(unix.RTA_GATEWAY, gatewayBytes[:])...)
	payload = append(payload, nlAttrInt32(unix.RTA_OIF, int32(iface.Index))...)
	return netlinkRequest(unix.RTM_NEWROUTE, unix.NLM_F_REQUEST|unix.NLM_F_ACK|unix.NLM_F_CREATE|unix.NLM_F_EXCL, payload)
}

// SetWireGuardPrivateKey sets a WireGuard private key and listen port via the
// kernel WireGuard generic netlink family. The private key is raw 32-byte key
// material and is never logged here.
func SetWireGuardPrivateKey(name string, privateKey []byte, listenPort int) error {
	if len(privateKey) != wireGuardKeyLength {
		return fmt.Errorf("wireguard private key must be 32 bytes")
	}
	if listenPort <= 0 || listenPort > 65535 {
		return fmt.Errorf("wireguard listen port must be 1-65535")
	}
	attrs := nlAttr(wgDeviceAIfname, nulString(name))
	attrs = append(attrs, nlAttr(wgDeviceAPrivateKey, privateKey)...)
	attrs = append(attrs, nlAttrUint16(wgDeviceAListenPort, uint16(listenPort))...)
	return setWireGuardDevice(attrs)
}

// AddWireGuardPeer adds or updates a single WireGuard peer without replacing
// the full peer set. Callers that need an exact peer set should use
// ReplaceWireGuardPeers.
func AddWireGuardPeer(name string, peer WireGuardPeer) error {
	peerAttrs, err := wireGuardPeerAttr(peer)
	if err != nil {
		return err
	}
	attrs := nlAttr(wgDeviceAIfname, nulString(name))
	attrs = append(attrs, nlAttr(wgDeviceAPeers|unix.NLA_F_NESTED, nlAttr(0|unix.NLA_F_NESTED, peerAttrs))...)
	return setWireGuardDevice(attrs)
}

// SetWireGuardPeerAllowedIPs replaces a peer's allowed-IP set.
func SetWireGuardPeerAllowedIPs(name string, publicKey []byte, allowedIPs []string) error {
	return AddWireGuardPeer(name, WireGuardPeer{PublicKey: publicKey, AllowedIPs: allowedIPs})
}

// ReplaceWireGuardPeers replaces the full WireGuard peer set.
func ReplaceWireGuardPeers(name string, peers []WireGuardPeer) error {
	attrs := nlAttr(wgDeviceAIfname, nulString(name))
	attrs = append(attrs, nlAttrUint32(wgDeviceAFlags, wgDeviceFReplacePeers)...)
	peerItems := make([]byte, 0)
	for i, peer := range peers {
		peerAttrs, err := wireGuardPeerAttr(peer)
		if err != nil {
			return err
		}
		peerItems = append(peerItems, nlAttr(uint16(i)|unix.NLA_F_NESTED, peerAttrs)...)
	}
	attrs = append(attrs, nlAttr(wgDeviceAPeers|unix.NLA_F_NESTED, peerItems)...)
	return setWireGuardDevice(attrs)
}

func setWireGuardDevice(attrs []byte) error {
	family, err := wireGuardFamilyID()
	if err != nil {
		return err
	}
	payload := append(genlHeader(wgCmdSetDevice, wireGuardGenericVersion), attrs...)
	_, err = genericNetlinkRequest(family, unix.NLM_F_REQUEST|unix.NLM_F_ACK, payload)
	return err
}

// WireGuardDevice reads a WireGuard device via the kernel generic netlink
// family and returns only the peer state required by callers.
func WireGuardDevice(name string) (WireGuardDeviceStatus, error) {
	family, err := wireGuardFamilyID()
	if err != nil {
		return WireGuardDeviceStatus{}, err
	}
	payload := append(genlHeader(wgCmdGetDevice, wireGuardGenericVersion), nlAttr(wgDeviceAIfname, nulString(name))...)
	responses, err := genericNetlinkRequest(family, unix.NLM_F_REQUEST|unix.NLM_F_DUMP, payload)
	if err != nil {
		return WireGuardDeviceStatus{}, err
	}
	for _, response := range responses {
		if len(response) < unix.GENL_HDRLEN {
			continue
		}
		device, err := parseWireGuardDevice(response[unix.GENL_HDRLEN:])
		if err != nil {
			return WireGuardDeviceStatus{}, err
		}
		if device.Name == name {
			return device, nil
		}
	}
	return WireGuardDeviceStatus{}, os.ErrNotExist
}

// ApplyNftRuleset atomically asks nftables to load an agent-generated ruleset
// from stdin. Callers must build the bytes from validated typed inputs only.
func ApplyNftRuleset(ruleset []byte) error {
	cmd := exec.Command(nftPath, "-f", "-")
	cmd.Stdin = bytes.NewReader(ruleset)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("nft apply: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// ListNftTable returns nft's textual table rendering for a table identifier.
func ListNftTable(family string, table string) ([]byte, error) {
	output, err := exec.Command(nftPath, "list", "table", family, table).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("nft list table: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

// DeleteNftTable removes a table identifier from nftables.
func DeleteNftTable(family string, table string) error {
	output, err := exec.Command(nftPath, "delete", "table", family, table).CombinedOutput()
	if err != nil {
		return fmt.Errorf("nft delete table: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func wireGuardFamilyID() (uint16, error) {
	payload := append(genlHeader(unix.CTRL_CMD_GETFAMILY, 1), nlAttr(ctrlAttrFamilyName, nulString(wireGuardGenericName))...)
	responses, err := genericNetlinkRequest(unix.GENL_ID_CTRL, unix.NLM_F_REQUEST, payload)
	if err != nil {
		return 0, err
	}
	for _, response := range responses {
		if len(response) < unix.GENL_HDRLEN {
			continue
		}
		attrs, err := parseNetlinkAttrs(response[unix.GENL_HDRLEN:])
		if err != nil {
			return 0, err
		}
		if familyID := firstAttr(attrs, ctrlAttrFamilyID); len(familyID) >= 2 {
			return binary.LittleEndian.Uint16(familyID[:2]), nil
		}
	}
	return 0, os.ErrNotExist
}

func wireGuardPeerAttr(peer WireGuardPeer) ([]byte, error) {
	if len(peer.PublicKey) != wireGuardKeyLength {
		return nil, fmt.Errorf("wireguard public key must be 32 bytes")
	}
	attrs := nlAttr(wgPeerAPublicKey, peer.PublicKey)
	attrs = append(attrs, nlAttrUint32(wgPeerAFlags, wgPeerFReplaceAllowedIPs)...)
	if peer.Endpoint != "" {
		endpoint, err := wireGuardEndpointBytes(peer.Endpoint)
		if err != nil {
			return nil, err
		}
		attrs = append(attrs, nlAttr(wgPeerAEndpoint, endpoint)...)
	}
	if peer.PersistentKeepalive != nil {
		value := *peer.PersistentKeepalive
		if value <= 0 || value > 65535 {
			return nil, fmt.Errorf("wireguard persistent keepalive must be 1-65535")
		}
		attrs = append(attrs, nlAttrUint16(wgPeerAPersistentKeepaliveInterval, uint16(value))...)
	}

	allowedItems := make([]byte, 0)
	for i, allowed := range peer.AllowedIPs {
		allowedAttr, err := wireGuardAllowedIPAttr(allowed)
		if err != nil {
			return nil, err
		}
		allowedItems = append(allowedItems, nlAttr(uint16(i)|unix.NLA_F_NESTED, allowedAttr)...)
	}
	attrs = append(attrs, nlAttr(wgPeerAAllowedIPs|unix.NLA_F_NESTED, allowedItems)...)
	return attrs, nil
}

func wireGuardAllowedIPAttr(value string) ([]byte, error) {
	prefix, err := netip.ParsePrefix(value)
	if err != nil {
		return nil, err
	}
	attrs := make([]byte, 0)
	if prefix.Addr().Is4() {
		addr := prefix.Addr().As4()
		attrs = append(attrs, nlAttrUint16(wgAllowedIPAFamily, unix.AF_INET)...)
		attrs = append(attrs, nlAttr(wgAllowedIPAIPAddr, addr[:])...)
	} else if prefix.Addr().Is6() {
		addr := prefix.Addr().As16()
		attrs = append(attrs, nlAttrUint16(wgAllowedIPAFamily, unix.AF_INET6)...)
		attrs = append(attrs, nlAttr(wgAllowedIPAIPAddr, addr[:])...)
	} else {
		return nil, fmt.Errorf("wireguard allowed IP must be IPv4 or IPv6")
	}
	attrs = append(attrs, nlAttrUint8(wgAllowedIPACIDRMask, uint8(prefix.Bits()))...)
	return attrs, nil
}

func wireGuardEndpointBytes(endpoint string) ([]byte, error) {
	host, portText, err := net.SplitHostPort(endpoint)
	if err != nil {
		return nil, err
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 || port > 65535 {
		return nil, fmt.Errorf("wireguard endpoint port must be 1-65535")
	}
	if addr.Is4() {
		raw := make([]byte, 16)
		binary.LittleEndian.PutUint16(raw[0:2], unix.AF_INET)
		binary.BigEndian.PutUint16(raw[2:4], uint16(port))
		v4 := addr.As4()
		copy(raw[4:8], v4[:])
		return raw, nil
	}
	if addr.Is6() {
		raw := make([]byte, 28)
		binary.LittleEndian.PutUint16(raw[0:2], unix.AF_INET6)
		binary.BigEndian.PutUint16(raw[2:4], uint16(port))
		v6 := addr.As16()
		copy(raw[8:24], v6[:])
		return raw, nil
	}
	return nil, fmt.Errorf("wireguard endpoint address must be IPv4 or IPv6")
}

func parseWireGuardDevice(raw []byte) (WireGuardDeviceStatus, error) {
	attrs, err := parseNetlinkAttrs(raw)
	if err != nil {
		return WireGuardDeviceStatus{}, err
	}
	device := WireGuardDeviceStatus{}
	if ifname := firstAttr(attrs, wgDeviceAIfname); len(ifname) > 0 {
		device.Name = strings.TrimRight(string(ifname), "\x00")
	}
	if listenPort := firstAttr(attrs, wgDeviceAListenPort); len(listenPort) >= 2 {
		device.ListenPort = int(binary.LittleEndian.Uint16(listenPort[:2]))
	}
	for _, peersPayload := range attrValues(attrs, wgDeviceAPeers) {
		peerEntries, err := parseNetlinkAttrs(peersPayload)
		if err != nil {
			return WireGuardDeviceStatus{}, err
		}
		for _, peerEntry := range peerEntries {
			peer, err := parseWireGuardPeer(peerEntry.Payload)
			if err != nil {
				return WireGuardDeviceStatus{}, err
			}
			device.Peers = append(device.Peers, peer)
		}
	}
	return device, nil
}

func parseWireGuardPeer(raw []byte) (WireGuardPeerStatus, error) {
	attrs, err := parseNetlinkAttrs(raw)
	if err != nil {
		return WireGuardPeerStatus{}, err
	}
	peer := WireGuardPeerStatus{}
	if publicKey := firstAttr(attrs, wgPeerAPublicKey); len(publicKey) == wireGuardKeyLength {
		peer.PublicKey = cloneBytes(publicKey)
	}
	if handshake := firstAttr(attrs, wgPeerALastHandshakeTime); len(handshake) >= 16 {
		peer.LastHandshakeUnix = int64(binary.LittleEndian.Uint64(handshake[:8]))
	}
	for _, allowedPayload := range attrValues(attrs, wgPeerAAllowedIPs) {
		allowedEntries, err := parseNetlinkAttrs(allowedPayload)
		if err != nil {
			return WireGuardPeerStatus{}, err
		}
		for _, allowedEntry := range allowedEntries {
			allowed, err := parseWireGuardAllowedIP(allowedEntry.Payload)
			if err != nil {
				return WireGuardPeerStatus{}, err
			}
			if allowed != "" {
				peer.AllowedIPs = append(peer.AllowedIPs, allowed)
			}
		}
	}
	return peer, nil
}

func parseWireGuardAllowedIP(raw []byte) (string, error) {
	attrs, err := parseNetlinkAttrs(raw)
	if err != nil {
		return "", err
	}
	family := firstAttr(attrs, wgAllowedIPAFamily)
	addrRaw := firstAttr(attrs, wgAllowedIPAIPAddr)
	cidr := firstAttr(attrs, wgAllowedIPACIDRMask)
	if len(family) < 2 || len(cidr) < 1 {
		return "", nil
	}
	switch binary.LittleEndian.Uint16(family[:2]) {
	case unix.AF_INET:
		if len(addrRaw) < net.IPv4len {
			return "", nil
		}
		var addr [4]byte
		copy(addr[:], addrRaw[:net.IPv4len])
		return netip.PrefixFrom(netip.AddrFrom4(addr), int(cidr[0])).String(), nil
	case unix.AF_INET6:
		if len(addrRaw) < net.IPv6len {
			return "", nil
		}
		var addr [16]byte
		copy(addr[:], addrRaw[:net.IPv6len])
		return netip.PrefixFrom(netip.AddrFrom16(addr), int(cidr[0])).String(), nil
	default:
		return "", nil
	}
}

func mountInfoForTarget(target string) (mounted bool, shared bool, err error) {
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return false, false, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 7 || fields[4] != target {
			continue
		}
		for _, field := range fields[6:] {
			if field == "-" {
				break
			}
			if strings.HasPrefix(field, "shared:") {
				return true, true, nil
			}
		}
		return true, false, nil
	}
	return false, false, nil
}

func genericNetlinkRequest(msgType uint16, flags uint16, payload []byte) ([][]byte, error) {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_GENERIC)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)

	if err := unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return nil, err
	}

	seq := atomic.AddUint32(&netlinkSeq, 1)
	msg := nlMsg(msgType, flags, seq, payload)
	if err := unix.Sendto(fd, msg, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return nil, err
	}

	responses := make([][]byte, 0)
	buf := make([]byte, 8192)
	for {
		n, _, err := unix.Recvfrom(fd, buf, 0)
		if err != nil {
			return nil, err
		}
		done, err := appendNetlinkResponses(buf[:n], seq, flags, &responses)
		if err != nil {
			if errorsIsWouldBlock(err) {
				continue
			}
			return nil, err
		}
		if done {
			return responses, nil
		}
	}
}

func appendNetlinkResponses(raw []byte, seq uint32, requestFlags uint16, responses *[][]byte) (bool, error) {
	for offset := 0; offset+unix.SizeofNlMsghdr <= len(raw); {
		length := int(binary.LittleEndian.Uint32(raw[offset:]))
		if length < unix.SizeofNlMsghdr || offset+length > len(raw) {
			return false, syscall.EINVAL
		}
		msgType := binary.LittleEndian.Uint16(raw[offset+4:])
		msgFlags := binary.LittleEndian.Uint16(raw[offset+6:])
		msgSeq := binary.LittleEndian.Uint32(raw[offset+8:])
		payload := raw[offset+unix.SizeofNlMsghdr : offset+length]
		if msgSeq == seq {
			switch msgType {
			case unix.NLMSG_ERROR:
				if len(payload) < 4 {
					return false, syscall.EINVAL
				}
				code := int32(binary.LittleEndian.Uint32(payload))
				if code == 0 {
					return true, nil
				}
				return false, syscall.Errno(-code)
			case unix.NLMSG_DONE:
				return true, nil
			default:
				*responses = append(*responses, cloneBytes(payload))
				if requestFlags&unix.NLM_F_ACK == 0 && msgFlags&unix.NLM_F_MULTI == 0 {
					return true, nil
				}
			}
		}
		offset += nlAlign(length)
	}
	return false, nil
}

func netlinkRequest(msgType uint16, flags uint16, payload []byte) error {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_ROUTE)
	if err != nil {
		return err
	}
	defer unix.Close(fd)

	if err := unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}

	seq := atomic.AddUint32(&netlinkSeq, 1)
	msg := nlMsg(msgType, flags, seq, payload)
	if err := unix.Sendto(fd, msg, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}

	buf := make([]byte, 8192)
	for {
		n, _, err := unix.Recvfrom(fd, buf, 0)
		if err != nil {
			return err
		}
		if err := netlinkAck(buf[:n], seq); err != nil {
			if errorsIsWouldBlock(err) {
				continue
			}
			return err
		}
		return nil
	}
}

func errorsIsWouldBlock(err error) bool {
	return err == syscall.EAGAIN || err == syscall.EINTR
}

func netlinkAck(raw []byte, seq uint32) error {
	for offset := 0; offset+unix.SizeofNlMsghdr <= len(raw); {
		length := int(binary.LittleEndian.Uint32(raw[offset:]))
		if length < unix.SizeofNlMsghdr || offset+length > len(raw) {
			return syscall.EINVAL
		}
		msgType := binary.LittleEndian.Uint16(raw[offset+4:])
		msgSeq := binary.LittleEndian.Uint32(raw[offset+8:])
		payload := raw[offset+unix.SizeofNlMsghdr : offset+length]
		if msgSeq == seq {
			switch msgType {
			case unix.NLMSG_ERROR:
				if len(payload) < 4 {
					return syscall.EINVAL
				}
				code := int32(binary.LittleEndian.Uint32(payload))
				if code == 0 {
					return nil
				}
				return syscall.Errno(-code)
			case unix.NLMSG_DONE:
				return nil
			}
		}
		offset += nlAlign(length)
	}
	return syscall.EAGAIN
}

func nlMsg(msgType uint16, flags uint16, seq uint32, payload []byte) []byte {
	msg := make([]byte, unix.SizeofNlMsghdr, unix.SizeofNlMsghdr+len(payload))
	binary.LittleEndian.PutUint32(msg[0:], uint32(unix.SizeofNlMsghdr+len(payload)))
	binary.LittleEndian.PutUint16(msg[4:], msgType)
	binary.LittleEndian.PutUint16(msg[6:], flags)
	binary.LittleEndian.PutUint32(msg[8:], seq)
	return append(msg, payload...)
}

func nlAttr(attrType uint16, payload []byte) []byte {
	length := unix.SizeofRtAttr + len(payload)
	attr := make([]byte, nlAlign(length))
	binary.LittleEndian.PutUint16(attr[0:], uint16(length))
	binary.LittleEndian.PutUint16(attr[2:], attrType)
	copy(attr[unix.SizeofRtAttr:], payload)
	return attr
}

func nlAttrUint8(attrType uint16, value uint8) []byte {
	return nlAttr(attrType, []byte{value})
}

func nlAttrUint16(attrType uint16, value uint16) []byte {
	data := make([]byte, 2)
	binary.LittleEndian.PutUint16(data, value)
	return nlAttr(attrType, data)
}

func nlAttrUint32(attrType uint16, value uint32) []byte {
	data := make([]byte, 4)
	binary.LittleEndian.PutUint32(data, value)
	return nlAttr(attrType, data)
}

func nlAttrInt32(attrType uint16, value int32) []byte {
	data := make([]byte, 4)
	binary.LittleEndian.PutUint32(data, uint32(value))
	return nlAttr(attrType, data)
}

func nulString(value string) []byte {
	return append([]byte(value), 0)
}

func genlHeader(command uint8, version uint8) []byte {
	return []byte{command, version, 0, 0}
}

func ifInfoMsg(index int32, flags uint32, change uint32) []byte {
	msg := make([]byte, unix.SizeofIfInfomsg)
	msg[0] = unix.AF_UNSPEC
	binary.LittleEndian.PutUint32(msg[4:], uint32(index))
	binary.LittleEndian.PutUint32(msg[8:], flags)
	binary.LittleEndian.PutUint32(msg[12:], change)
	return msg
}

func ifAddrMsg(family uint8, prefixLen uint8, index uint32, scope uint8) []byte {
	msg := make([]byte, unix.SizeofIfAddrmsg)
	msg[0] = family
	msg[1] = prefixLen
	msg[3] = scope
	binary.LittleEndian.PutUint32(msg[4:], index)
	return msg
}

func rtMsg(family uint8, dstLen uint8, table uint8, protocol uint8, scope uint8, routeType uint8) []byte {
	msg := make([]byte, unix.SizeofRtMsg)
	msg[0] = family
	msg[1] = dstLen
	msg[4] = table
	msg[5] = protocol
	msg[6] = scope
	msg[7] = routeType
	return msg
}

func nlAlign(length int) int {
	return (length + unix.NLMSG_ALIGNTO - 1) & ^(unix.NLMSG_ALIGNTO - 1)
}

type netlinkAttr struct {
	Type    uint16
	Payload []byte
}

func parseNetlinkAttrs(raw []byte) ([]netlinkAttr, error) {
	attrs := make([]netlinkAttr, 0)
	for offset := 0; offset < len(raw); {
		if offset+unix.SizeofRtAttr > len(raw) {
			for _, b := range raw[offset:] {
				if b != 0 {
					return nil, syscall.EINVAL
				}
			}
			return attrs, nil
		}
		length := int(binary.LittleEndian.Uint16(raw[offset:]))
		if length < unix.SizeofRtAttr || offset+length > len(raw) {
			return nil, syscall.EINVAL
		}
		attrType := binary.LittleEndian.Uint16(raw[offset+2:]) & nlaTypeMask
		payload := cloneBytes(raw[offset+unix.SizeofRtAttr : offset+length])
		attrs = append(attrs, netlinkAttr{Type: attrType, Payload: payload})
		offset += nlAlign(length)
	}
	return attrs, nil
}

func firstAttr(attrs []netlinkAttr, attrType uint16) []byte {
	for _, attr := range attrs {
		if attr.Type == attrType {
			return attr.Payload
		}
	}
	return nil
}

func attrValues(attrs []netlinkAttr, attrType uint16) [][]byte {
	values := make([][]byte, 0)
	for _, attr := range attrs {
		if attr.Type == attrType {
			values = append(values, attr.Payload)
		}
	}
	return values
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}
