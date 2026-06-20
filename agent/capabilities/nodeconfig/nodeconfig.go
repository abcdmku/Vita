package nodeconfig

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

const Name = "node.config"

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

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

type ApplyRequest struct {
	Desired Config `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

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
	if err := validateConfig(applyReq.Desired); err != nil {
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
