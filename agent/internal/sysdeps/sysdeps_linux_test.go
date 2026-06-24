//go:build linux

package sysdeps

import (
	"fmt"
	"net"
	"os"
	"runtime"
	"testing"
	"time"
)

const threadNetworkNamespacePath = "/proc/thread-self/ns/net"

func TestLinuxVethLifecycleUsesRealRtnetlink(t *testing.T) {
	suffix := fmt.Sprintf("%06x", time.Now().UnixNano()&0xffffff)
	host := "vt" + suffix
	peer := "vp" + suffix

	if err := CreateVeth(host, peer); err != nil {
		if ErrnoCode(err) == "EPERM" {
			t.Skipf("CAP_NET_ADMIN unavailable: %v", err)
		}
		t.Fatalf("CreateVeth returned error: %v", err)
	}
	t.Cleanup(func() {
		_ = DeleteLink(host)
	})

	if err := AddIPv4Address(host, "169.254.250.1/30"); err != nil {
		t.Fatalf("AddIPv4Address returned error: %v", err)
	}
	if err := SetLinkUp(host); err != nil {
		t.Fatalf("SetLinkUp returned error: %v", err)
	}
	if err := DeleteLink(host); err != nil {
		t.Fatalf("DeleteLink returned error: %v", err)
	}
}

func TestLinuxMoveLinkToNetnsAndBringUpUsesRealNetns(t *testing.T) {
	suffix := fmt.Sprintf("%06x", time.Now().UnixNano()&0xffffff)
	host := "vt" + suffix
	peer := "vp" + suffix

	target := createTestNetworkNamespace(t)
	defer target.Close()

	if err := CreateVeth(host, peer); err != nil {
		t.Fatalf("CreateVeth returned error: %v", err)
	}
	t.Cleanup(func() {
		_ = DeleteLink(host)
	})

	if err := MoveLinkToNetns(peer, int(target.Fd())); err != nil {
		t.Fatalf("MoveLinkToNetns returned error: %v", err)
	}

	withTestNetworkNamespace(t, target, func() {
		if _, err := net.InterfaceByName(peer); err != nil {
			t.Fatalf("InterfaceByName(%q) after move returned error: %v", peer, err)
		}
		if err := SetLinkUp(peer); err != nil {
			t.Fatalf("SetLinkUp(%q) in target netns returned error: %v", peer, err)
		}
		iface, err := net.InterfaceByName(peer)
		if err != nil {
			t.Fatalf("InterfaceByName(%q) after bring-up returned error: %v", peer, err)
		}
		if iface.Flags&net.FlagUp == 0 {
			t.Fatalf("interface %q flags = %v, want up", peer, iface.Flags)
		}
	})
}

func createTestNetworkNamespace(t *testing.T) *os.File {
	t.Helper()

	prior, err := os.Open(threadNetworkNamespacePath)
	if err != nil {
		t.Fatalf("open current netns returned error: %v", err)
	}

	runtime.LockOSThread()
	if err := UnshareNetworkNamespace(); err != nil {
		runtime.UnlockOSThread()
		_ = prior.Close()
		t.Fatalf("UnshareNetworkNamespace returned error: %v", err)
	}

	target, openErr := os.Open(threadNetworkNamespacePath)
	restoreErr := SetNetworkNamespace(int(prior.Fd()))
	if restoreErr == nil {
		runtime.UnlockOSThread()
	}
	_ = prior.Close()

	if openErr != nil {
		if restoreErr != nil {
			t.Fatalf("open target netns returned error: %v; restore also failed: %v", openErr, restoreErr)
		}
		t.Fatalf("open target netns returned error: %v", openErr)
	}
	if restoreErr != nil {
		_ = target.Close()
		t.Fatalf("restore original netns returned error: %v", restoreErr)
	}
	return target
}

func withTestNetworkNamespace(t *testing.T, target *os.File, fn func()) {
	t.Helper()

	prior, err := os.Open(threadNetworkNamespacePath)
	if err != nil {
		t.Fatalf("open current netns returned error: %v", err)
	}
	defer prior.Close()

	runtime.LockOSThread()
	if err := SetNetworkNamespace(int(target.Fd())); err != nil {
		runtime.UnlockOSThread()
		t.Fatalf("join target netns returned error: %v", err)
	}

	restored := false
	defer func() {
		if restored {
			runtime.UnlockOSThread()
		}
	}()
	defer func() {
		if restoreErr := SetNetworkNamespace(int(prior.Fd())); restoreErr != nil {
			t.Fatalf("restore original netns returned error: %v", restoreErr)
		}
		restored = true
	}()

	fn()
}
