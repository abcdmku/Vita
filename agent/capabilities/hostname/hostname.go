package hostname

import (
	"context"
	"fmt"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name            = "hostname.set"
	maxHostnameLen  = 63
	unsupportedGOOS = "unsupported"
)

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

type ApplyRequest struct {
	Desired string `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r *ApplyRequest) UnmarshalJSON(raw []byte) error {
	type applyRequestJSON ApplyRequest
	var decoded applyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	*r = ApplyRequest(decoded)
	return nil
}

// Validate is the transport's pre-transaction request check (P1-008): reject an incomplete/invalid
// hostname before any transaction work. The kernel set itself stays in Apply (the single commit point).
func (ReadRequest) Validate() error { return nil }

func (r ApplyRequest) Validate() error {
	_, err := validateDesiredHostname(r.Desired)
	return err
}

type ReadResponse struct {
	Current string `json:"current"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	host host
}

type host interface {
	Current(context.Context) (string, error)
	Set(context.Context, string) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid hostname set request: %s", e.Reason)
}

type UnsupportedPlatformError struct {
	GOOS string
}

func (e *UnsupportedPlatformError) Error() string {
	if e.GOOS == "" {
		return "hostname set unsupported on this platform"
	}
	return fmt.Sprintf("hostname set unsupported on %s", e.GOOS)
}

func NewCapability() *Capability {
	return newCapability(newDefaultHost())
}

func newCapability(host host) *Capability {
	return &Capability{host: host}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected hostname.ReadRequest"}
	}
	if c == nil || c.host == nil {
		return nil, &InvalidRequestError{Reason: "missing hostname system"}
	}

	current, err := c.host.Current(ctx)
	if err != nil {
		return nil, err
	}

	return ReadResponse{Current: current}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected hostname.ApplyRequest"}
	}
	if c == nil || c.host == nil {
		return nil, &InvalidRequestError{Reason: "missing hostname system"}
	}

	prior, err := c.host.Current(ctx)
	if err != nil {
		return nil, err
	}
	desired, err := validateDesiredHostname(applyReq.Desired)
	if err != nil {
		return nil, err
	}

	undo := undoHostname{
		host:  c.host,
		prior: prior,
	}
	if err := c.host.Set(ctx, desired); err != nil {
		return nil, err
	}

	return undo, nil
}

type undoHostname struct {
	host  host
	prior string
}

func (u undoHostname) Undo(ctx context.Context) error {
	if u.host == nil {
		return &InvalidRequestError{Reason: "missing hostname system"}
	}
	return u.host.Set(ctx, u.prior)
}

type unsupportedHost struct {
	goos string
}

func newUnsupportedHost(goos string) unsupportedHost {
	if goos == "" {
		goos = unsupportedGOOS
	}
	return unsupportedHost{goos: goos}
}

func (h unsupportedHost) Current(context.Context) (string, error) {
	return "", &UnsupportedPlatformError{GOOS: h.goos}
}

func (h unsupportedHost) Set(context.Context, string) error {
	return &UnsupportedPlatformError{GOOS: h.goos}
}

func validateDesiredHostname(hostname string) (string, error) {
	if hostname == "" {
		return "", &InvalidRequestError{Reason: "desired hostname is empty"}
	}
	if len(hostname) > maxHostnameLen {
		return "", &InvalidRequestError{Reason: "desired hostname exceeds 63 characters"}
	}
	if hostname[0] == '-' {
		return "", &InvalidRequestError{Reason: "desired hostname has leading hyphen"}
	}
	if hostname[len(hostname)-1] == '-' {
		return "", &InvalidRequestError{Reason: "desired hostname has trailing hyphen"}
	}

	allNumeric := true
	for i := 0; i < len(hostname); i++ {
		ch := hostname[i]
		switch {
		case ch >= 'a' && ch <= 'z':
			allNumeric = false
		case ch >= '0' && ch <= '9':
		case ch == '-':
			allNumeric = false
		default:
			return "", &InvalidRequestError{Reason: "desired hostname must contain only lowercase ASCII letters, digits, or hyphen"}
		}
	}
	if allNumeric {
		return "", &InvalidRequestError{Reason: "desired hostname must not be all numeric"}
	}

	return hostname, nil
}
