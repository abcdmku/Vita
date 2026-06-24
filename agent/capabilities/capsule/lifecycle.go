package capsule

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/backup"
	capsuleruntime "github.com/vita/agent/internal/capsule-runtime"
	"github.com/vita/agent/internal/jsonsafe"
	capsulestorage "github.com/vita/agent/storage/capsules"
	"github.com/vita/agent/transaction"
)

const (
	LifecycleName = "capsule.lifecycle"

	lifecycleOpUpdate    = "update"
	lifecycleOpRestart   = "restart"
	lifecycleOpStop      = "stop"
	lifecycleOpRemediate = "remediate"

	defaultLifecycleBackupTarget = "/var/lib/vita-backups"

	lifecycleStatusOK     = "OK"
	lifecycleStatusFailed = "failed"

	defaultLifecyclePollInterval = 250 * time.Millisecond
	maxRemediationRestarts       = 1
)

type LifecycleApplyRequest struct {
	Desired *LifecycleDesired `json:"desired"`
}

func (LifecycleApplyRequest) CapabilityRequest() {}

func (r *LifecycleApplyRequest) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, lifecycleApplyRequestFields); err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}

	rawDesired, ok := fields["desired"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawDesired), []byte("null")) {
		return &LifecycleInvalidRequestError{Reason: "desired is required"}
	}

	var desired LifecycleDesired
	if err := decodeSingleJSONValue(rawDesired, &desired); err != nil {
		return err
	}

	*r = LifecycleApplyRequest{Desired: &desired}
	return nil
}

func (r LifecycleApplyRequest) Validate() error {
	if r.Desired == nil {
		return lifecycleInvalid("desired is required")
	}
	return r.Desired.Validate()
}

type LifecycleDesired struct {
	Op     string           `json:"op"`
	ID     string           `json:"id"`
	Target *LifecycleTarget `json:"target,omitempty"`
}

func (d *LifecycleDesired) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, lifecycleDesiredFields); err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}

	op, err := requiredStringField(fields, "op")
	if err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}
	id, err := requiredStringField(fields, "id")
	if err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}

	var target *LifecycleTarget
	if rawTarget, ok := fields["target"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawTarget), []byte("null")) {
			return &LifecycleInvalidRequestError{Reason: "target must be an object"}
		}
		var decoded LifecycleTarget
		if err := decodeSingleJSONValue(rawTarget, &decoded); err != nil {
			return err
		}
		target = &decoded
	}

	desired := LifecycleDesired{Op: op, ID: id, Target: target}
	if err := desired.Validate(); err != nil {
		return err
	}
	*d = desired
	return nil
}

func (d LifecycleDesired) Validate() error {
	if d.ID == "" {
		return lifecycleInvalid("desired.id is required")
	}
	if !validCapsuleID(d.ID) {
		return lifecycleInvalid("desired.id must be a well-formed capsule id")
	}
	switch d.Op {
	case lifecycleOpUpdate:
		if d.Target == nil {
			return lifecycleInvalid("desired.target is required for update")
		}
	case lifecycleOpRestart, lifecycleOpStop, lifecycleOpRemediate:
		if d.Target != nil {
			return lifecycleInvalid("desired.target is only allowed for update")
		}
	default:
		return lifecycleInvalid("desired.op must be update, restart, stop, or remediate")
	}
	return nil
}

type LifecycleTarget struct {
	Entry    CapsuleEntry      `json:"entry"`
	Manifest ExecutionManifest `json:"manifest"`
}

func (t *LifecycleTarget) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, lifecycleTargetFields); err != nil {
		return &LifecycleInvalidRequestError{Reason: err.Error()}
	}

	var entry CapsuleEntry
	if err := requiredObjectField(fields, "entry", &entry); err != nil {
		return err
	}
	var manifest ExecutionManifest
	if err := requiredObjectField(fields, "manifest", &manifest); err != nil {
		return err
	}

	*t = LifecycleTarget{Entry: entry, Manifest: manifest}
	return nil
}

type LifecycleReadRequest struct{}

func (LifecycleReadRequest) CapabilityRequest() {}

func (LifecycleReadRequest) Validate() error { return nil }

type LifecycleReadResponse struct {
	Last *LifecycleStatus `json:"last,omitempty"`
}

func (LifecycleReadResponse) CapabilityResponse() {}

