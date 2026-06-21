package capmanifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/accounts"
	"github.com/vita/agent/transport"
)

type accountsConformanceVector struct {
	Name       string          `json:"name"`
	Request    json.RawMessage `json:"request"`
	Expect     string          `json:"expect"`
	RejectCode string          `json:"rejectCode"`
	Normalized json.RawMessage `json:"normalized"`
}

func TestAccountsConformanceCorpus(t *testing.T) {
	manifestRaw := readRepoFile(t, "schema", "capabilities", "accounts.json")
	manifest, err := LoadManifest(manifestRaw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}

	if manifest.Capability != accounts.Name {
		t.Fatalf("manifest capability = %q, want %q", manifest.Capability, accounts.Name)
	}

	vectors := loadAccountsConformanceCorpus(t)
	if len(vectors) < 28 {
		t.Fatalf("accounts conformance corpus has %d vectors, want at least 28", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			request := conformanceRequestBytes(t, vector.Request)
			manifestErr := Validate(manifest, request)
			agentRequest, agentErr := validateAccountsAgentRequest(request)

			assertAccountsExpectedDecision(t, vector, "manifest", manifestErr)
			assertAccountsExpectedDecision(t, vector, "agent", agentErr)
			if (manifestErr == nil) != (agentErr == nil) {
				t.Fatalf("manifest/agent disagreement: manifest err=%v, agent err=%v", manifestErr, agentErr)
			}
			if len(bytes.TrimSpace(vector.Normalized)) > 0 && agentErr == nil {
				assertAccountsNormalized(t, vector, agentRequest)
			}
		})
	}
}

func loadAccountsConformanceCorpus(t *testing.T) []accountsConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "conformance", "accounts.json")
	var vectors []accountsConformanceVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("json.Unmarshal conformance corpus failed: %v", err)
	}

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("vector %d has empty name", index)
		}
		if len(bytes.TrimSpace(vector.Request)) == 0 {
			t.Fatalf("vector %s has empty request", vector.Name)
		}
		if vector.Expect != "accept" && vector.Expect != "reject" {
			t.Fatalf("vector %s expect = %q, want accept or reject", vector.Name, vector.Expect)
		}
	}

	return vectors
}

func assertAccountsExpectedDecision(t *testing.T, vector accountsConformanceVector, validator string, err error) {
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

func validateAccountsAgentRequest(raw []byte) (accounts.ApplyRequest, error) {
	request, err := transport.DecodeJSONRequest[accounts.ApplyRequest](json.RawMessage(raw))
	if err != nil {
		return accounts.ApplyRequest{}, err
	}
	typed, ok := request.(accounts.ApplyRequest)
	if !ok {
		return accounts.ApplyRequest{}, fmt.Errorf("accounts request %T cannot be type asserted", request)
	}
	validator, ok := request.(interface {
		capabilities.TypedRequest
		Validate() error
	})
	if !ok {
		return accounts.ApplyRequest{}, fmt.Errorf("accounts request %T cannot be validated", request)
	}
	if err := validator.Validate(); err != nil {
		return accounts.ApplyRequest{}, err
	}
	return typed, nil
}

func assertAccountsNormalized(t *testing.T, vector accountsConformanceVector, request accounts.ApplyRequest) {
	t.Helper()

	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("json.Marshal normalized request failed: %v", err)
	}

	var got any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("json.Unmarshal normalized request failed: %v", err)
	}
	var want any
	if err := json.Unmarshal(vector.Normalized, &want); err != nil {
		t.Fatalf("json.Unmarshal vector normalized failed: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized request = %s, want %s", raw, vector.Normalized)
	}
}
