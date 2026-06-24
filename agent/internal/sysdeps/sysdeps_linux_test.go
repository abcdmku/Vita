//go:build linux

package sysdeps

import (
	"fmt"
	"testing"
	"time"
)

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
