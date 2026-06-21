package capmanifest

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

type structuredFormatRepeatValue struct {
	Prefix string `json:"prefix"`
	Unit   string `json:"unit"`
	Count  int    `json:"count"`
	Suffix string `json:"suffix"`
}

type structuredFormatConformanceVectorRaw struct {
	Name            string                       `json:"name"`
	Format          string                       `json:"format"`
	Value           *string                      `json:"value"`
	RepeatValue     *structuredFormatRepeatValue `json:"repeatValue"`
	Expect          string                       `json:"expect"`
	Canonical       string                       `json:"canonical"`
	NoInlineSecrets bool                         `json:"noInlineSecrets"`
	MaxLength       *int64                       `json:"maxLength"`
}

type structuredFormatConformanceVector struct {
	Name            string
	Format          string
	Value           string
	Expect          string
	Canonical       string
	NoInlineSecrets bool
	MaxLength       *int64
}

func TestStructuredStringFormatsConformanceCorpus(t *testing.T) {
	vectors := loadStructuredFormatConformanceCorpus(t)
	counts := map[string]int{
		"posixUsername":   0,
		"groupName":       0,
		"systemdUnitName": 0,
		"absolutePath":    0,
	}

	for _, vector := range vectors {
		vector := vector
		counts[vector.Format]++
		t.Run(vector.Name, func(t *testing.T) {
			assertStructuredFormatDecision(t, vector)
		})
	}

	for format, count := range counts {
		if count < 10 {
			t.Fatalf("%s has %d vectors, want at least 10", format, count)
		}
	}
}

