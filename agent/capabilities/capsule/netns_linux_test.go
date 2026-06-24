//go:build linux

package capsule

import (
	"context"
	"fmt"
	"os"
	"path"
	"testing"
	"time"
)

func TestDefaultCapsuleNetnsCreateNamedUsesPersistentThreadNamespace(t *testing.T) {
	suffix := fmt.Sprintf("%06x", time.Now().UnixNano()&0xffffff)
	netns := capsuleNetns{Name: "vita-capsule-test-" + suffix}
	manager := defaultCapsuleNetnsManager{}

	created, err := manager.Create(context.Background(), netns)
	if err != nil {
		t.Fatalf("Create named netns returned error: %v", err)
	}
	t.Cleanup(func() {
		_ = manager.Teardown(context.Background(), created)
	})

	if created.Private {
		t.Fatalf("created netns = %#v, want named non-private netns", created)
	}
	if created.Dir != path.Join(defaultNetnsRoot, created.Name) {
		t.Fatalf("Dir = %q, want path under default root", created.Dir)
	}
	if created.Path != path.Join(created.Dir, capsuleNetnsFileName) {
		t.Fatalf("Path = %q, want persistent netns file", created.Path)
	}
	if _, err := os.Stat(created.Path); err != nil {
		t.Fatalf("stat persistent netns path returned error: %v", err)
	}

	check, err := manager.Check(context.Background(), created)
	if err != nil {
		t.Fatalf("Check named netns returned error: %v", err)
	}
	if check.Status != capsuleNetnsMeasuredStatusOK || check.Isolation != capsuleNetnsIsolationEnforced {
		t.Fatalf("Check = %#v, want enforced OK", check)
	}
	if len(check.Interfaces) != 1 || check.Interfaces[0] != "lo" {
		t.Fatalf("Interfaces = %#v, want only loopback", check.Interfaces)
	}

	if err := manager.Teardown(context.Background(), created); err != nil {
		t.Fatalf("Teardown named netns returned error: %v", err)
	}
	if _, err := os.Stat(created.Path); !os.IsNotExist(err) {
		t.Fatalf("stat netns path after teardown = %v, want not exist", err)
	}
	if _, err := os.Stat(created.Dir); !os.IsNotExist(err) {
		t.Fatalf("stat netns dir after teardown = %v, want not exist", err)
	}
}
