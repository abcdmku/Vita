package capmanifest

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLoadManifestAcceptsTimesyncJSON(t *testing.T) {
	manifest := mustLoadTimesyncManifest(t)

	if manifest.Capability != "time.sync" {
		t.Fatalf("Capability = %q, want time.sync", manifest.Capability)
	}
	servers := manifest.Fields["servers"]
	if servers.Type != "array" || servers.Items == nil {
		t.Fatalf("servers field = %#v, want array with items", servers)
	}
	items := servers.Items
	if items.Type != "string" ||
		items.Format != "hostnameRFC1123" ||
		items.MaxLength == nil ||
		*items.MaxLength != 253 ||
		!items.Lowercase ||
		!items.NoInlineSecrets {
		t.Fatalf("servers item schema = %#v, want named hostname format", items)
	}
}

func TestLoadManifestAcceptsNodeConfigObjectJSON(t *testing.T) {
	manifestRaw := readRepoFile(t, "schema", "capabilities", "node.config.json")
	manifest, err := LoadManifest(manifestRaw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}

	desired := manifest.Fields["desired"]
	if desired.Type != "object" || desired.Fields == nil {
		t.Fatalf("desired field = %#v, want object with fields", desired)
	}
	if desiredField := desired.Fields["mode"]; desiredField.Type != "string" || len(desiredField.Enum) != 2 {
		t.Fatalf("desired.mode field = %#v, want string enum", desiredField)
	}

	if err := Validate(manifest, []byte(`{"desired":{"mode":"normal","remoteAccess":"disabled"}}`)); err != nil {
		t.Fatalf("Validate valid node.config request returned error: %v", err)
	}
	if err := Validate(manifest, []byte(`{"desired":{"mode":"normal","remoteAccess":"disabled","extra":true}}`)); err == nil {
		t.Fatal("Validate accepted nested unknown field")
	}
	if err := Validate(manifest, []byte(`{"desired":{"mode":"normal"}}`)); err == nil {
		t.Fatal("Validate accepted missing nested required field")
	}
}

func TestLoadManifestRejectsMalformedManifests(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "unknown format",
			raw:  `{"capability":"demo","version":1,"fields":{"name":{"type":"string","required":true,"format":"dnsName"}},"crossFieldRules":[]}`,
		},
		{
			name: "raw pattern key",
			raw:  `{"capability":"demo","version":1,"fields":{"name":{"type":"string","required":true,"pattern":"^[a-z]+$"}},"crossFieldRules":[]}`,
		},
		{
			name: "default registry true",
			raw:  `{"capability":"demo","version":1,"defaultRegistry":true,"fields":{},"crossFieldRules":[]}`,
		},
		{
			name: "object schema missing fields",
			raw:  `{"capability":"demo","version":1,"fields":{"desired":{"type":"object","required":true}},"crossFieldRules":[]}`,
		},
		{
			name: "bad cross-field ref",
			raw:  `{"capability":"demo","version":1,"fields":{"servers":{"type":"array","required":true,"items":{"type":"string","required":true}}},"crossFieldRules":[{"type":"requireNonEmptyArrayWhenTrue","control":"enabled","target":"servers"}]}`,
		},
		{
			name: "unsupported version",
			raw:  `{"capability":"demo","version":2,"fields":{},"crossFieldRules":[]}`,
		},
		{
			name: "duplicate manifest key",
			raw:  `{"capability":"demo","version":1,"version":1,"fields":{},"crossFieldRules":[]}`,
		},
		{
			name: "truncated",
			raw:  `{"capability":"demo","version":1,"fields":`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := LoadManifest([]byte(tt.raw)); err == nil {
				t.Fatal("LoadManifest returned nil error, want rejection")
			}
		})
	}
}

