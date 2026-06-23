//go:build linux

package transport

import (
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	initialPeerGroups = 32
	maxPeerGroups     = 65536
	uint32Size        = int(unsafe.Sizeof(uint32(0)))
)

type syscallConn interface {
	SyscallConn() (syscall.RawConn, error)
}

func readUnixPeerInfo(conn net.Conn) (unixPeerInfo, error) {
	sysConn, ok := conn.(syscallConn)
	if !ok {
		return unixPeerInfo{}, fmt.Errorf("unix peer auth: %T does not expose SyscallConn", conn)
	}

	rawConn, err := sysConn.SyscallConn()
	if err != nil {
		return unixPeerInfo{}, fmt.Errorf("unix peer auth syscall conn: %w", err)
	}

	var info unixPeerInfo
	var controlErr error
	if err := rawConn.Control(func(fd uintptr) {
		cred, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if err != nil {
			controlErr = fmt.Errorf("getsockopt SO_PEERCRED: %w", err)
			return
		}

		info.Credentials = peerCredentials{
			PID: int(cred.Pid),
			UID: cred.Uid,
			GID: cred.Gid,
		}

		groups, err := getsockoptPeerGroups(int(fd))
		if err == nil {
			info.Groups = groups
			info.GroupSource = "SO_PEERGROUPS"
			return
		}
		if !shouldFallbackPeerGroups(err) {
			controlErr = fmt.Errorf("getsockopt SO_PEERGROUPS: %w", err)
			return
		}

		groups, err = readProcStatusGroups(info.Credentials.PID)
		if err != nil {
			controlErr = fmt.Errorf("read peer groups from proc status: %w", err)
			return
		}
		info.Groups = groups
		info.GroupSource = "proc_status"
	}); err != nil {
		return unixPeerInfo{}, err
	}
	if controlErr != nil {
		return unixPeerInfo{}, controlErr
	}

	return info, nil
}

func getsockoptPeerGroups(fd int) ([]uint32, error) {
	for count := initialPeerGroups; count <= maxPeerGroups; count *= 2 {
		groups := make([]uint32, count)
		optlen := uint32(len(groups) * uint32Size)
		_, _, errno := unix.Syscall6(
			unix.SYS_GETSOCKOPT,
			uintptr(fd),
			uintptr(unix.SOL_SOCKET),
			uintptr(unix.SO_PEERGROUPS),
			uintptr(unsafe.Pointer(&groups[0])),
			uintptr(unsafe.Pointer(&optlen)),
			0,
		)
		if errno == 0 {
			if optlen%uint32(uint32Size) != 0 {
				return nil, fmt.Errorf("SO_PEERGROUPS returned %d unaligned bytes", optlen)
			}
			groupCount := int(optlen) / uint32Size
			if groupCount > len(groups) {
				return nil, fmt.Errorf("SO_PEERGROUPS returned %d groups into %d-group buffer", groupCount, len(groups))
			}
			return groups[:groupCount], nil
		}
		if errors.Is(errno, unix.ERANGE) {
			continue
		}
		return nil, errno
	}

	return nil, fmt.Errorf("SO_PEERGROUPS exceeds %d groups", maxPeerGroups)
}

func shouldFallbackPeerGroups(err error) bool {
	return errors.Is(err, unix.ENOPROTOOPT) ||
		errors.Is(err, unix.EINVAL) ||
		errors.Is(err, unix.EOPNOTSUPP)
}

func readProcStatusGroups(pid int) ([]uint32, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("invalid peer pid %d", pid)
	}

	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return nil, err
	}
	return parseProcStatusGroups(data)
}
