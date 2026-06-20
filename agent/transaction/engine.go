package transaction

import (
	"context"
	"errors"
	"fmt"

	"github.com/vita/agent/capabilities"
)

type Plan []Operation

type Operation struct {
	Capability string
	Request    capabilities.TypedRequest
}

type Undo interface {
	Undo(context.Context) error
}

type TxCapability interface {
	capabilities.Capability
	Apply(context.Context, capabilities.TypedRequest) (Undo, error)
}

type HealthCheck func(context.Context) error

type Outcome string

const (
	OutcomeCommitted  Outcome = "committed"
	OutcomeRolledBack Outcome = "rolledBack"
	OutcomeRejected   Outcome = "rejected"
)

type AppliedOperation struct {
	Index      int
	Capability string
}

type RolledBackOperation struct {
	Index      int
	Capability string
}

type Result struct {
	Outcome        Outcome
	Applied        []AppliedOperation
	RolledBack     []RolledBackOperation
	Err            error
	RollbackErrors []RollbackError
}

func (r Result) Committed() bool {
	return r.Outcome == OutcomeCommitted
}

func (r Result) WasRolledBack() bool {
	return r.Outcome == OutcomeRolledBack
}

func (r Result) Rejected() bool {
	return r.Outcome == OutcomeRejected
}

type PreconditionReason string

const (
	PreconditionUnknownCapability          PreconditionReason = "unknownCapability"
	PreconditionNonTransactionalCapability PreconditionReason = "nonTransactionalCapability"
	PreconditionNilRequest                 PreconditionReason = "nilRequest"
)

var (
	ErrNonTransactionalCapability = errors.New("capability is not transactional")
	ErrNilUndo                    = errors.New("transactional capability returned nil undo")
)

type PreconditionError struct {
	Index      int
	Capability string
	Reason     PreconditionReason
	Err        error
}

func (e *PreconditionError) Error() string {
	return fmt.Sprintf("transaction precondition failed for operation %d capability %q: %s", e.Index, e.Capability, e.Reason)
}

func (e *PreconditionError) Unwrap() error {
	return e.Err
}

type ApplyError struct {
	Index      int
	Capability string
	Err        error
}

func (e *ApplyError) Error() string {
	return fmt.Sprintf("apply operation %d capability %q: %v", e.Index, e.Capability, e.Err)
}

func (e *ApplyError) Unwrap() error {
	return e.Err
}

type HealthCheckError struct {
	Err error
}

func (e *HealthCheckError) Error() string {
	return fmt.Sprintf("post-apply health check failed: %v", e.Err)
}

func (e *HealthCheckError) Unwrap() error {
	return e.Err
}

type RollbackError struct {
	Index      int
	Capability string
	Err        error
}

func (e RollbackError) Error() string {
	return fmt.Sprintf("rollback operation %d capability %q: %v", e.Index, e.Capability, e.Err)
}

func (e RollbackError) Unwrap() error {
	return e.Err
}

type plannedOperation struct {
	operation  Operation
	capability TxCapability
}

type undoRecord struct {
	applied AppliedOperation
	undo    Undo
}

func Apply(ctx context.Context, reg *capabilities.Registry, plan Plan, health HealthCheck) Result {
	planned, err := preflight(reg, plan)
	if err != nil {
		return Result{
			Outcome: OutcomeRejected,
			Err:     err,
		}
	}

	applied := make([]AppliedOperation, 0, len(planned))
	undos := make([]undoRecord, 0, len(planned))

	for i, op := range planned {
		undo, err := op.capability.Apply(ctx, op.operation.Request)
		if err != nil {
			resultErr := &ApplyError{Index: i, Capability: op.operation.Capability, Err: err}
			rolledBack, rollbackErrors := rollback(ctx, undos)
			return Result{
				Outcome:        OutcomeRolledBack,
				Applied:        applied,
				RolledBack:     rolledBack,
				Err:            resultErr,
				RollbackErrors: rollbackErrors,
			}
		}
		if undo == nil {
			resultErr := &ApplyError{Index: i, Capability: op.operation.Capability, Err: ErrNilUndo}
			rolledBack, rollbackErrors := rollback(ctx, undos)
			return Result{
				Outcome:        OutcomeRolledBack,
				Applied:        applied,
				RolledBack:     rolledBack,
				Err:            resultErr,
				RollbackErrors: rollbackErrors,
			}
		}

		appliedOp := AppliedOperation{Index: i, Capability: op.operation.Capability}
		applied = append(applied, appliedOp)
		undos = append(undos, undoRecord{applied: appliedOp, undo: undo})
	}

	if health != nil {
		if err := health(ctx); err != nil {
			resultErr := &HealthCheckError{Err: err}
			rolledBack, rollbackErrors := rollback(ctx, undos)
			return Result{
				Outcome:        OutcomeRolledBack,
				Applied:        applied,
				RolledBack:     rolledBack,
				Err:            resultErr,
				RollbackErrors: rollbackErrors,
			}
		}
	}

	return Result{
		Outcome: OutcomeCommitted,
		Applied: applied,
	}
}

func preflight(reg *capabilities.Registry, plan Plan) ([]plannedOperation, error) {
	planned := make([]plannedOperation, 0, len(plan))
	for i, op := range plan {
		if op.Request == nil {
			return nil, &PreconditionError{
				Index:      i,
				Capability: op.Capability,
				Reason:     PreconditionNilRequest,
				Err:        capabilities.ErrNilRequest,
			}
		}

		capability, ok := reg.Lookup(op.Capability)
		if !ok {
			return nil, &PreconditionError{
				Index:      i,
				Capability: op.Capability,
				Reason:     PreconditionUnknownCapability,
				Err:        &capabilities.UnknownCapabilityError{Name: op.Capability},
			}
		}

		txCapability, ok := capability.(TxCapability)
		if !ok {
			return nil, &PreconditionError{
				Index:      i,
				Capability: op.Capability,
				Reason:     PreconditionNonTransactionalCapability,
				Err:        ErrNonTransactionalCapability,
			}
		}

		planned = append(planned, plannedOperation{
			operation:  op,
			capability: txCapability,
		})
	}

	return planned, nil
}

func rollback(ctx context.Context, undos []undoRecord) ([]RolledBackOperation, []RollbackError) {
	rolledBack := make([]RolledBackOperation, 0, len(undos))
	rollbackErrors := make([]RollbackError, 0)

	for i := len(undos) - 1; i >= 0; i-- {
		record := undos[i]
		if err := record.undo.Undo(ctx); err != nil {
			rollbackErrors = append(rollbackErrors, RollbackError{
				Index:      record.applied.Index,
				Capability: record.applied.Capability,
				Err:        err,
			})
			continue
		}

		rolledBack = append(rolledBack, RolledBackOperation{
			Index:      record.applied.Index,
			Capability: record.applied.Capability,
		})
	}

	return rolledBack, rollbackErrors
}
