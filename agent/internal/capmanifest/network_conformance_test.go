package capmanifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/transport"
)

type networkConformanceVector struct {
	Name       string          `json:"name"`
	Request    json.RawMessage `json:"request"`
	Expect     string          `json:"expect"`
	RejectCode string          `json:"rejectCode"`
	Normalized json.RawMessage `json:"normalized"`
}

type networkFormatCorpus struct {
	CIDRLiteral          []networkFormatVector `json:"cidrLiteral"`
	NetworkInterfaceName []networkFormatVector `json:"networkInterfaceName"`
}

type networkFormatVector struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	Expect    string `json:"expect"`
	Canonical string `json:"canonical"`
	CoversAll *bool  `json:"coversAll"`
}

func TestNetworkConformanceCorpus(t *testing.T) {
	manifestRaw := readRepoFile(t, "schema", "capabilities", "network.json")
	manifest, err := LoadManifest(manifestRaw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}

	if manifest.Capability != network.Name {
		t.Fatalf("manifest capability = %q, want %q", manifest.Capability, network.Name)
	}

	vectors := loadNetworkConformanceCorpus(t)
	if len(vectors) < 26 {
		t.Fatalf("network conformance corpus has %d vectors, want at least 26", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			request := conformanceRequestBytes(t, vector.Request)
			manifestErr := Validate(manifest, request)
			agentErr := validateNetworkAgentRequest(request)

			assertNetworkExpectedDecision(t, vector, "manifest", manifestErr)
			assertNetworkExpectedDecision(t, vector, "agent", agentErr)
			if (manifestErr == nil) != (agentErr == nil) {
				t.Fatalf("manifest/agent disagreement: manifest err=%v, agent err=%v", manifestErr, agentErr)
			}
		})
	}
}

func TestNetworkFormatsConformanceCorpus(t *testing.T) {
	corpus := loadNetworkFormatCorpus(t)
	if len(corpus.CIDRLiteral) < 16 {
		t.Fatalf("cidrLiteral conformance corpus has %d vectors, want at least 16", len(corpus.CIDRLiteral))
	}
	if len(corpus.NetworkInterfaceName) < 10 {
		t.Fatalf("networkInterfaceName conformance corpus has %d vectors, want at least 10", len(corpus.NetworkInterfaceName))
	}

	cidrManifest := singleStringFormatManifest("cidrLiteral")
	interfaceManifest := singleStringFormatManifest("networkInterfaceName")
	for _, vector := range corpus.CIDRLiteral {
		vector := vector
		t.Run("cidrLiteral/"+vector.Name, func(t *testing.T) {
			assertNetworkFormatDecision(t, "cidrLiteral", vector, cidrManifest)
		})
	}
	for _, vector := range corpus.NetworkInterfaceName {
		vector := vector
		t.Run("networkInterfaceName/"+vector.Name, func(t *testing.T) {
			assertNetworkFormatDecision(t, "networkInterfaceName", vector, interfaceManifest)
		})
	}
}

func loadNetworkConformanceCorpus(t *testing.T) []networkConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "conformance", "network.json")
	var vectors []networkConformanceVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("json.Unmarshal network conformance corpus failed: %v", err)
	}

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("network vector %d has empty name", index)
		}
		if len(bytes.TrimSpace(vector.Request)) == 0 {
			t.Fatalf("network vector %s has empty request", vector.Name)
		}
		if vector.Expect != "accept" && vector.Expect != "reject" {
			t.Fatalf("network vector %s expect = %q, want accept or reject", vector.Name, vector.Expect)
		}
	}

	return vectors
}

func loadNetworkFormatCorpus(t *testing.T) networkFormatCorpus {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "formats", "network-formats-conformance.json")
	var corpus networkFormatCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("json.Unmarshal network format corpus failed: %v", err)
	}

	validateNetworkFormatVectors(t, "cidrLiteral", corpus.CIDRLiteral, true)
	validateNetworkFormatVectors(t, "networkInterfaceName", corpus.NetworkInterfaceName, false)
	return corpus
}

func validateNetworkFormatVectors(t *testing.T, format string, vectors []networkFormatVector, requireCanonical bool) {
	t.Helper()

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("%s vector %d has empty name", format, index)
		}
		switch vector.Expect {
		case "accept":
			if requireCanonical && vector.Canonical == "" {
				t.Fatalf("%s vector %s has empty canonical value for accept", format, vector.Name)
			}
			if requireCanonical && vector.CoversAll == nil {
				t.Fatalf("%s vector %s has nil coversAll value for accept", format, vector.Name)
			}
		case "reject":
			if vector.Canonical != "" {
				t.Fatalf("%s vector %s rejected with canonical value", format, vector.Name)
			}
		default:
			t.Fatalf("%s vector %s expect = %q, want accept or reject", format, vector.Name, vector.Expect)
		}
	}
}

func assertNetworkExpectedDecision(t *testing.T, vector networkConformanceVector, validator string, err error) {
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

func assertNetworkFormatDecision(t *testing.T, format string, vector networkFormatVector, manifest Manifest) {
	t.Helper()

	err := Validate(manifest, requestValueJSON(t, vector.Value))
	normalized, ok := normalizeStringFormat(vector.Value, format)

	switch vector.Expect {
	case "accept":
		if err != nil {
			t.Fatalf("Validate returned error, want accept: %v", err)
		}
		if !ok {
			t.Fatal("normalizeStringFormat rejected accepted vector")
		}
		want := vector.Canonical
		if want == "" {
			want = vector.Value
		}
		if normalized != want {
			t.Fatalf("normalized value = %q, want %q", normalized, want)
		}
		if vector.CoversAll != nil && cidrLiteralCoversAll(vector.Value) != *vector.CoversAll {
			t.Fatalf("coversAll = %v, want %v", cidrLiteralCoversAll(vector.Value), *vector.CoversAll)
		}
	case "reject":
		if err == nil {
			t.Fatal("Validate returned nil error, want rejection")
		}
		if ok {
			t.Fatalf("normalizeStringFormat returned %q, want rejection", normalized)
		}
	default:
		t.Fatalf("expect = %q, want accept or reject", vector.Expect)
	}
}

func validateNetworkAgentRequest(raw []byte) error {
	request, err := transport.DecodeJSONRequest[network.ApplyRequest](json.RawMessage(raw))
	if err != nil {
		return err
	}
	validator, ok := request.(interface {
		capabilities.TypedRequest
		Validate() error
	})
	if !ok {
		return fmt.Errorf("network request %T cannot be validated", request)
	}
	return validator.Validate()
}
