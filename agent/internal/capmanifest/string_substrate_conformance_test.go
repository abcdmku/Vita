package capmanifest

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

type stringSubstrateVector struct {
	Name             string `json:"name"`
	Value            string `json:"value"`
	Expect           string `json:"expect"`
	NoInlineMaterial bool   `json:"noInlineMaterial"`
	NoInlineSecrets  bool   `json:"noInlineSecrets"`
	NoControlChars   bool   `json:"noControlChars"`
	Trimmed          bool   `json:"trimmed"`
	MaxBytes         *int64 `json:"maxBytes"`
	MinLength        *int64 `json:"minLength"`
	NonEmpty         bool   `json:"nonEmpty"`
}

var (
	stringSubstrateOraclePrivateKeyPattern = regexp.MustCompile(
		`(?i)\b(?:private[-_\s]?key|openssh[-_\s]?private[-_\s]?key|age[-_\s]?secret[-_\s]?key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b`,
	)
	stringSubstrateOracleSecretAssignment = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*[:=]`)
	stringSubstrateOracleLongHex          = regexp.MustCompile(`(?:0x)?[A-Fa-f0-9]{32,}`)
	stringSubstrateOracleLongBase64       = regexp.MustCompile(`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`)
)

func TestStringSubstrateConformanceCorpus(t *testing.T) {
	vectors := loadStringSubstrateConformanceCorpus(t)
	if len(vectors) < 30 {
		t.Fatalf("string substrate conformance corpus has %d vectors, want at least 30", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			gotMaterial := containsInlineServiceMaterial(vector.Value)
			wantMaterial := stringSubstrateOracleContainsInlineServiceMaterial(vector.Value)
			if gotMaterial != wantMaterial {
				t.Fatalf("containsInlineServiceMaterial(%q) = %v, want oracle %v", vector.Value, gotMaterial, wantMaterial)
			}

			manifest := stringSubstrateManifest(vector)
			err := Validate(manifest, requestValueJSON(t, vector.Value))

			switch vector.Expect {
			case "accept":
				if err != nil {
					t.Fatalf("Validate returned error, want accept: %v", err)
				}
			case "reject":
				if err == nil {
					t.Fatal("Validate returned nil error, want rejection")
				}
			default:
				t.Fatalf("expect = %q, want accept or reject", vector.Expect)
			}
		})
	}
}

func TestStringSubstrateOptionsLoadFromManifestJSON(t *testing.T) {
	raw := []byte(`{
		"capability": "test.string-substrate",
		"version": 1,
		"fields": {
			"value": {
				"maxBytes": 16,
				"minLength": 1,
				"noControlChars": true,
				"noInlineMaterial": true,
				"nonEmpty": true,
				"required": true,
				"trimmed": true,
				"type": "string"
			},
			"legacy": {
				"noInlineSecrets": true,
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

	field := manifest.Fields["value"]
	if field.MaxBytes == nil || *field.MaxBytes != 16 ||
		field.MinLength == nil || *field.MinLength != 1 ||
		!field.NoControlChars ||
		!field.NoInlineMaterial ||
		!field.NonEmpty ||
		!field.Trimmed {
		t.Fatalf("loaded string substrate field = %#v, want all options", field)
	}

	if err := Validate(manifest, []byte(`{"value":"service-ok","legacy":"api key=x"}`)); err == nil {
		t.Fatal("Validate accepted legacy noInlineSecrets alias with service material")
	}
}

func loadStringSubstrateConformanceCorpus(t *testing.T) []stringSubstrateVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "formats", "string-substrate-conformance.json")
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()

	var vectors []stringSubstrateVector
	if err := decoder.Decode(&vectors); err != nil {
		t.Fatalf("json.Decode string substrate conformance corpus failed: %v", err)
	}

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("vector %d has empty name", index)
		}
		if vector.Expect != "accept" && vector.Expect != "reject" {
			t.Fatalf("vector %s expect = %q, want accept or reject", vector.Name, vector.Expect)
		}
	}

	return vectors
}

func stringSubstrateManifest(vector stringSubstrateVector) Manifest {
	return Manifest{
		Capability: "test.string-substrate",
		Version:    1,
		Fields: map[string]FieldSchema{
			"value": {
				Type:             "string",
				Required:         true,
				MaxBytes:         cloneInt64Pointer(vector.MaxBytes),
				MinLength:        cloneInt64Pointer(vector.MinLength),
				NoControlChars:   vector.NoControlChars,
				NoInlineMaterial: vector.NoInlineMaterial,
				NoInlineSecrets:  vector.NoInlineSecrets,
				NonEmpty:         vector.NonEmpty,
				Trimmed:          vector.Trimmed,
			},
		},
		CrossFieldRules: []CrossFieldRule{},
	}
}

func stringSubstrateOracleContainsInlineServiceMaterial(value string) bool {
	if strings.Contains(strings.ToUpper(value), "-----BEGIN") ||
		stringSubstrateOraclePrivateKeyPattern.MatchString(value) ||
		stringSubstrateOracleSecretAssignment.MatchString(value) {
		return true
	}
	return stringSubstrateOracleLongHex.MatchString(value) || stringSubstrateOracleLongBase64.MatchString(value)
}
