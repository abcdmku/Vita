//go:build !linux

package backup

import (
	"context"
	"fmt"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const ArchiveName = "backup.archive"

type ArchiveOperation string

const (
	ArchiveOperationCreate  ArchiveOperation = "create"
	ArchiveOperationVerify  ArchiveOperation = "verify"
	ArchiveOperationRestore ArchiveOperation = "restore"
)

type ArchiveReadRequest struct{}

func (ArchiveReadRequest) CapabilityRequest() {}

func (ArchiveReadRequest) Validate() error { return nil }

type ArchiveApplyRequest struct {
	Op      ArchiveOperation       `json:"op"`
	Create  *ArchiveCreateRequest  `json:"create,omitempty"`
	Verify  *ArchiveVerifyRequest  `json:"verify,omitempty"`
	Restore *ArchiveRestoreRequest `json:"restore,omitempty"`
}

func (ArchiveApplyRequest) CapabilityRequest() {}

func (r *ArchiveApplyRequest) UnmarshalJSON(raw []byte) error {
	type archiveApplyRequestJSON ArchiveApplyRequest
	var decoded archiveApplyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	*r = ArchiveApplyRequest(decoded)
	return nil
}

func (r ArchiveApplyRequest) Validate() error {
	if r.Op != ArchiveOperationCreate && r.Op != ArchiveOperationVerify && r.Op != ArchiveOperationRestore {
		return archiveUnsupported()
	}
	return archiveUnsupported()
}

type ArchiveSourceRoot struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type ArchiveCreateRequest struct {
	TargetPath  string               `json:"targetPath"`
	SourceRoots *[]ArchiveSourceRoot `json:"sourceRoots,omitempty"`
}

type ArchiveVerifyRequest struct {
	TargetPath string `json:"targetPath"`
	BackupID   string `json:"backupId"`
}

type ArchiveRestoreRequest struct {
	TargetPath         string               `json:"targetPath"`
	BackupID           string               `json:"backupId"`
	DestinationRoot    string               `json:"destinationRoot"`
	CompareSourceRoots *[]ArchiveSourceRoot `json:"compareSourceRoots,omitempty"`
}

type ArchiveReadResponse struct {
	Last *ArchiveStatus `json:"last,omitempty"`
}

func (ArchiveReadResponse) CapabilityResponse() {}

type ArchiveStatus struct {
	Op       ArchiveOperation            `json:"op"`
	BackupID string                      `json:"backupId,omitempty"`
	Files    int                         `json:"files"`
	Created  bool                        `json:"created"`
	Verified bool                        `json:"verified"`
	Restored bool                        `json:"restored"`
	Failure  *ArchiveVerificationFailure `json:"failure,omitempty"`
	Status   string                      `json:"status"`
}

type ArchiveCreateResult struct {
	BackupID string `json:"backupId"`
	Files    int    `json:"files"`
}

type ArchiveVerifyResult struct {
	OK       bool                        `json:"ok"`
	BackupID string                      `json:"backupId"`
	Files    int                         `json:"files"`
	Failure  *ArchiveVerificationFailure `json:"failure,omitempty"`
}

type ArchiveRestoreResult struct {
	BackupID string `json:"backupId"`
	Files    int    `json:"files"`
	Restored bool   `json:"restored"`
}

type ArchiveVerificationFailure struct {
	Entry  string `json:"entry"`
	Reason string `json:"reason"`
}

type ArchiveCapability struct{}

type ArchiveInvalidRequestError struct {
	Reason string
	Code   string
}

func (e *ArchiveInvalidRequestError) Error() string {
	return fmt.Sprintf("invalid backup archive request: %s", e.Reason)
}

func (e *ArchiveInvalidRequestError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "backup_archive_rejected"
	}
	return e.Code
}

func NewArchiveCapability() *ArchiveCapability {
	return &ArchiveCapability{}
}

func (c *ArchiveCapability) Name() string {
	return ArchiveName
}

func (c *ArchiveCapability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, ok := req.(ArchiveReadRequest); !ok {
		return nil, &ArchiveInvalidRequestError{Reason: "expected backup.ArchiveReadRequest"}
	}
	return ArchiveReadResponse{}, nil
}

func (c *ArchiveCapability) Apply(context.Context, capabilities.TypedRequest) (transaction.Undo, error) {
	return nil, archiveUnsupported()
}

func archiveUnsupported() *ArchiveInvalidRequestError {
	return &ArchiveInvalidRequestError{
		Reason: "backup.archive requires linux",
		Code:   "backup_archive_unsupported_platform",
	}
}