func TestValidateTimesyncCorpus(t *testing.T) {
	manifest := mustLoadTimesyncManifest(t)

	okCases := []struct {
		name string
		raw  []byte
	}{
		{
			name: "enabled hostnames",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"pool.ntp.org", "time.cloudflare.com"},
			}),
		},
		{
			name: "disabled empty",
			raw: requestJSON(t, map[string]any{
				"enabled": false,
				"servers": []string{},
			}),
		},
	}
	for _, tt := range okCases {
		t.Run(tt.name, func(t *testing.T) {
			if err := Validate(manifest, tt.raw); err != nil {
				t.Fatalf("Validate returned error: %v", err)
			}
		})
	}

	tooLongHostname := strings.Join(repeatedLabels("a", 128), ".")
	rejectCases := []struct {
		name string
		raw  []byte
	}{
		{
			name: "enabled empty",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{},
			}),
		},
		{
			name: "disabled non-empty",
			raw: requestJSON(t, map[string]any{
				"enabled": false,
				"servers": []string{"pool.ntp.org"},
			}),
		},
		{
			name: "bad hostname",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"bad_host"},
			}),
		},
		{
			name: "too long hostname",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{tooLongHostname},
			}),
		},
		{
			name: "IPv4 form",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"10.0.0.1"},
			}),
		},
		{
			name: "IPv6 literal",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"::1"},
			}),
		},
		{
			name: "case-insensitive duplicate",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"A.ORG", "a.org"},
			}),
		},
		{
			name: "absent enabled",
			raw: requestJSON(t, map[string]any{
				"servers": []string{},
			}),
		},
		{
			name: "unknown key",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"extra":   true,
				"servers": []string{"pool.ntp.org"},
			}),
		},
		{
			name: "duplicate JSON key",
			raw:  []byte(`{"enabled":true,"enabled":false,"servers":[]}`),
		},
		{
			name: "inline secret",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"pool." + strings.Repeat("A", 48) + ".org"},
			}),
		},
		{
			name: "trailing newline",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"host\n"},
			}),
		},
		{
			name: "Kelvin sign case-folding bypass",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"K.example"},
			}),
		},
		{
			name: "dotted I case-folding bypass",
			raw: requestJSON(t, map[string]any{
				"enabled": true,
				"servers": []string{"İ.example"},
			}),
		},
		{
			name: "truncated",
			raw:  []byte(`{"enabled":true,"servers":`),
		},
	}
	for _, tt := range rejectCases {
		t.Run(tt.name, func(t *testing.T) {
			if err := Validate(manifest, tt.raw); err == nil {
				t.Fatal("Validate returned nil error, want rejection")
			}
		})
	}
}

func TestValidateIntegerUsesJSFloat64JSONSemantics(t *testing.T) {
	manifest := Manifest{
		Capability: "demo.integer",
		Version:    1,
		Fields: map[string]FieldSchema{
			"count": {
				Type:     "integer",
				Required: true,
				Minimum:  int64Pointer(0),
				Maximum:  int64Pointer(0),
			},
		},
		CrossFieldRules: []CrossFieldRule{},
	}

	if err := Validate(manifest, []byte(`{"count":1e-1000}`)); err != nil {
		t.Fatalf("Validate underflow returned error: %v", err)
	}
	if err := Validate(manifest, []byte(`{"count":1e400}`)); err == nil {
		t.Fatal("Validate overflow returned nil error, want rejection")
	}
}

func TestASCIILowercasePrimitiveLeavesNonASCIIUnchanged(t *testing.T) {
	got := asciiLowercase("İKABC")
	if got != "İKabc" {
		t.Fatalf("asciiLowercase = %q, want non-ASCII preserved", got)
	}

	manifest := Manifest{
		Capability: "demo.lowercase",
		Version:    1,
		Fields: map[string]FieldSchema{
			"values": {
				Type:        "array",
				Required:    true,
				UniqueItems: true,
				Items: &FieldSchema{
					Type:      "string",
					Required:  true,
					Lowercase: true,
				},
			},
		},
		CrossFieldRules: []CrossFieldRule{},
	}

	if err := Validate(manifest, []byte(`{"values":["İKABC","İKabc"]}`)); err == nil {
		t.Fatal("Validate returned nil error, want duplicate after ASCII lowercase")
	}
}

func TestValidateRejectsBadTypedManifestsFailClosed(t *testing.T) {
	if err := Validate(Manifest{}, []byte(`{}`)); err == nil {
		t.Fatal("Validate accepted empty manifest")
	}

	item := &FieldSchema{
		Type:     "array",
		Required: true,
	}
	item.Items = item
	manifest := Manifest{
		Capability: "demo.cycle",
		Version:    1,
		Fields: map[string]FieldSchema{
			"items": *item,
		},
		CrossFieldRules: []CrossFieldRule{},
	}
	if err := Validate(manifest, []byte(`{"items":[]}`)); err == nil {
		t.Fatal("Validate accepted cyclic typed manifest")
	}
}

func mustLoadTimesyncManifest(t *testing.T) Manifest {
	t.Helper()

	manifest, err := LoadManifest([]byte(timesyncManifestJSON))
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}
	return manifest
}

func requestJSON(t *testing.T, value map[string]any) []byte {
	t.Helper()

	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	return raw
}

func repeatedLabels(label string, count int) []string {
	labels := make([]string, count)
	for index := range labels {
		labels[index] = label
	}
	return labels
}

func int64Pointer(value int64) *int64 {
	return &value
}

const timesyncManifestJSON = `{
  "capability": "time.sync",
  "version": 1,
  "fields": {
    "enabled": {
      "required": true,
      "type": "boolean"
    },
    "servers": {
      "items": {
        "format": "hostnameRFC1123",
        "lowercase": true,
        "maxLength": 253,
        "noInlineSecrets": true,
        "required": true,
        "type": "string"
      },
      "maxItems": 8,
      "required": true,
      "type": "array",
      "uniqueItems": true
    }
  },
  "crossFieldRules": [
    {
      "control": "enabled",
      "target": "servers",
      "type": "requireNonEmptyArrayWhenTrue"
    },
    {
      "control": "enabled",
      "target": "servers",
      "type": "requireEmptyArrayWhenFalse"
    }
  ]
}`