type LifecycleStatus struct {
	Op                    string `json:"op"`
	ID                    string `json:"id"`
	FromVersion           string `json:"fromVersion,omitempty"`
	ToVersion             string `json:"toVersion,omitempty"`
	BackupID              string `json:"backupId,omitempty"`
	RestoredBackupID      string `json:"restoredBackupId,omitempty"`
	Health                string `json:"health,omitempty"`
	Policy                string `json:"policy,omitempty"`
	Restarts              int    `json:"restarts,omitempty"`
	RollbackOnUnhealthyOK bool   `json:"rollbackOnUnhealthyOk,omitempty"`
	Stopped               bool   `json:"stopped,omitempty"`
	Status                string `json:"status"`
	Reason                string `json:"reason,omitempty"`
}

type LifecycleCapability struct {
	execute        *ExecuteCapability
	archive        lifecycleArchive
	healthSnapshot func() []capsuleruntime.WorkloadStatus
	now            func() time.Time
	sleep          func(context.Context, time.Duration) error
	pollInterval   time.Duration

	mu   sync.Mutex
	last *LifecycleStatus
}

type lifecycleArchive interface {
	Create(context.Context, backup.ArchiveCreateRequest) (backup.ArchiveCreateResult, transaction.Undo, error)
	Verify(context.Context, backup.ArchiveVerifyRequest) (backup.ArchiveVerifyResult, error)
	Restore(context.Context, backup.ArchiveRestoreRequest) (backup.ArchiveRestoreResult, transaction.Undo, error)
}

type archiveApplyHandle interface {
	Apply(context.Context, capabilities.TypedRequest) (transaction.Undo, error)
	Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error)
}

type LifecycleInvalidRequestError struct {
	Reason string
	Code   string
}

func (e *LifecycleInvalidRequestError) Error() string {
	return fmt.Sprintf("invalid capsule lifecycle request: %s", e.Reason)
}

func (e *LifecycleInvalidRequestError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "capsule_lifecycle_rejected"
	}
	return e.Code
}

type LifecycleOperationError struct {
	Code string
	Err  error
}

func (e *LifecycleOperationError) Error() string {
	if e == nil || e.Err == nil {
		return "capsule lifecycle operation failed"
	}
	return e.Err.Error()
}

func (e *LifecycleOperationError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *LifecycleOperationError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "capsule_lifecycle_failed"
	}
	return e.Code
}

func NewLifecycleCapability(execute *ExecuteCapability, archive archiveApplyHandle) *LifecycleCapability {
	return newLifecycleCapability(execute, archiveCapabilityController{capability: archive}, nil)
}

func newLifecycleCapability(execute *ExecuteCapability, archive lifecycleArchive, healthSnapshot func() []capsuleruntime.WorkloadStatus) *LifecycleCapability {
	c := &LifecycleCapability{
		execute:        execute,
		archive:        archive,
		healthSnapshot: healthSnapshot,
		now:            time.Now,
		sleep:          sleepContext,
		pollInterval:   defaultLifecyclePollInterval,
	}
	if c.healthSnapshot == nil && execute != nil {
		c.healthSnapshot = execute.Workloads
	}
	return c
}

func (c *LifecycleCapability) Name() string {
	return LifecycleName
}

