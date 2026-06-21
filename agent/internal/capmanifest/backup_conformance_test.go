package capmanifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/backup"
	"github.com/vita/agent/transport"
)

type backupConformanceVector struct {
	Name       string          `json:"name"`
	Request    json.RawMessage `json:"request"`
	Expect     string          `json:"expect"`
	RejectCode string          `json:"rejectCode"`
}

// TestBackupConformanceCorpus runs every backup vector through BOTH the ADR-0007 manifest validator
// AND the REAL agent entrypoint (transport.DecodeJSONRequest[backup.ApplyRequest] + Validate), then
// asserts the two decisions agree. The agent is the oracle, so this is a true manifest≡agent test.
func TestBackupConformanceCorpus(t *testing.T) {
	manifestRaw := readRepoFile(t, "schema", "capabilities", "backup.json")
	manifest, err := LoadManifest(manifestRaw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}

	if manifest.Capability != backup.Name {
		t.Fatalf("manifest capability = %q, want %q", manifest.Capability, backup.Name)
	}

	vectors := loadBackupConformanceCorpus(t)
	if len(vectors) < 28 {
		t.Fatalf("backup conformance corpus has %d vectors, want at least 28", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			request := conformanceRequestBytes(t, vector.Request)
			manifestErr := Validate(manifest, request)
			agentErr := validateBackupAgentRequest(request)

			assertBackupExpectedDecision(t, vector, "manifest", manifestErr)
			assertBackupExpectedDecision(t, vector, "agent", agentErr)
			if (manifestErr == nil) != (agentErr == nil) {
				t.Fatalf("manifest/agent disagreement: manifest err=%v, agent err=%v", manifestErr, agentErr)
			}
		})
	}
}

func loadBackupConformanceCorpus(t *testing.T) []backupConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "conformance", "backup.json")
	var vectors []backupConformanceVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("json.Unmarshal backup conformance corpus failed: %v", err)
	}

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("backup vector %d has empty name", index)
		}
		if len(bytes.TrimSpace(vector.Request)) == 0 {
			t.Fatalf("backup vector %s has empty request", vector.Name)
		}
		if vector.Expect != "accept" && vector.Expect != "reject" {
			t.Fatalf("backup vector %s expect = %q, want accept or reject", vector.Name, vector.Expect)
		}
	}

	return vectors
}

func assertBackupExpectedDecision(t *testing.T, vector backupConformanceVector, validator string, err error) {
	t.Helper()

	switch vector.Expect {
	case "accept":
		if err != nil {
			t.Fatalf("%s returned error, want accept: %v", validator, err)
		}
	case "reject":
		if err == nil {
			t.Fatalf("%s returned nil error, want rejection", validator)
		}
		if validator == "manifest" && vector.RejectCode != "" && !strings.Contains(err.Error(), vector.RejectCode) {
			t.Fatalf("%s rejection = %q, want code/path %q", validator, err.Error(), vector.RejectCode)
		}
	default:
		t.Fatalf("expect = %q, want accept or reject", vector.Expect)
	}
}

func validateBackupAgentRequest(raw []byte) error {
	request, err := transport.DecodeJSONRequest[backup.ApplyRequest](json.RawMessage(raw))
	if err != nil {
		return err
	}
	validator, ok := request.(interface {
		capabilities.TypedRequest
		Validate() error
	})
	if !ok {
		return fmt.Errorf("backup request %T cannot be validated", request)
	}
	return validator.Validate()
}
