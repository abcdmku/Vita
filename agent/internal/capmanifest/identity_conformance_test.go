package capmanifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/identity"
	"github.com/vita/agent/transport"
)

type identityConformanceVector struct {
	Name       string          `json:"name"`
	Request    json.RawMessage `json:"request"`
	Expect     string          `json:"expect"`
	RejectCode string          `json:"rejectCode"`
}

type identityFormatVector struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Expect string `json:"expect"`
}

func TestIdentityConformanceCorpus(t *testing.T) {
	manifestRaw := readRepoFile(t, "schema", "capabilities", "identity.json")
	manifest, err := LoadManifest(manifestRaw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}

	if manifest.Capability != identity.Name {
		t.Fatalf("manifest capability = %q, want %q", manifest.Capability, identity.Name)
	}

	vectors := loadIdentityConformanceCorpus(t)
	if len(vectors) < 28 {
		t.Fatalf("identity conformance corpus has %d vectors, want at least 28", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			request := conformanceRequestBytes(t, vector.Request)
			manifestErr := Validate(manifest, request)
			agentErr := validateIdentityAgentRequest(request)

			assertIdentityExpectedDecision(t, vector, "manifest", manifestErr)
			assertIdentityExpectedDecision(t, vector, "agent", agentErr)
			if (manifestErr == nil) != (agentErr == nil) {
				t.Fatalf("manifest/agent disagreement: manifest err=%v, agent err=%v", manifestErr, agentErr)
			}
		})
	}
}

func TestIdentityFormatConformanceCorpus(t *testing.T) {
	corpus := loadIdentityFormatConformanceCorpus(t)
	formats := []string{"didPlcOrWeb", "atprotoHandle", "keyReference"}

	for _, format := range formats {
		vectors := corpus[format]
		if len(vectors) < 10 {
			t.Fatalf("%s conformance corpus has %d vectors, want at least 10", format, len(vectors))
		}

		manifest := identitySingleStringFormatManifest(format)
		for _, vector := range vectors {
			vector := vector
			t.Run(format+"/"+vector.Name, func(t *testing.T) {
				assertIdentityFormatDecision(t, format, vector, manifest)
			})
		}
	}

	materialVectors := corpus["identitySecretMaterial"]
	if len(materialVectors) < 10 {
		t.Fatalf("identitySecretMaterial conformance corpus has %d vectors, want at least 10", len(materialVectors))
	}
	materialManifest := identityMaterialManifest()
	for _, vector := range materialVectors {
		vector := vector
		t.Run("identitySecretMaterial/"+vector.Name, func(t *testing.T) {
			assertIdentityFormatDecision(t, "identitySecretMaterial", vector, materialManifest)
		})
	}
}

func loadIdentityConformanceCorpus(t *testing.T) []identityConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "conformance", "identity.json")
	var vectors []identityConformanceVector
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

func loadIdentityFormatConformanceCorpus(t *testing.T) map[string][]identityFormatVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "formats", "identity-formats-conformance.json")
	var corpus map[string][]identityFormatVector
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("json.Unmarshal identity format conformance corpus failed: %v", err)
	}

	allowed := map[string]struct{}{
		"didPlcOrWeb":            {},
		"atprotoHandle":          {},
		"keyReference":           {},
		"identitySecretMaterial": {},
	}
	for key := range allowed {
		if _, ok := corpus[key]; !ok {
			t.Fatalf("identity format conformance corpus missing %s", key)
		}
	}
	for key := range corpus {
		if _, ok := allowed[key]; !ok {
			t.Fatalf("identity format conformance corpus has unsupported key %s", key)
		}
	}

	for key, vectors := range corpus {
		for index, vector := range vectors {
			if vector.Name == "" {
				t.Fatalf("%s vector %d has empty name", key, index)
			}
			if vector.Expect != "accept" && vector.Expect != "reject" {
				t.Fatalf("%s vector %s expect = %q, want accept or reject", key, vector.Name, vector.Expect)
			}
		}
	}

	return corpus
}

func assertIdentityExpectedDecision(t *testing.T, vector identityConformanceVector, validator string, err error) {
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

func assertIdentityFormatDecision(t *testing.T, format string, vector identityFormatVector, manifest Manifest) {
	t.Helper()

	err := Validate(manifest, identityFormatRequestValueJSON(t, vector.Value))
	switch vector.Expect {
	case "accept":
		if err != nil {
			t.Fatalf("%s %s returned error, want accept: %v", format, vector.Name, err)
		}
	case "reject":
		if err == nil {
			t.Fatalf("%s %s returned nil error, want rejection", format, vector.Name)
		}
	default:
		t.Fatalf("expect = %q, want accept or reject", vector.Expect)
	}
}

func validateIdentityAgentRequest(raw []byte) error {
	request, err := transport.DecodeJSONRequest[identity.ApplyRequest](json.RawMessage(raw))
	if err != nil {
		return err
	}
	validator, ok := request.(interface {
		capabilities.TypedRequest
		Validate() error
	})
	if !ok {
		return fmt.Errorf("identity request %T cannot be validated", request)
	}
	return validator.Validate()
}

func identitySingleStringFormatManifest(format string) Manifest {
	return Manifest{
		Capability: "test." + format,
		Version:    supportedManifestVersion,
		Fields: map[string]FieldSchema{
			"value": {
				Type:     "string",
				Required: true,
				Format:   format,
			},
		},
		CrossFieldRules: nil,
	}
}

func identityMaterialManifest() Manifest {
	return Manifest{
		Capability: "test.identity-material",
		Version:    supportedManifestVersion,
		Fields: map[string]FieldSchema{
			"value": {
				Type:                     "string",
				Required:                 true,
				NoInlineIdentityMaterial: true,
			},
		},
		CrossFieldRules: nil,
	}
}

func identityFormatRequestValueJSON(t *testing.T, value string) []byte {
	t.Helper()

	raw, err := json.Marshal(map[string]string{"value": value})
	if err != nil {
		t.Fatalf("json.Marshal identity format request failed: %v", err)
	}
	return raw
}