func (c *LifecycleCapability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(LifecycleReadRequest); !ok {
		return nil, lifecycleInvalid("expected capsule.LifecycleReadRequest")
	}
	if c == nil {
		return nil, lifecycleInvalid("missing capsule lifecycle capability")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return LifecycleReadResponse{Last: c.cloneLast()}, nil
}

func (c *LifecycleCapability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(LifecycleApplyRequest)
	if !ok {
		return nil, lifecycleInvalid("expected capsule.LifecycleApplyRequest")
	}
	if c == nil || c.execute == nil || c.archive == nil || c.execute.launcher == nil {
		return nil, lifecycleInvalid("missing capsule lifecycle dependency")
	}
	if err := applyReq.Validate(); err != nil {
		return nil, err
	}
	desired := *applyReq.Desired

	switch desired.Op {
	case lifecycleOpUpdate:
		return c.applyUpdate(ctx, desired)
	case lifecycleOpRestart:
		return c.applyRestart(ctx, desired)
	case lifecycleOpStop:
		return c.applyStop(ctx, desired)
	case lifecycleOpRemediate:
		return c.applyRemediate(ctx, desired)
	default:
		return nil, lifecycleInvalid("desired.op must be update, restart, stop, or remediate")
	}
}

func (c *LifecycleCapability) applyUpdate(ctx context.Context, desired LifecycleDesired) (transaction.Undo, error) {
	current, err := c.currentCapsule(ctx, desired.ID)
	if err != nil {
		return nil, err
	}
	targetEntry, targetManifest, err := normalizeLifecycleTarget(desired.ID, desired.Target)
	if err != nil {
		return nil, err
	}
	targetDesired := ExecuteDesired{ID: targetEntry.ID, Version: targetEntry.Version, Integrity: targetEntry.Integrity}
	if err := validateManifestMatchesRequest(targetManifest, targetDesired, targetEntry); err != nil {
		return nil, lifecycleInvalid(err.Error())
	}

	oldUnit, err := composeTransientUnit(current.manifest)
	if err != nil {
		return nil, err
	}
	newUnit, err := composeTransientUnit(targetManifest)
	if err != nil {
		return nil, err
	}
	if err := validateLifecycleOwnUnit(current.status.Unit, oldUnit, newUnit); err != nil {
		return nil, err
	}
	newChecks, err := healthChecksForUnit(targetManifest.HealthChecks, newUnit.Name)
	if err != nil {
		return nil, lifecycleInvalid(err.Error())
	}
	if _, err := healthChecksForUnit(current.manifest.HealthChecks, oldUnit.Name); err != nil {
		return nil, lifecycleInvalid(err.Error())
	}

	backupPlan, err := lifecycleBackupPlanFor(current.status, oldUnit)
	if err != nil {
		return nil, err
	}
	createResult, createUndo, err := c.archive.Create(ctx, backup.ArchiveCreateRequest{
		TargetPath:  backupPlan.targetPath,
		SourceRoots: &backupPlan.sourceRoots,
	})
	if err != nil {
		return nil, lifecycleOpError("capsule_lifecycle_backup_failed", err)
	}
	verify, err := c.archive.Verify(ctx, backup.ArchiveVerifyRequest{
		TargetPath: backupPlan.targetPath,
		BackupID:   createResult.BackupID,
	})
	if err != nil || !verify.OK {
		if createUndo != nil {
			err = errors.Join(err, createUndo.Undo(ctx))
		}
		if err == nil && verify.Failure != nil {
			err = fmt.Errorf("%s: %s", verify.Failure.Entry, verify.Failure.Reason)
		}
		if err == nil {
			err = errors.New("backup verify failed")
		}
		return nil, lifecycleOpError("capsule_lifecycle_backup_failed", err)
	}

	if stopped, err := c.stopManifest(ctx, current.manifest, current.status.Unit); err != nil {
		var rollbackErr error
		if stopped {
			rollbackErr = c.restartPrior(ctx, current)
		}
		return nil, lifecycleOpError("capsule_lifecycle_stop_failed", errors.Join(err, rollbackErr))
	}
	newUndo, newStatus, err := c.startManifest(ctx, targetEntry, targetManifest)
	if err != nil {
		restoreErr := c.restoreAndRestart(ctx, backupPlan, createResult.BackupID, current)
		return nil, lifecycleOpError("capsule_lifecycle_start_failed", errors.Join(err, restoreErr))
	}
	if err := c.waitHealthy(ctx, targetManifest.ID, newStatus.Unit, newChecks); err != nil {
		rollbackErr := errors.Join(newUndo.Undo(ctx), c.restoreAndRestart(ctx, backupPlan, createResult.BackupID, current))
		c.setLast(LifecycleStatus{
			Op:                    lifecycleOpUpdate,
			ID:                    desired.ID,
			FromVersion:           current.entry.Version,
			ToVersion:             targetEntry.Version,
			BackupID:              createResult.BackupID,
			RestoredBackupID:      createResult.BackupID,
			Health:                string(capsuleruntime.StatusOK),
			RollbackOnUnhealthyOK: rollbackErr == nil,
			Status:                lifecycleStatusOK,
			Reason:                "unhealthy",
		})
		return nil, lifecycleOpError("capsule_lifecycle_unhealthy", errors.Join(err, rollbackErr))
	}

	c.setLast(LifecycleStatus{
		Op:          lifecycleOpUpdate,
		ID:          desired.ID,
		FromVersion: current.entry.Version,
		ToVersion:   targetEntry.Version,
		BackupID:    createResult.BackupID,
		Health:      string(capsuleruntime.StatusOK),
		Status:      lifecycleStatusOK,
	})
	return lifecycleUpdateUndo{
		capability: c,
		newUndo:    newUndo,
		backupPlan: backupPlan,
		backupID:   createResult.BackupID,
		prior:      current,
	}, nil
}

func (c *LifecycleCapability) applyRestart(ctx context.Context, desired LifecycleDesired) (transaction.Undo, error) {
	current, err := c.currentCapsule(ctx, desired.ID)
	if err != nil {
		return nil, err
	}
	unit, err := composeTransientUnit(current.manifest)
	if err != nil {
		return nil, err
	}
	if err := validateLifecycleOwnUnit(current.status.Unit, unit); err != nil {
		return nil, err
	}
	checks, err := healthChecksForUnit(current.manifest.HealthChecks, unit.Name)
	if err != nil {
		return nil, lifecycleInvalid(err.Error())
	}

	if stopped, err := c.stopManifest(ctx, current.manifest, current.status.Unit); err != nil {
		var rollbackErr error
		if stopped {
			rollbackErr = c.restartPrior(ctx, current)
		}
		return nil, lifecycleOpError("capsule_lifecycle_stop_failed", errors.Join(err, rollbackErr))
	}
	newUndo, status, err := c.startManifest(ctx, current.entry, current.manifest)
	if err != nil {
		rollbackErr := c.restartPrior(ctx, current)
		return nil, lifecycleOpError("capsule_lifecycle_start_failed", errors.Join(err, rollbackErr))
	}
	if err := c.waitHealthy(ctx, current.entry.ID, status.Unit, checks); err != nil {
		rollbackErr := errors.Join(newUndo.Undo(ctx), c.restartPrior(ctx, current))
		return nil, lifecycleOpError("capsule_lifecycle_unhealthy", errors.Join(err, rollbackErr))
	}

	c.setLast(LifecycleStatus{
		Op:       lifecycleOpRestart,
		ID:       desired.ID,
		Health:   string(capsuleruntime.StatusOK),
		Restarts: 1,
		Status:   lifecycleStatusOK,
	})
	return lifecycleRestartUndo{capability: c, newUndo: newUndo, prior: current}, nil
}

func (c *LifecycleCapability) applyStop(ctx context.Context, desired LifecycleDesired) (transaction.Undo, error) {
	current, err := c.currentCapsule(ctx, desired.ID)
	if err != nil {
		return nil, err
	}
	unit, err := composeTransientUnit(current.manifest)
	if err != nil {
		return nil, err
	}
	if err := validateLifecycleOwnUnit(current.status.Unit, unit); err != nil {
		return nil, err
	}
	if stopped, err := c.stopManifest(ctx, current.manifest, current.status.Unit); err != nil {
		var rollbackErr error
		if stopped {
			rollbackErr = c.restartPrior(ctx, current)
		}
		return nil, lifecycleOpError("capsule_lifecycle_stop_failed", errors.Join(err, rollbackErr))
	}

	c.setLast(LifecycleStatus{
		Op:      lifecycleOpStop,
		ID:      desired.ID,
		Stopped: true,
		Status:  lifecycleStatusOK,
	})
	return lifecycleStartUndo{capability: c, entry: current.entry, manifest: current.manifest}, nil
}

func (c *LifecycleCapability) applyRemediate(ctx context.Context, desired LifecycleDesired) (transaction.Undo, error) {
	current, err := c.currentCapsule(ctx, desired.ID)
	if err != nil {
		return nil, err
	}
	policy := current.manifest.LifecyclePolicy.effectiveOnUnhealthy()
	switch policy {
	case lifecyclePolicyRestart:
		var undo transaction.Undo
		for attempt := 0; attempt < maxRemediationRestarts; attempt++ {
			if attempt > 0 {
				if err := c.sleep(ctx, time.Duration(attempt)*c.pollInterval); err != nil {
					return nil, err
				}
			}
			undo, err = c.applyRestart(ctx, desired)
			if err == nil {
				last := c.cloneLast()
				status := LifecycleStatus{
					Op:       lifecycleOpRemediate,
					ID:       desired.ID,
					Policy:   policy,
					Health:   string(capsuleruntime.StatusOK),
					Restarts: attempt + 1,
					Status:   lifecycleStatusOK,
				}
				if last != nil && last.Restarts > status.Restarts {
					status.Restarts = last.Restarts
				}
				c.setLast(status)
				return undo, nil
			}
		}
		c.setLast(LifecycleStatus{
			Op:       lifecycleOpRemediate,
			ID:       desired.ID,
			Policy:   policy,
			Restarts: maxRemediationRestarts,
			Status:   lifecycleStatusFailed,
			Reason:   "restart_failed",
		})
		return nil, lifecycleOpError("capsule_lifecycle_unhealthy", err)
	case lifecyclePolicyFail:
		unit, err := composeTransientUnit(current.manifest)
		if err != nil {
			return nil, err
		}
		if err := validateLifecycleOwnUnit(current.status.Unit, unit); err != nil {
			return nil, err
		}
		if stopped, err := c.stopManifest(ctx, current.manifest, current.status.Unit); err != nil {
			var rollbackErr error
			if stopped {
				rollbackErr = c.restartPrior(ctx, current)
			}
			return nil, lifecycleOpError("capsule_lifecycle_stop_failed", errors.Join(err, rollbackErr))
		}
		c.setLast(LifecycleStatus{
			Op:      lifecycleOpRemediate,
			ID:      desired.ID,
			Policy:  policy,
			Stopped: true,
			Status:  lifecycleStatusFailed,
			Reason:  "unhealthy",
		})
		return lifecycleStartUndo{capability: c, entry: current.entry, manifest: current.manifest}, nil
	default:
		return nil, lifecycleInvalid("manifest lifecycle policy is invalid")
	}
}

type lifecycleCurrent struct {
	status   ExecuteStatus
	entry    CapsuleEntry
	manifest ExecutionManifest
}

func (c *LifecycleCapability) currentCapsule(ctx context.Context, id string) (lifecycleCurrent, error) {
	if err := ctx.Err(); err != nil {
		return lifecycleCurrent{}, err
	}
	status, manifest, ok := c.execute.currentExecution()
	if !ok || status.ID != id {
		return lifecycleCurrent{}, &LifecycleInvalidRequestError{Reason: "unknown running capsule", Code: "capsule_lifecycle_unknown"}
	}
	if status.Unit != capsuleUnitName(id) {
		return lifecycleCurrent{}, &LifecycleInvalidRequestError{Reason: "running capsule unit is not the computed capsule unit", Code: "capsule_lifecycle_own_unit"}
	}
	if status.Version == "" {
		status.Version = manifest.Version
	}
	if status.Integrity == "" {
		status.Integrity = manifest.Integrity
	}
	entry := CapsuleEntry{
		ID:        status.ID,
		Version:   status.Version,
		Integrity: status.Integrity,
		State:     StateInstalled,
	}
	desired := ExecuteDesired{ID: entry.ID, Version: entry.Version, Integrity: entry.Integrity}
	if err := validateManifestMatchesRequest(manifest, desired, entry); err != nil {
		return lifecycleCurrent{}, lifecycleInvalid(err.Error())
	}
	return lifecycleCurrent{status: status, entry: entry, manifest: manifest}, nil
}

func (c *ExecuteCapability) currentExecution() (ExecuteStatus, ExecutionManifest, bool) {
	if c == nil {
		return ExecuteStatus{}, ExecutionManifest{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.last == nil || c.lastManifest == nil {
		return ExecuteStatus{}, ExecutionManifest{}, false
	}
	status := *c.last
	status.Volumes = cloneExecuteVolumeStatuses(c.last.Volumes)
	status.OCILimits = cloneOCILimitsStatus(c.last.OCILimits)
	status.Network = cloneExecuteNetworkStatus(c.last.Network)
	return status, cloneExecutionManifest(*c.lastManifest), true
}

func (c *LifecycleCapability) stopManifest(ctx context.Context, manifest ExecutionManifest, runningUnit string) (bool, error) {
	unit, err := composeTransientUnit(manifest)
	if err != nil {
		return false, err
	}
	if err := validateLifecycleOwnUnit(runningUnit, unit); err != nil {
		return false, err
	}
	if unit.NetNS != nil && c.execute.netns == nil {
		return false, lifecycleInvalid("missing capsule netns manager")
	}
	stopErr := stopAndUnlinkTransientUnit(ctx, c.execute.launcher, unit.Name)
	var teardownErr error
	if unit.NetNS != nil {
		teardownErr = c.execute.netns.Teardown(ctx, *unit.NetNS)
	}
	if err := errors.Join(stopErr, teardownErr); err != nil {
		return true, err
	}
	c.execute.stopWorkload(unit.Name)
	c.execute.clearLast(unit.Name)
	return true, nil
}

func (c *LifecycleCapability) startManifest(ctx context.Context, entry CapsuleEntry, manifest ExecutionManifest) (transaction.Undo, ExecuteStatus, error) {
	desired := ExecuteDesired{ID: entry.ID, Version: entry.Version, Integrity: entry.Integrity}
	return c.execute.startValidatedManifest(ctx, desired, entry, manifest)
}

func (c *LifecycleCapability) restoreAndRestart(ctx context.Context, plan lifecycleBackupPlan, backupID string, prior lifecycleCurrent) error {
	restoreRoots := append([]backup.ArchiveSourceRoot(nil), plan.sourceRoots...)
	_, _, restoreErr := c.archive.Restore(ctx, backup.ArchiveRestoreRequest{
		TargetPath:         plan.targetPath,
		BackupID:           backupID,
		DestinationRoot:    plan.restoreRoot,
		CompareSourceRoots: &restoreRoots,
	})
	_, _, startErr := c.startManifest(ctx, prior.entry, prior.manifest)
	return errors.Join(restoreErr, startErr)
}

func (c *LifecycleCapability) restartPrior(ctx context.Context, prior lifecycleCurrent) error {
	_, _, err := c.startManifest(ctx, prior.entry, prior.manifest)
	return err
}

func (c *LifecycleCapability) waitHealthy(ctx context.Context, id string, unit string, checks []capsuleruntime.Check) error {
	if c.healthSnapshot == nil {
		return lifecycleOpError("capsule_lifecycle_health_unavailable", errors.New("missing capsule health source"))
	}
	deadline := c.now().Add(lifecycleHealthGateDuration(checks))
	var last capsuleruntime.Status = capsuleruntime.StatusUnknown
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, workload := range c.healthSnapshot() {
			if workload.ID != id || workload.Unit != unit {
				continue
			}
			last = workload.Health
			if workload.Health == capsuleruntime.StatusOK && workload.Status == capsuleruntime.StatusOK {
				return nil
			}
		}
		if !c.now().Before(deadline) {
			return fmt.Errorf("capsule %s unit %s health gate timed out with %s", id, unit, last)
		}
		if err := c.sleep(ctx, c.pollInterval); err != nil {
			return err
		}
	}
}

func lifecycleHealthGateDuration(checks []capsuleruntime.Check) time.Duration {
	var gate time.Duration
	for _, check := range checks {
		interval := check.Interval
		if interval <= 0 {
			interval = time.Duration(check.IntervalSeconds) * time.Second
		}
		timeout := check.Timeout
		if timeout <= 0 {
			timeout = time.Duration(check.TimeoutSeconds) * time.Second
		}
		if candidate := interval + timeout; candidate > gate {
			gate = candidate
		}
	}
	if gate <= 0 {
		return time.Second
	}
	return gate
}

type lifecycleBackupPlan struct {
	targetPath  string
	sourceRoots []backup.ArchiveSourceRoot
	restoreRoot string
}

func lifecycleBackupPlanFor(status ExecuteStatus, unit transientUnit) (lifecycleBackupPlan, error) {
	volumes := status.Volumes
	if len(volumes) == 0 {
		volumes = volumeStatuses(unit.Volumes)
	}
	roots := make([]backup.ArchiveSourceRoot, 0, len(volumes))
	restoreRoot := ""
	for _, volume := range volumes {
		if volume.Name == "" || volume.Path == "" {
			return lifecycleBackupPlan{}, lifecycleInvalid("capsule volume status is incomplete")
		}
		cleaned := filepath.Clean(volume.Path)
		parent := filepath.Dir(cleaned)
		if restoreRoot == "" {
			restoreRoot = parent
		} else if restoreRoot != parent {
			return lifecycleBackupPlan{}, lifecycleInvalid("capsule volumes must share a restore root")
		}
		if filepath.Base(cleaned) != volume.Name {
			return lifecycleBackupPlan{}, lifecycleInvalid("capsule volume path must end with the volume name")
		}
		roots = append(roots, backup.ArchiveSourceRoot{Name: volume.Name, Path: cleaned})
	}
	if len(roots) == 0 {
		restoreRoot = filepath.Join(capsulestorage.VolumeMountRoot, unitNameSlug(status.ID))
		roots = append(roots, backup.ArchiveSourceRoot{Name: "capsule-state", Path: restoreRoot})
		restoreRoot = filepath.Dir(restoreRoot)
	}
	sort.Slice(roots, func(i, j int) bool {
		return roots[i].Name < roots[j].Name
	})
	return lifecycleBackupPlan{
		targetPath:  defaultLifecycleBackupTarget,
		sourceRoots: roots,
		restoreRoot: restoreRoot,
	}, nil
}

func normalizeLifecycleTarget(id string, target *LifecycleTarget) (CapsuleEntry, ExecutionManifest, error) {
	if target == nil {
		return CapsuleEntry{}, ExecutionManifest{}, lifecycleInvalid("desired.target is required for update")
	}
	entry := target.Entry
	if err := entry.Validate(); err != nil {
		return CapsuleEntry{}, ExecutionManifest{}, lifecycleInvalid(err.Error())
	}
	if entry.ID != id {
		return CapsuleEntry{}, ExecutionManifest{}, lifecycleInvalid("desired.target.entry.id must match desired.id")
	}
	if entry.State != StateInstalled {
		return CapsuleEntry{}, ExecutionManifest{}, lifecycleInvalid("desired.target.entry.state must be installed")
	}
	manifest := cloneExecutionManifest(target.Manifest)
	if manifest.baseDir == "" {
		manifest.baseDir = lifecycleVersionBaseDir(manifest.ID, manifest.Version)
	}
	if err := manifest.Validate(); err != nil {
		return CapsuleEntry{}, ExecutionManifest{}, lifecycleInvalid(err.Error())
	}
	if manifest.ID != id || manifest.Version != entry.Version || manifest.Integrity != entry.Integrity {
		return CapsuleEntry{}, ExecutionManifest{}, lifecycleInvalid("desired.target manifest does not match entry")
	}
	return entry, manifest, nil
}

func lifecycleVersionBaseDir(id string, version string) string {
	return path.Join(defaultCapsuleRoot, id+"-"+unitNameSlug(version))
}

func validateLifecycleOwnUnit(running string, units ...transientUnit) error {
	if running == "" {
		return lifecycleInvalid("running capsule unit is required")
	}
	for _, unit := range units {
		if unit.Name == "" || unit.Name != running {
			return &LifecycleInvalidRequestError{Reason: "lifecycle may only act on the capsule's computed unit", Code: "capsule_lifecycle_own_unit"}
		}
	}
	return nil
}

func (c *LifecycleCapability) cloneLast() *LifecycleStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.last == nil {
		return nil
	}
	out := *c.last
	return &out
}

func (c *LifecycleCapability) setLast(status LifecycleStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = &status
}

type lifecycleUpdateUndo struct {
	capability *LifecycleCapability
	newUndo    transaction.Undo
	backupPlan lifecycleBackupPlan
	backupID   string
	prior      lifecycleCurrent
}

func (u lifecycleUpdateUndo) Undo(ctx context.Context) error {
	if u.capability == nil {
		return lifecycleInvalid("missing capsule lifecycle capability")
	}
	var stopErr error
	if u.newUndo != nil {
		stopErr = u.newUndo.Undo(ctx)
	}
	return errors.Join(stopErr, u.capability.restoreAndRestart(ctx, u.backupPlan, u.backupID, u.prior))
}

type lifecycleRestartUndo struct {
	capability *LifecycleCapability
	newUndo    transaction.Undo
	prior      lifecycleCurrent
}

func (u lifecycleRestartUndo) Undo(ctx context.Context) error {
	if u.capability == nil {
		return lifecycleInvalid("missing capsule lifecycle capability")
	}
	var stopErr error
	if u.newUndo != nil {
		stopErr = u.newUndo.Undo(ctx)
	}
	_, _, startErr := u.capability.startManifest(ctx, u.prior.entry, u.prior.manifest)
	return errors.Join(stopErr, startErr)
}

type lifecycleStartUndo struct {
	capability *LifecycleCapability
	entry      CapsuleEntry
	manifest   ExecutionManifest
}

func (u lifecycleStartUndo) Undo(ctx context.Context) error {
	if u.capability == nil {
		return lifecycleInvalid("missing capsule lifecycle capability")
	}
	_, _, err := u.capability.startManifest(ctx, u.entry, u.manifest)
	return err
}

type archiveCapabilityController struct {
	capability archiveApplyHandle
}

func (c archiveCapabilityController) Create(ctx context.Context, req backup.ArchiveCreateRequest) (backup.ArchiveCreateResult, transaction.Undo, error) {
	if c.capability == nil {
		return backup.ArchiveCreateResult{}, nil, errors.New("missing backup archive capability")
	}
	undo, err := c.capability.Apply(ctx, backup.ArchiveApplyRequest{
		Op:     backup.ArchiveOperationCreate,
		Create: &req,
	})
	if err != nil {
		return backup.ArchiveCreateResult{}, nil, err
	}
	status, err := c.readLast(ctx)
	if err != nil {
		return backup.ArchiveCreateResult{}, nil, err
	}
	if status.Op != backup.ArchiveOperationCreate || !status.Created || status.BackupID == "" {
		return backup.ArchiveCreateResult{}, nil, errors.New("backup archive create did not record a created backup")
	}
	return backup.ArchiveCreateResult{BackupID: status.BackupID, Files: status.Files}, undo, nil
}

func (c archiveCapabilityController) Verify(ctx context.Context, req backup.ArchiveVerifyRequest) (backup.ArchiveVerifyResult, error) {
	if c.capability == nil {
		return backup.ArchiveVerifyResult{}, errors.New("missing backup archive capability")
	}
	if _, err := c.capability.Apply(ctx, backup.ArchiveApplyRequest{
		Op:     backup.ArchiveOperationVerify,
		Verify: &req,
	}); err != nil {
		return backup.ArchiveVerifyResult{}, err
	}
	status, err := c.readLast(ctx)
	if err != nil {
		return backup.ArchiveVerifyResult{}, err
	}
	return backup.ArchiveVerifyResult{
		OK:       status.Op == backup.ArchiveOperationVerify && status.Verified && status.BackupID == req.BackupID,
		BackupID: status.BackupID,
		Files:    status.Files,
		Failure:  status.Failure,
	}, nil
}

func (c archiveCapabilityController) Restore(ctx context.Context, req backup.ArchiveRestoreRequest) (backup.ArchiveRestoreResult, transaction.Undo, error) {
	if c.capability == nil {
		return backup.ArchiveRestoreResult{}, nil, errors.New("missing backup archive capability")
	}
	undo, err := c.capability.Apply(ctx, backup.ArchiveApplyRequest{
		Op:      backup.ArchiveOperationRestore,
		Restore: &req,
	})
	if err != nil {
		return backup.ArchiveRestoreResult{}, nil, err
	}
	status, err := c.readLast(ctx)
	if err != nil {
		return backup.ArchiveRestoreResult{}, nil, err
	}
	if status.Op != backup.ArchiveOperationRestore || !status.Restored || status.BackupID != req.BackupID {
		return backup.ArchiveRestoreResult{}, nil, errors.New("backup archive restore did not record a restored backup")
	}
	return backup.ArchiveRestoreResult{BackupID: status.BackupID, Files: status.Files, Restored: status.Restored}, undo, nil
}

func (c archiveCapabilityController) readLast(ctx context.Context) (*backup.ArchiveStatus, error) {
	response, err := c.capability.Handle(ctx, backup.ArchiveReadRequest{})
	if err != nil {
		return nil, err
	}
	read, ok := response.(backup.ArchiveReadResponse)
	if !ok || read.Last == nil {
		return nil, errors.New("backup archive status is missing")
	}
	status := *read.Last
	if read.Last.Failure != nil {
		failure := *read.Last.Failure
		status.Failure = &failure
	}
	return &status, nil
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func lifecycleInvalid(reason string) *LifecycleInvalidRequestError {
	return &LifecycleInvalidRequestError{Reason: reason}
}

func lifecycleOpError(code string, err error) *LifecycleOperationError {
	return &LifecycleOperationError{Code: code, Err: err}
}

var (
	lifecycleApplyRequestFields = map[string]struct{}{
		"desired": {},
	}
	lifecycleDesiredFields = map[string]struct{}{
		"id":     {},
		"op":     {},
		"target": {},
	}
	lifecycleTargetFields = map[string]struct{}{
		"entry":    {},
		"manifest": {},
	}
)
