package jsonsafe_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities/accounts"
	"github.com/vita/agent/capabilities/backup"
	"github.com/vita/agent/capabilities/capsule"
	"github.com/vita/agent/capabilities/hostname"
	"github.com/vita/agent/capabilities/identity"
	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/capabilities/nodeconfig"
	"github.com/vita/agent/capabilities/pdssync"
	"github.com/vita/agent/capabilities/services"
	"github.com/vita/agent/capabilities/storage"
	nodetime "github.com/vita/agent/capabilities/time"
	"github.com/vita/agent/capabilities/timesync"
	"github.com/vita/agent/capabilities/update"
	"github.com/vita/agent/internal/jsonsafe"
)

func TestRejectDuplicateObjectKeysAcceptsNestedWithinBound(t *testing.T) {
	raw := []byte(`{"desired":{"levels":[{"name":"ok","children":[{"name":"leaf"}]}]}}`)

	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		t.Fatalf("RejectDuplicateObjectKeys returned error: %v", err)
	}
}

func TestRejectDuplicateObjectKeysRejectsDeeplyNestedPastBound(t *testing.T) {
	raw := []byte(strings.Repeat("[", 1102) + `0` + strings.Repeat("]", 1102))

	var err error
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				t.Fatalf("RejectDuplicateObjectKeys panicked: %v", recovered)
			}
		}()
		err = jsonsafe.RejectDuplicateObjectKeys(raw)
	}()

	var limit *jsonsafe.LimitError
	if !errors.As(err, &limit) || limit.Kind != "depth" {
		t.Fatalf("RejectDuplicateObjectKeys error = %T %v, want depth LimitError", err, err)
	}
}

func TestRejectDuplicateObjectKeysRejectsOversizedInputBeforeScan(t *testing.T) {
	raw := make([]byte, 16*1024*1024+1)

	var limit *jsonsafe.LimitError
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); !errors.As(err, &limit) || limit.Kind != "byte" {
		t.Fatalf("RejectDuplicateObjectKeys error = %T %v, want byte LimitError", err, err)
	}
}

func TestRejectDuplicateObjectKeysRejectsTopLevelAndNestedDuplicates(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		key  string
	}{
		{
			name: "top-level",
			raw:  `{"desired":1,"desired":2}`,
			key:  "desired",
		},
		{
			name: "nested",
			raw:  `{"desired":{"repo":"bad","repo":"good"}}`,
			key:  "repo",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var dup *jsonsafe.DuplicateObjectKeyError
			if err := jsonsafe.RejectDuplicateObjectKeys([]byte(tt.raw)); !errors.As(err, &dup) || dup.Key != tt.key {
				t.Fatalf("RejectDuplicateObjectKeys error = %T %v, want duplicate key %q", err, err, tt.key)
			}
		})
	}
}

func TestMigratedCapabilityRequestsStillDecode(t *testing.T) {
	validSRI := "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	validCID := "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy"
	validDID := "did:plc:ewvi7nxzyoun6zhxrhs64oiz"

	tests := []struct {
		name   string
		raw    string
		decode func([]byte) error
	}{
		{
			name: "accounts",
			raw:  `{"desired":{"accounts":[{"name":"alice","uid":1001,"primaryGroup":"users","groups":["users"],"shell":"/bin/bash","enabled":true}]}}`,
			decode: func(raw []byte) error {
				var req accounts.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "backup",
			raw:  `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":7,"maxAgeDays":30},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}}`,
			decode: func(raw []byte) error {
				var req backup.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "capsule",
			raw:  `{"desired":{"capsules":[{"id":"com.example.notes","version":"1.0.0","integrity":"` + validSRI + `","state":"installed"}]}}`,
			decode: func(raw []byte) error {
				var req capsule.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "hostname",
			raw:  `{"desired":"vita-node"}`,
			decode: func(raw []byte) error {
				var req hostname.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "identity",
			raw:  `{"desired":{"did":"` + validDID + `","handle":"alice.example.com","signingKeyRef":{"id":"rk:owner","handle":"rk_handle_owner"}}}`,
			decode: func(raw []byte) error {
				var req identity.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "network",
			raw:  `{"desired":{"allow":[{"proto":"tcp","port":443,"sourceCidr":"10.0.0.0/8","interface":"eth0"}]}}`,
			decode: func(raw []byte) error {
				var req network.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "nodeconfig",
			raw:  `{"desired":{"mode":"normal","remoteAccess":"enabled"}}`,
			decode: func(raw []byte) error {
				var req nodeconfig.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "pdssync",
			raw:  `{"desired":{"repo":"` + validDID + `","cursor":42,"repoHead":"` + validCID + `"}}`,
			decode: func(raw []byte) error {
				var req pdssync.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "services",
			raw:  `{"desired":{"services":[{"name":"sshd.service","enabled":true}]}}`,
			decode: func(raw []byte) error {
				var req services.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "storage",
			raw:  `{"desired":{"subvolumes":[{"role":"system-state","path":"/data/system-state","quotaGiB":16},{"role":"user-data","path":"/data/user-data","quotaGiB":512},{"role":"app-state","path":"/data/app-state/local-search","appId":"local-search","quotaGiB":64},{"role":"snapshots","path":"/data/snapshots","quotaGiB":256},{"role":"local-backup-cache","path":"/data/local-backup-cache","quotaGiB":256}]}}`,
			decode: func(raw []byte) error {
				var req storage.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "time",
			raw:  `{"desired":"2026-06-21T12:00:00Z"}`,
			decode: func(raw []byte) error {
				var req nodetime.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "timesync",
			raw:  `{"desired":{"enabled":true,"servers":["time.cloudflare.com"]}}`,
			decode: func(raw []byte) error {
				var req timesync.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
		{
			name: "update",
			raw:  `{"desired":{"targetSlot":"b","bundle":{"ref":"vita-os@1.3.0","integrity":"` + validSRI + `","version":"1.3.0"}}}`,
			decode: func(raw []byte) error {
				var req update.ApplyRequest
				if err := json.Unmarshal(raw, &req); err != nil {
					return err
				}
				return req.Validate()
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.decode([]byte(tt.raw)); err != nil {
				t.Fatalf("decode/Validate returned error: %v", err)
			}
		})
	}
}
