package capmanifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	nodetime "github.com/vita/agent/capabilities/time"
	"github.com/vita/agent/capabilities/timesync"
	"github.com/vita/agent/transport"
)

type timesyncConformanceVector struct {
	Name       string          `json:"name"`
	Request    json.RawMessage `json:"request"`
	Expect     string          `json:"expect"`
	RejectCode string          `json:"rejectCode"`
}

type timeConformanceVector struct {
	Name       string          `json:"name"`
	Request    json.RawMessage `json:"request"`
	Expect     string          `json:"expect"`
	RejectCode string          `json:"rejectCode"`
}

type datetimeFormatConformanceVector struct {
	Name      string          `json:"name"`
	Request   json.RawMessage `json:"request"`
	Expect    string          `json:"expect"`
	Canonical string          `json:"canonical"`
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
			manifestErr := Validate(manifest, request)
			agentErr := validateTimesyncAgentRequest(request)

			assertTimesyncExpectedDecision(t, vector, "manifest", manifestErr)
			assertTimesyncExpectedDecision(t, vector, "agent", agentErr)
			if (manifestErr == nil) != (agentErr == nil) {
				t.Fatalf("manifest/agent disagreement: manifest err=%v, agent err=%v", manifestErr, agentErr)
			}
		})
	}
}

func TestTimeSetConformanceCorpus(t *testing.T) {
	manifestRaw := readRepoFile(t, "schema", "capabilities", "time.json")
	manifest, err := LoadManifest(manifestRaw)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}

	vectors := loadTimeConformanceCorpus(t)
	if len(vectors) < 20 {
		t.Fatalf("time.set conformance corpus has %d vectors, want at least 20", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			request := conformanceRequestBytes(t, vector.Request)
			manifestErr := Validate(manifest, request)
			agentErr := validateTimeSetAgentRequest(request)

			assertTimeSetExpectedDecision(t, vector, "manifest", manifestErr)
			assertTimeSetExpectedDecision(t, vector, "agent", agentErr)
			if (manifestErr == nil) != (agentErr == nil) {
				t.Fatalf("manifest/agent disagreement: manifest err=%v, agent err=%v", manifestErr, agentErr)
			}
		})
	}
}

func TestRFC3339InstantFormatConformanceCorpus(t *testing.T) {
	manifest := Manifest{
		Capability: "test.rfc3339Instant",
		Version:    supportedManifestVersion,
		Fields: map[string]FieldSchema{
			"value": {
				Type:     "string",
				Required: true,
				Format:   "rfc3339Instant",
			},
		},
		CrossFieldRules: nil,
	}

	vectors := loadDatetimeFormatConformanceCorpus(t)
	if len(vectors) < 25 {
		t.Fatalf("rfc3339Instant conformance corpus has %d vectors, want at least 25", len(vectors))
	}

	for _, vector := range vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			err := Validate(manifest, conformanceRequestBytes(t, vector.Request))
			assertDatetimeFormatExpectedDecision(t, vector, err)
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

func loadTimeConformanceCorpus(t *testing.T) []timeConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "conformance", "time.json")
	var vectors []timeConformanceVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("json.Unmarshal time conformance corpus failed: %v", err)
	}

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("time vector %d has empty name", index)
		}
		if len(bytes.TrimSpace(vector.Request)) == 0 {
			t.Fatalf("time vector %s has empty request", vector.Name)
		}
		if vector.Expect != "accept" && vector.Expect != "reject" {
			t.Fatalf("time vector %s expect = %q, want accept or reject", vector.Name, vector.Expect)
		}
	}

	return vectors
}

func loadDatetimeFormatConformanceCorpus(t *testing.T) []datetimeFormatConformanceVector {
	t.Helper()

	raw := readRepoFile(t, "schema", "capabilities", "formats", "datetime-conformance.json")
	var vectors []datetimeFormatConformanceVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("json.Unmarshal datetime conformance corpus failed: %v", err)
	}

	for index, vector := range vectors {
		if vector.Name == "" {
			t.Fatalf("datetime vector %d has empty name", index)
		}
		if len(bytes.TrimSpace(vector.Request)) == 0 {
			t.Fatalf("datetime vector %s has empty request", vector.Name)
		}
		if vector.Expect != "accept" && vector.Expect != "reject" {
			t.Fatalf("datetime vector %s expect = %q, want accept or reject", vector.Name, vector.Expect)
		}
		if vector.Expect == "accept" && vector.Canonical == "" {
			t.Fatalf("datetime vector %s accepted without canonical", vector.Name)
		}
		if vector.Expect == "reject" && vector.Canonical != "" {
			t.Fatalf("datetime vector %s rejected with canonical", vector.Name)
		}
	}

	return vectors
}

func assertTimesyncExpectedDecision(t *testing.T, vector timesyncConformanceVector, validator string, err error) {
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

func assertTimeSetExpectedDecision(t *testing.T, vector timeConformanceVector, validator string, err error) {
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

func assertDatetimeFormatExpectedDecision(t *testing.T, vector datetimeFormatConformanceVector, err error) {
	t.Helper()

	switch vector.Expect {
	case "accept":
		if err != nil {
			t.Fatalf("manifest returned error, want accept: %v", err)
		}
	case "reject":
		if err == nil {
			t.Fatalf("manifest returned nil error, want rejection")
		}
	default:
		t.Fatalf("expect = %q, want accept or reject", vector.Expect)
	}
}

func validateTimesyncAgentRequest(raw []byte) error {
	request, err := transport.DecodeJSONRequest[timesync.ApplyRequest](json.RawMessage(raw))
	if err != nil {
		return err
	}
	validator, ok := request.(interface {
		capabilities.TypedRequest
		Validate() error
	})
	if !ok {
		return fmt.Errorf("timesync request %T cannot be validated", request)
	}
	return validator.Validate()
}

func validateTimeSetAgentRequest(raw []byte) error {
	request, err := transport.DecodeJSONRequest[nodetime.ApplyRequest](json.RawMessage(raw))
	if err != nil {
		return err
	}
	validator, ok := request.(interface {
		capabilities.TypedRequest
		Validate() error
	})
	if !ok {
		return fmt.Errorf("time.set request %T cannot be validated", request)
	}
	return validator.Validate()
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
