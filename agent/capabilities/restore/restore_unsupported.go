//go:build !linux

package restore

import (
	"context"
	"fmt"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const Name = "restore.replacement"

type Operation string

const OperationReplace Operation = "replace"

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Op      Operation           `json:"op"`
	Replace *ReplacementRequest `json:"replace,omitempty"`
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

func (r ApplyRequest) Validate() error {
	if r.Op != OperationReplace || r.Replace == nil {
		return restoreUnsupported()
	}
	return restoreUnsupported()
}

type ReplacementRequest struct {
	BackupSource string         `json:"backupSource"`
	ExpectFrom   *string        `json:"expectFrom,omitempty"`
	Plan         *[]PlanMapping `json:"plan,omitempty"`
}

type PlanMapping struct {
	Name            string `json:"name"`
	BackupRoot      string `json:"backupRoot"`
	DestinationRoot string `json:"destinationRoot"`
}

type ReadResponse struct {
	Last *Status `json:"last,omitempty"`
}

func (ReadResponse) CapabilityResponse() {}

type Status struct {
	Op       Operation    `json:"op"`
	BackupID string       `json:"backupId"`
	Files    int          `json:"files"`
	From     string       `json:"from,omitempty"`
	To       string       `json:"to,omitempty"`
	Roots    []RootStatus `json:"roots"`
	Restored bool         `json:"restored"`
	Verified bool         `json:"verified"`
	Status   string       `json:"status"`
}

type RootStatus struct {
	Name            string `json:"name"`
	BackupRoot      string `json:"backupRoot"`
	DestinationRoot string `json:"destinationRoot"`
	Files           int    `json:"files"`
	Restored        bool   `json:"restored"`
	Verified        bool   `json:"verified"`
}

type ReplacementResult struct {
	BackupID string       `json:"backupId"`
	Files    int          `json:"files"`
	From     string       `json:"from,omitempty"`
	To       string       `json:"to,omitempty"`
	Roots    []RootStatus `json:"roots"`
	Restored bool         `json:"restored"`
	Verified bool         `json:"verified"`
}

type Capability struct{}

type InvalidRequestError struct {
	Reason string
	Code   string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid replacement restore request: %s", e.Reason)
}

func (e *InvalidRequestError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "restore_replacement_rejected"
	}
	return e.Code
}

func NewCapability() *Capability {
	return &Capability{}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected restore.ReadRequest", Code: "invalid_request"}
	}
	return ReadResponse{}, nil
}

func (c *Capability) Apply(context.Context, capabilities.TypedRequest) (transaction.Undo, error) {
	return nil, restoreUnsupported()
}

func (c *Capability) Replace(context.Context, ReplacementRequest) (ReplacementResult, transaction.Undo, error) {
	return ReplacementResult{}, nil, restoreUnsupported()
}

func restoreUnsupported() *InvalidRequestError {
	return &InvalidRequestError{
		Reason: "restore.replacement requires linux",
		Code:   "restore_replacement_unsupported_platform",
	}
}
