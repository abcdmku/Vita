package nodeconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

const (
	Name                = "node.config"
	maxRequestJSONDepth = 1000
	maxRequestJSONNodes = 1000000
)

type Mode string

const (
	ModeNormal      Mode = "normal"
	ModeMaintenance Mode = "maintenance"
)

type RemoteAccess string

const (
	RemoteAccessDisabled RemoteAccess = "disabled"
	RemoteAccessEnabled  RemoteAccess = "enabled"
)

type Config struct {
	Mode         Mode         `json:"mode"`
	RemoteAccess RemoteAccess `json:"remoteAccess"`
}

func (c *Config) UnmarshalJSON(raw []byte) error {
	if err := rejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	type configJSON Config
	var decoded configJSON
	if err := decodeStrictJSON(raw, &decoded); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	*c = Config(decoded)
	return nil
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired Config `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r *ApplyRequest) UnmarshalJSON(raw []byte) error {
	if err := rejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	type applyRequestJSON ApplyRequest
	var decoded applyRequestJSON
	if err := decodeStrictJSON(raw, &decoded); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	*r = ApplyRequest(decoded)
	return nil
}

func (r ApplyRequest) Validate() error {
	return validateConfig(r.Desired)
}

type ReadResponse struct {
	Exists bool   `json:"exists"`
	Config Config `json:"config"`
	Raw    []byte `json:"raw"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs configFileSystem
}

type configSnapshot struct {
	exists bool
	bytes  []byte
}

type configFileSystem interface {
	Read(context.Context) (configSnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, configSnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid node config request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse node config: %s", e.Reason)
}

type UnsupportedPlatformError struct {
	GOOS string
}

func (e *UnsupportedPlatformError) Error() string {
	if e.GOOS == "" {
		return "node config unsupported on this platform"
	}
	return fmt.Sprintf("node config unsupported on %s", e.GOOS)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs configFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected nodeconfig.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing config filesystem"}
	}

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false}, nil
	}

	parsed, err := parseConfig(snapshot.bytes)
	if err != nil {
		return nil, err
	}

	return ReadResponse{
		Exists: true,
		Config: parsed,
		Raw:    cloneBytes(snapshot.bytes),
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected nodeconfig.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing config filesystem"}
	}
	if err := applyReq.Validate(); err != nil {
		return nil, err
	}

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}

	desiredBytes := renderConfig(applyReq.Desired)
	if err := c.fs.AtomicWrite(ctx, desiredBytes); err != nil {
		return nil, err
	}

	return undoConfig{
		fs:    c.fs,
		prior: cloneSnapshot(prior),
	}, nil
}

type undoConfig struct {
	fs    configFileSystem
	prior configSnapshot
}

func (u undoConfig) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing config filesystem"}
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

func validateConfig(config Config) error {
	switch config.Mode {
	case ModeNormal, ModeMaintenance:
	default:
		return &InvalidRequestError{Reason: "mode must be normal or maintenance"}
	}

	switch config.RemoteAccess {
	case RemoteAccessDisabled, RemoteAccessEnabled:
	default:
		return &InvalidRequestError{Reason: "remoteAccess must be disabled or enabled"}
	}

	return nil
}

func renderConfig(config Config) []byte {
	var builder strings.Builder
	builder.WriteString("mode=")
	builder.WriteString(string(config.Mode))
	builder.WriteByte('\n')
	builder.WriteString("remote_access=")
	builder.WriteString(string(config.RemoteAccess))
	builder.WriteByte('\n')
	return []byte(builder.String())
}

func parseConfig(raw []byte) (Config, error) {
	if len(raw) == 0 {
		return Config{}, &ParseError{Reason: "empty config"}
	}

	lines := strings.Split(string(raw), "\n")
	seenMode := false
	seenRemoteAccess := false
	var config Config

	for index, line := range lines {
		if index == len(lines)-1 && line == "" {
			continue
		}
		if line == "" {
			return Config{}, &ParseError{Reason: "blank line"}
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return Config{}, &ParseError{Reason: "missing key separator"}
		}
		if value == "" {
			return Config{}, &ParseError{Reason: "empty value"}
		}

		switch key {
		case "mode":
			if seenMode {
				return Config{}, &ParseError{Reason: "duplicate mode"}
			}
			config.Mode = Mode(value)
			seenMode = true
		case "remote_access":
			if seenRemoteAccess {
				return Config{}, &ParseError{Reason: "duplicate remote_access"}
			}
			config.RemoteAccess = RemoteAccess(value)
			seenRemoteAccess = true
		default:
			return Config{}, &ParseError{Reason: "unknown key"}
		}
	}

	if !seenMode || !seenRemoteAccess {
		return Config{}, &ParseError{Reason: "missing required key"}
	}
	if err := validateConfig(config); err != nil {
		return Config{}, err
	}
	if !bytes.Equal(raw, renderConfig(config)) {
		return Config{}, &ParseError{Reason: "non-canonical encoding"}
	}

	return config, nil
}

func rejectDuplicateObjectKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	nodes := 0
	if err := scanJSONValue(decoder, 0, &nodes); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err != nil {
			return err
		}
		return fmt.Errorf("body must contain exactly one JSON value before %v", token)
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder, depth int, nodes *int) error {
	if depth > maxRequestJSONDepth {
		return errors.New("JSON depth budget exceeded")
	}
	if *nodes >= maxRequestJSONNodes {
		return errors.New("JSON node budget exceeded")
	}
	*nodes++

	token, err := decoder.Token()
	if err != nil {
		return err
	}

	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}

	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object key must be a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
		endToken, err := decoder.Token()
		if err != nil {
			return err
		}
		if endToken != json.Delim('}') {
			return fmt.Errorf("object closed with %v", endToken)
		}
	case '[':
		for decoder.More() {
			if err := scanJSONValue(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
		endToken, err := decoder.Token()
		if err != nil {
			return err
		}
		if endToken != json.Delim(']') {
			return fmt.Errorf("array closed with %v", endToken)
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %v", delim)
	}

	return nil
}

func decodeStrictJSON(raw []byte, target interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}

	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("body must contain exactly one JSON value")
		}
		return err
	}
	return nil
}

func cloneSnapshot(snapshot configSnapshot) configSnapshot {
	return configSnapshot{
		exists: snapshot.exists,
		bytes:  cloneBytes(snapshot.bytes),
	}
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}
