package nodetime

import (
	"context"
	"fmt"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name            = "time.set"
	maxClockSkew    = 2 * time.Hour
	unsupportedGOOS = "unsupported"
)

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

type ApplyRequest struct {
	Desired time.Time `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r *ApplyRequest) UnmarshalJSON(raw []byte) error {
	type applyRequestJSON ApplyRequest
	var decoded applyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}

	*r = ApplyRequest(decoded)
	return nil
}

// Validate is the transport's pre-transaction request check (P1-008). It enforces only STATIC
// validity; the ±maxClockSkew drift bound is a runtime property enforced in Apply against the live
// clock, not here (a stateless check must not depend on the wall clock).
func (ReadRequest) Validate() error { return nil }

func (r ApplyRequest) Validate() error {
	if r.Desired.IsZero() {
		return &InvalidRequestError{Reason: "desired time is zero"}
	}
	return nil
}

type ReadResponse struct {
	Current time.Time `json:"current"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	clock clock
}

type clock interface {
	Now(context.Context) (time.Time, error)
	Set(context.Context, time.Time) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid time set request: %s", e.Reason)
}

type UnsupportedPlatformError struct {
	GOOS string
}

func (e *UnsupportedPlatformError) Error() string {
	if e.GOOS == "" {
		return "time set unsupported on this platform"
	}
	return fmt.Sprintf("time set unsupported on %s", e.GOOS)
}

func NewCapability() *Capability {
	return newCapability(newDefaultClock())
}

func newCapability(clock clock) *Capability {
	return &Capability{clock: clock}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected nodetime.ReadRequest"}
	}
	if c == nil || c.clock == nil {
		return nil, &InvalidRequestError{Reason: "missing clock"}
	}

	current, err := c.clock.Now(ctx)
	if err != nil {
		return nil, err
	}

	return ReadResponse{Current: current}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected nodetime.ApplyRequest"}
	}
	if c == nil || c.clock == nil {
		return nil, &InvalidRequestError{Reason: "missing clock"}
	}

	prior, err := c.clock.Now(ctx)
	if err != nil {
		return nil, err
	}
	desired, err := validateDesiredTime(prior, applyReq.Desired)
	if err != nil {
		return nil, err
	}

	undo := undoTime{
		clock: c.clock,
		prior: prior,
	}
	if err := c.clock.Set(ctx, desired); err != nil {
		return nil, err
	}

	return undo, nil
}

type undoTime struct {
	clock clock
	prior time.Time
}

func (u undoTime) Undo(ctx context.Context) error {
	if u.clock == nil {
		return &InvalidRequestError{Reason: "missing clock"}
	}
	return u.clock.Set(ctx, u.prior)
}

type unsupportedClock struct {
	goos string
}

func newUnsupportedClock(goos string) unsupportedClock {
	if goos == "" {
		goos = unsupportedGOOS
	}
	return unsupportedClock{goos: goos}
}

func (c unsupportedClock) Now(context.Context) (time.Time, error) {
	return time.Time{}, &UnsupportedPlatformError{GOOS: c.goos}
}

func (c unsupportedClock) Set(context.Context, time.Time) error {
	return &UnsupportedPlatformError{GOOS: c.goos}
}

func validateDesiredTime(current, desired time.Time) (time.Time, error) {
	if current.IsZero() {
		return time.Time{}, &InvalidRequestError{Reason: "current time is zero"}
	}
	if desired.IsZero() {
		return time.Time{}, &InvalidRequestError{Reason: "desired time is zero"}
	}

	delta := desired.Sub(current)
	if delta < -maxClockSkew || delta > maxClockSkew {
		return time.Time{}, &InvalidRequestError{Reason: "desired time exceeds maximum skew"}
	}

	return desired.Round(0).UTC(), nil
}
