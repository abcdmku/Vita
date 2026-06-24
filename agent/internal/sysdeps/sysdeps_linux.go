//go:build linux

package sysdeps

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"net"
	"net/netip"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	vethInfoPeer = 1
	nftPath      = "/usr/sbin/nft"
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
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return err
	}
	addr := prefix.Addr().As4()
	payload := ifAddrMsg(unix.AF_INET, uint8(prefix.Bits()), uint32(iface.Index), unix.RT_SCOPE_UNIVERSE)
	payload = append(payload, nlAttr(unix.IFA_LOCAL, addr[:])...)
	payload = append(payload, nlAttr(unix.IFA_ADDRESS, addr[:])...)
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

func nlAttrInt32(attrType uint16, value int32) []byte {
	data := make([]byte, 4)
	binary.LittleEndian.PutUint32(data, uint32(value))
	return nlAttr(attrType, data)
}

func nulString(value string) []byte {
	return append([]byte(value), 0)
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