func TestStructuredStringFormatsLoadFromManifestJSON(t *testing.T) {
	formats := []string{"posixUsername", "groupName", "systemdUnitName", "absolutePath"}

	for _, format := range formats {
		format := format
		t.Run(format, func(t *testing.T) {
			raw := []byte(fmt.Sprintf(`{
				"capability": "test.%s.load",
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
				t.Fatalf("LoadManifest returned error: %v", err)
			}
			if manifest.Fields["value"].Format != format {
				t.Fatalf("value format = %q, want %q", manifest.Fields["value"].Format, format)
			}
		})
	}
}

func TestStructuredStringFormatsComposeWithMaxLengthAndNoInlineSecrets(t *testing.T) {
	maxLengthCases := []struct {
		format    string
		value     string
		maxLength int64
	}{
		{format: "posixUsername", value: "alice", maxLength: 3},
		{format: "groupName", value: "users", maxLength: 4},
		{format: "systemdUnitName", value: "ssh.service", maxLength: 4},
		{format: "absolutePath", value: "/var/lib", maxLength: 4},
	}

	for _, tt := range maxLengthCases {
		manifest := structuredStringFormatManifest(tt.format, structuredInt64Pointer(tt.maxLength), false)
		if err := Validate(manifest, requestValueJSON(t, tt.value)); err == nil {
			t.Fatalf("%s Validate returned nil error for value over maxLength", tt.format)
		}
	}

	inlineSecretPath := "/backup/-----BEGIN PRIVATE KEY-----"
	if err := Validate(structuredStringFormatManifest("absolutePath", nil, false), requestValueJSON(t, inlineSecretPath)); err != nil {
		t.Fatalf("absolutePath without noInlineSecrets returned error: %v", err)
	}
	if err := Validate(structuredStringFormatManifest("absolutePath", nil, true), requestValueJSON(t, inlineSecretPath)); err == nil {
		t.Fatal("absolutePath with noInlineSecrets returned nil error for inline secret material")
	}
}

func loadStructuredFormatConformanceCorpus(t *testing.T) []structuredFormatConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "formats", "structured-formats-conformance.json")
	var rawVectors []structuredFormatConformanceVectorRaw
	if err := json.Unmarshal(raw, &rawVectors); err != nil {
		t.Fatalf("json.Unmarshal structured format conformance corpus failed: %v", err)
	}

	vectors := make([]structuredFormatConformanceVector, 0, len(rawVectors))
	for index, rawVector := range rawVectors {
		vector := parseStructuredFormatConformanceVector(t, index, rawVector)
		vectors = append(vectors, vector)
	}
	return vectors
}

func parseStructuredFormatConformanceVector(t *testing.T, index int, raw structuredFormatConformanceVectorRaw) structuredFormatConformanceVector {
	t.Helper()

	if raw.Name == "" {
		t.Fatalf("vector %d has empty name", index)
	}
	if !isStructuredStringFormat(raw.Format) {
		t.Fatalf("vector %s has unsupported structured format %q", raw.Name, raw.Format)
	}
	if (raw.Value == nil) == (raw.RepeatValue == nil) {
		t.Fatalf("vector %s must set exactly one of value or repeatValue", raw.Name)
	}

	value := ""
	if raw.Value != nil {
		value = *raw.Value
	} else if raw.RepeatValue != nil {
		repeat := raw.RepeatValue
		if repeat.Unit == "" {
			t.Fatalf("vector %s repeatValue.unit is empty", raw.Name)
		}
		if repeat.Count < 0 || repeat.Count > 5000 {
			t.Fatalf("vector %s repeatValue.count = %d, want 0 through 5000", raw.Name, repeat.Count)
		}
		value = repeat.Prefix + strings.Repeat(repeat.Unit, repeat.Count) + repeat.Suffix
	}

	switch raw.Expect {
	case "accept":
		if raw.Canonical == "" {
			t.Fatalf("vector %s has empty canonical value for accept", raw.Name)
		}
	case "reject":
		if raw.Canonical != "" {
			t.Fatalf("vector %s has canonical value for reject", raw.Name)
		}
	default:
		t.Fatalf("vector %s expect = %q, want accept or reject", raw.Name, raw.Expect)
	}

	return structuredFormatConformanceVector{
		Name:            raw.Name,
		Format:          raw.Format,
		Value:           value,
		Expect:          raw.Expect,
		Canonical:       raw.Canonical,
		NoInlineSecrets: raw.NoInlineSecrets,
		MaxLength:       cloneInt64Pointer(raw.MaxLength),
	}
}

func assertStructuredFormatDecision(t *testing.T, vector structuredFormatConformanceVector) {
	t.Helper()

	manifest := structuredStringFormatManifest(vector.Format, vector.MaxLength, vector.NoInlineSecrets)
	err := Validate(manifest, requestValueJSON(t, vector.Value))
	canonical, ok := normalizeStringFormat(vector.Value, vector.Format)

	switch vector.Expect {
	case "accept":
		if err != nil {
			t.Fatalf("Validate returned error, want accept: %v", err)
		}
		if !ok {
			t.Fatal("normalizeStringFormat rejected accepted vector")
		}
		if canonical != vector.Canonical {
			t.Fatalf("canonical = %q, want %q", canonical, vector.Canonical)
		}
	case "reject":
		if err == nil {
			t.Fatal("Validate returned nil error, want rejection")
		}
		if !vector.NoInlineSecrets && vector.MaxLength == nil && ok {
			t.Fatalf("normalizeStringFormat returned %q, want rejection", canonical)
		}
	default:
		t.Fatalf("expect = %q, want accept or reject", vector.Expect)
	}
}

func structuredStringFormatManifest(format string, maxLength *int64, noInlineSecrets bool) Manifest {
	manifest := singleStringFormatManifest(format)
	field := manifest.Fields["value"]
	field.MaxLength = cloneInt64Pointer(maxLength)
	field.NoInlineSecrets = noInlineSecrets
	manifest.Fields["value"] = field
	return manifest
}

func isStructuredStringFormat(format string) bool {
	return format == "posixUsername" ||
		format == "groupName" ||
		format == "systemdUnitName" ||
		format == "absolutePath"
}

func structuredInt64Pointer(value int64) *int64 {
	return &value
}
