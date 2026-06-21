package capmanifest

import (
	"encoding/json"
	"strings"
	"testing"
)

type ipFormatExpectation struct {
	Expect    string `json:"expect"`
	Canonical string `json:"canonical"`
}

type ipFormatConformanceVector struct {
	Name         string              `json:"name"`
	Value        string              `json:"value"`
	IPLiteral    ipFormatExpectation `json:"ipLiteral"`
	HostnameOrIP ipFormatExpectation `json:"hostnameOrIp"`
}

func TestIPFormatConformanceCorpus(t *testing.T) {
	vectors := loadIPFormatConformanceCorpus(t)
	if len(vectors) < 40 {
		t.Fatalf("IP conformance corpus has %d vectors, want at least 40", len(vectors))
	}

	ipLiteralManifest := singleStringFormatManifest("ipLiteral")
	hostnameOrIPManifest := singleStringFormatManifest("hostnameOrIp")

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name+"/ipLiteral", func(t *testing.T) {
			assertIPFormatDecision(t, vector, "ipLiteral", vector.IPLiteral, ipLiteralManifest)
		})
		t.Run(vector.Name+"/hostnameOrIp", func(t *testing.T) {
			assertIPFormatDecision(t, vector, "hostnameOrIp", vector.HostnameOrIP, hostnameOrIPManifest)
		})
	}
}

func TestIPFormatsLoadFromManifestJSON(t *testing.T) {
	raw := []byte(`{
		"capability": "test.ip-formats",
		"version": 1,
		"fields": {
			"ip": {
				"format": "ipLiteral",
				"required": true,
				"type": "string"
			},
			"server": {
				"format": "hostnameOrIp",
				"required": true,
				"type": "string"
			}
		},
		"crossFieldRules": []
	}`)
	manifest, err := LoadManifest(raw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}
	if manifest.Fields["ip"].Format != "ipLiteral" {
		t.Fatalf("ip format = %q, want ipLiteral", manifest.Fields["ip"].Format)
	}
	if manifest.Fields["server"].Format != "hostnameOrIp" {
		t.Fatalf("server format = %q, want hostnameOrIp", manifest.Fields["server"].Format)
	}
}

func TestIPFormatCanonicalOutputDrivesUniqueItems(t *testing.T) {
	ipManifest := arrayStringFormatManifest("ipLiteral")
	if err := Validate(ipManifest, requestValuesJSON(t, []string{"2001:0db8::1", "2001:db8::1"})); err == nil {
		t.Fatal("Validate returned nil error for duplicate canonical ipLiteral values")
	}

	hostnameOrIPManifest := arrayStringFormatManifest("hostnameOrIp")
	if err := Validate(hostnameOrIPManifest, requestValuesJSON(t, []string{"::ffff:c000:201", "::ffff:192.0.2.1"})); err == nil {
		t.Fatal("Validate returned nil error for duplicate canonical hostnameOrIp values")
	}
}

func TestHostnameOrIPComposesWithLowercaseMaxLengthAndNoInlineSecrets(t *testing.T) {
	lowercaseManifest := singleStringFormatManifest("hostnameOrIp")
	field := lowercaseManifest.Fields["value"]
	field.Lowercase = true
	lowercaseManifest.Fields["value"] = field
	if err := Validate(lowercaseManifest, requestValueJSON(t, "Example.COM")); err != nil {
		t.Fatalf("Validate uppercase hostname returned error: %v", err)
	}

	maxLengthManifest := singleStringFormatManifest("ipLiteral")
	field = maxLengthManifest.Fields["value"]
	field.MaxLength = testInt64Pointer(8)
	maxLengthManifest.Fields["value"] = field
	if err := Validate(maxLengthManifest, requestValueJSON(t, "127.0.0.1")); err == nil {
		t.Fatal("Validate returned nil error for ipLiteral over maxLength")
	}

	noInlineSecretsManifest := singleStringFormatManifest("hostnameOrIp")
	field = noInlineSecretsManifest.Fields["value"]
	field.NoInlineSecrets = true
	noInlineSecretsManifest.Fields["value"] = field
	if err := Validate(noInlineSecretsManifest, requestValueJSON(t, "pool."+strings.Repeat("A", 48)+".org")); err == nil {
		t.Fatal("Validate returned nil error for inline secret material")
	}
}

func loadIPFormatConformanceCorpus(t *testing.T) []ipFormatConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "formats", "ip-conformance.json")
	var vectors []ipFormatConformanceVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("json.Unmarshal IP conformance corpus failed: %v", err)
	}

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("vector %d has empty name", index)
		}
		validateIPFormatExpectation(t, vector.Name, "ipLiteral", vector.IPLiteral)
		validateIPFormatExpectation(t, vector.Name, "hostnameOrIp", vector.HostnameOrIP)
	}

	return vectors
}

func validateIPFormatExpectation(t *testing.T, name string, format string, expectation ipFormatExpectation) {
	t.Helper()

	switch expectation.Expect {
	case "accept":
		if expectation.Canonical == "" {
			t.Fatalf("vector %s %s has empty canonical value for accept", name, format)
		}
	case "reject":
		if expectation.Canonical != "" {
			t.Fatalf("vector %s %s has canonical value for reject", name, format)
		}
	default:
		t.Fatalf("vector %s %s expect = %q, want accept or reject", name, format, expectation.Expect)
	}
}

func assertIPFormatDecision(t *testing.T, vector ipFormatConformanceVector, format string, expectation ipFormatExpectation, manifest Manifest) {
	t.Helper()

	err := Validate(manifest, requestValueJSON(t, vector.Value))
	canonical, ok := normalizeStringFormat(vector.Value, format)

	switch expectation.Expect {
	case "accept":
		if err != nil {
			t.Fatalf("Validate returned error, want accept: %v", err)
		}
		if !ok {
			t.Fatal("normalizeStringFormat rejected accepted vector")
		}
		if canonical != expectation.Canonical {
			t.Fatalf("canonical = %q, want %q", canonical, expectation.Canonical)
		}
	case "reject":
		if err == nil {
			t.Fatal("Validate returned nil error, want rejection")
		}
		if ok {
			t.Fatalf("normalizeStringFormat returned %q, want rejection", canonical)
		}
	default:
		t.Fatalf("expect = %q, want accept or reject", expectation.Expect)
	}
}

func singleStringFormatManifest(format string) Manifest {
	return Manifest{
		Capability: "test." + format,
		Version:    1,
		Fields: map[string]FieldSchema{
			"value": {
				Type:     "string",
				Required: true,
				Format:   format,
			},
		},
		CrossFieldRules: []CrossFieldRule{},
	}
}

func arrayStringFormatManifest(format string) Manifest {
	return Manifest{
		Capability: "test." + format + ".array",
		Version:    1,
		Fields: map[string]FieldSchema{
			"values": {
				Type:        "array",
				Required:    true,
				UniqueItems: true,
				Items: &FieldSchema{
					Type:     "string",
					Required: true,
					Format:   format,
				},
			},
		},
		CrossFieldRules: []CrossFieldRule{},
	}
}

func requestValueJSON(t *testing.T, value string) []byte {
	t.Helper()

	raw, err := json.Marshal(map[string]string{"value": value})
	if err != nil {
		t.Fatalf("json.Marshal value request failed: %v", err)
	}
	return raw
}

func requestValuesJSON(t *testing.T, values []string) []byte {
	t.Helper()

	raw, err := json.Marshal(map[string][]string{"values": values})
	if err != nil {
		t.Fatalf("json.Marshal values request failed: %v", err)
	}
	return raw
}

func testInt64Pointer(value int64) *int64 {
	return &value
}
