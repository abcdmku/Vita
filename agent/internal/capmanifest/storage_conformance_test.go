package capmanifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/storage"
	"github.com/vita/agent/transport"
)

type storageConformanceVector struct {
	Name       string          `json:"name"`
	Request    json.RawMessage `json:"request"`
	Expect     string          `json:"expect"`
	RejectCode string          `json:"rejectCode"`
}

// TestStorageConformanceCorpus runs every storage vector through BOTH the ADR-0007 manifest validator
// AND the REAL agent entrypoint (transport.DecodeJSONRequest[storage.ApplyRequest] + Validate), then
// asserts the two decisions agree. The agent is the oracle, so this is a true manifest≡agent test of
// the four whole-list invariants (enum-conditional appId, singleton roles, required role coverage,
// per-role appId uniqueness) plus the reused absolutePath / nullAsAbsent / integer-literal rules.
func TestStorageConformanceCorpus(t *testing.T) {
	manifestRaw := readRepoFile(t, "schema", "capabilities", "storage.json")
	manifest, err := LoadManifest(manifestRaw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}

	if manifest.Capability != storage.Name {
		t.Fatalf("manifest capability = %q, want %q", manifest.Capability, storage.Name)
	}

	vectors := loadStorageConformanceCorpus(t)
	if len(vectors) < 30 {
		t.Fatalf("storage conformance corpus has %d vectors, want at least 30", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			request := conformanceRequestBytes(t, vector.Request)
			manifestErr := Validate(manifest, request)
			agentErr := validateStorageAgentRequest(request)

			assertStorageExpectedDecision(t, vector, "manifest", manifestErr)
			assertStorageExpectedDecision(t, vector, "agent", agentErr)
			if (manifestErr == nil) != (agentErr == nil) {
				t.Fatalf("manifest/agent disagreement: manifest err=%v, agent err=%v", manifestErr, agentErr)
			}
		})
	}
}

func loadStorageConformanceCorpus(t *testing.T) []storageConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "conformance", "storage.json")
	var vectors []storageConformanceVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("json.Unmarshal storage conformance corpus failed: %v", err)
	}

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("storage vector %d has empty name", index)
		}
		if len(bytes.TrimSpace(vector.Request)) == 0 {
			t.Fatalf("storage vector %s has empty request", vector.Name)
		}
		if vector.Expect != "accept" && vector.Expect != "reject" {
			t.Fatalf("storage vector %s expect = %q, want accept or reject", vector.Name, vector.Expect)
		}
	}

	return vectors
}

func assertStorageExpectedDecision(t *testing.T, vector storageConformanceVector, validator string, err error) {
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

func validateStorageAgentRequest(raw []byte) error {
	request, err := transport.DecodeJSONRequest[storage.ApplyRequest](json.RawMessage(raw))
	if err != nil {
		return err
	}
	validator, ok := request.(interface {
		capabilities.TypedRequest
		Validate() error
	})
	if !ok {
		return fmt.Errorf("storage request %T cannot be validated", request)
	}
	return validator.Validate()
}
