package capmanifest

import (
	"encoding/json"
	"fmt"
	"testing"
)

type structuredFormatVector struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Expect string `json:"expect"`
}

var structuredStringFormats = []string{
	"posixUsername",
	"groupName",
	"systemdUnitName",
	"absolutePath",
	"capsuleId",
	"capsuleVersion",
	"sriIntegrity",
	"bundleRefString",
	"bundleVersionString",
}

func TestStructuredFormatConformanceCorpus(t *testing.T) {
	corpus := loadStructuredFormatConformanceCorpus(t)

	for _, format := range structuredStringFormats {
		vectors := corpus[format]
		if len(vectors) < 10 {
			t.Fatalf("%s conformance corpus has %d vectors, want at least 10", format, len(vectors))
		}

		manifest := singleStringFormatManifest(format)
		for _, vector := range vectors {
			vector := vector
			t.Run(format+"/"+vector.Name, func(t *testing.T) {
				assertStructuredFormatDecision(t, format, vector, manifest)
			})
		}
	}
}

func TestStructuredFormatsLoadFromManifestJSON(t *testing.T) {
	for _, format := range structuredStringFormats {
		raw := []byte(fmt.Sprintf(`{
			"capability": "test.%s",
			"version": 1,
			"fields": {
				"value": {
					"format": %q,
					"required": true,
					"type": "string"
				}
			},
			"crossFieldRules": []
		}`, format, format))

		manifest, err := LoadManifest(raw)
		if err != nil {
			t.Fatalf("%s LoadManifest returned error: %v", format, err)
		}
		if manifest.Fields["value"].Format != format {
			t.Fatalf("%s loaded format = %q, want %q", format, manifest.Fields["value"].Format, format)
		}
	}
}

func TestStructuredFormatsComposeWithMaxLengthAndNoInlineSecrets(t *testing.T) {
	maxLengthManifest := singleStringFormatManifest("absolutePath")
	field := maxLengthManifest.Fields["value"]
	field.MaxLength = structuredTestInt64Pointer(5)
	maxLengthManifest.Fields["value"] = field
	if err := Validate(maxLengthManifest, structuredRequestValueJSON(t, "/data/ok")); err == nil {
		t.Fatal("Validate returned nil error for absolutePath over maxLength")
	}

	noInlineSecretsManifest := singleStringFormatManifest("absolutePath")
	field = noInlineSecretsManifest.Fields["value"]
	field.NoInlineSecrets = true
	noInlineSecretsManifest.Fields["value"] = field
	if err := Validate(noInlineSecretsManifest, structuredRequestValueJSON(t, "/data/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")); err == nil {
		t.Fatal("Validate returned nil error for absolutePath with inline secret material")
	}

	posixNoInlineSecretsManifest := singleStringFormatManifest("posixUsername")
	field = posixNoInlineSecretsManifest.Fields["value"]
	field.NoInlineSecrets = true
	posixNoInlineSecretsManifest.Fields["value"] = field
	if err := Validate(posixNoInlineSecretsManifest, structuredRequestValueJSON(t, "x-----begin")); err == nil {
		t.Fatal("Validate returned nil error for posixUsername with inline secret material")
	}

	noInlineCapsuleMaterialManifest := singleStringFormatManifest("capsuleVersion")
	field = noInlineCapsuleMaterialManifest.Fields["value"]
	field.NoInlineCapsuleMaterial = true
	noInlineCapsuleMaterialManifest.Fields["value"] = field
	if err := Validate(noInlineCapsuleMaterialManifest, structuredRequestValueJSON(t, "private_key")); err == nil {
		t.Fatal("Validate returned nil error for inline capsule material")
	}

	forbiddenSchemePrefixManifest := singleStringFormatManifest("capsuleId")
	field = forbiddenSchemePrefixManifest.Fields["value"]
	field.ForbiddenSchemePrefix = true
	forbiddenSchemePrefixManifest.Fields["value"] = field
	if err := Validate(forbiddenSchemePrefixManifest, structuredRequestValueJSON(t, "data:abc")); err == nil {
		t.Fatal("Validate returned nil error for forbidden scheme prefix")
	}
	if err := Validate(forbiddenSchemePrefixManifest, structuredRequestValueJSON(t, "capsule:abc")); err != nil {
		t.Fatalf("Validate returned error for non-forbidden scheme prefix: %v", err)
	}
}

func loadStructuredFormatConformanceCorpus(t *testing.T) map[string][]structuredFormatVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "formats", "structured-formats-conformance.json")
	var corpus map[string][]structuredFormatVector
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("json.Unmarshal structured format conformance corpus failed: %v", err)
	}

	allowed := make(map[string]struct{}, len(structuredStringFormats))
	for _, format := range structuredStringFormats {
		allowed[format] = struct{}{}
		if _, ok := corpus[format]; !ok {
			t.Fatalf("structured format conformance corpus missing %s", format)
		}
	}
	for format := range corpus {
		if _, ok := allowed[format]; !ok {
			t.Fatalf("structured format conformance corpus has unsupported format %s", format)
		}
	}

	for format, vectors := range corpus {
		for index, vector := range vectors {
			if vector.Name == "" {
				t.Fatalf("%s vector %d has empty name", format, index)
			}
			if vector.Expect != "accept" && vector.Expect != "reject" {
				t.Fatalf("%s vector %s expect = %q, want accept or reject", format, vector.Name, vector.Expect)
			}
		}
	}

	return corpus
}

func assertStructuredFormatDecision(t *testing.T, format string, vector structuredFormatVector, manifest Manifest) {
	t.Helper()

	err := Validate(manifest, structuredRequestValueJSON(t, vector.Value))
	normalized, ok := normalizeStringFormat(vector.Value, format)

	switch vector.Expect {
	case "accept":
		if err != nil {
			t.Fatalf("Validate returned error, want accept: %v", err)
		}
		if !ok {
			t.Fatal("normalizeStringFormat rejected accepted vector")
		}
		if normalized != vector.Value {
			t.Fatalf("normalized value = %q, want unchanged %q", normalized, vector.Value)
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

func structuredRequestValueJSON(t *testing.T, value string) []byte {
	t.Helper()

	raw, err := json.Marshal(map[string]string{"value": value})
	if err != nil {
		t.Fatalf("json.Marshal structured value request failed: %v", err)
	}
	return raw
}

func structuredTestInt64Pointer(value int64) *int64 {
	return &value
}
