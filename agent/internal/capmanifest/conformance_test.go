package capmanifest

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type timesyncConformanceVector struct {
	Name       string          `json:"name"`
	Request    json.RawMessage `json:"request"`
	Expect     string          `json:"expect"`
	RejectCode string          `json:"rejectCode"`
}

func TestTimesyncConformanceCorpus(t *testing.T) {
	manifestRaw := readRepoFile(t, "schema", "capabilities", "timesync.json")
	manifest, err := LoadManifest(manifestRaw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}

	vectors := loadTimesyncConformanceCorpus(t)
	if len(vectors) < 15 {
		t.Fatalf("timesync conformance corpus has %d vectors, want at least 15", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			request := conformanceRequestBytes(t, vector.Request)
			err := Validate(manifest, request)

			switch vector.Expect {
			case "accept":
				if err != nil {
					t.Fatalf("Validate returned error, want accept: %v", err)
				}
			case "reject":
				if err == nil {
					t.Fatal("Validate returned nil error, want rejection")
				}
				if vector.RejectCode != "" && !strings.Contains(err.Error(), vector.RejectCode) {
					t.Fatalf("Validate rejection = %q, want code/path %q", err.Error(), vector.RejectCode)
				}
			default:
				t.Fatalf("expect = %q, want accept or reject", vector.Expect)
			}
		})
	}
}

func loadTimesyncConformanceCorpus(t *testing.T) []timesyncConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "conformance", "timesync.json")
	var vectors []timesyncConformanceVector
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

func conformanceRequestBytes(t *testing.T, request json.RawMessage) []byte {
	t.Helper()

	trimmed := bytes.TrimSpace(request)
	if len(trimmed) == 0 {
		t.Fatal("empty conformance request")
	}
	if trimmed[0] != '"' {
		return append([]byte(nil), trimmed...)
	}

	var rawRequest string
	if err := json.Unmarshal(trimmed, &rawRequest); err != nil {
		t.Fatalf("json.Unmarshal raw request failed: %v", err)
	}
	return []byte(rawRequest)
}

func readRepoFile(t *testing.T, pathElements ...string) []byte {
	t.Helper()

	var candidates [][]string
	if _, currentFile, _, ok := runtime.Caller(0); ok {
		candidates = append(candidates, append([]string{filepath.Dir(currentFile), "..", "..", ".."}, pathElements...))
	}
	if workingDirectory, err := os.Getwd(); err == nil {
		candidates = append(candidates, append([]string{workingDirectory, "..", "..", ".."}, pathElements...))
	}

	var readErrors []string
	for _, candidate := range candidates {
		raw, err := os.ReadFile(filepath.Clean(filepath.Join(candidate...)))
		if err == nil {
			return raw
		}

		readErrors = append(readErrors, err.Error())
	}

	t.Fatalf("os.ReadFile failed: %s", strings.Join(readErrors, "; "))
	return nil
}
