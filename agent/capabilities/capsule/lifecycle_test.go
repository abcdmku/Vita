package capsule

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/vita/agent/capabilities/backup"
	capsuleruntime "github.com/vita/agent/internal/capsule-runtime"
	capsulestorage "github.com/vita/agent/storage/capsules"
	"github.com/vita/agent/transaction"
)

func TestLifecycleUpdateBacksUpBeforeStopStartAndRecordsUndo(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	next := lifecycleEntry("2.0.0")
	calls := []string{}
	launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
	manifest := lifecycleManifest(t, entry, lifecyclePolicyFail)
	execute := lifecycleExecute(t, entry, manifest, launcher)
	archive := &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}
	lifecycle := lifecycleCapabilityForTest(execute, archive, func() []capsuleruntime.WorkloadStatus {
		return []capsuleruntime.WorkloadStatus{{
			ID:     next.ID,
			Unit:   capsuleUnitName(next.ID),
			Status: capsuleruntime.StatusOK,
			Health: capsuleruntime.StatusOK,
		}}
	})
	calls = nil
	launcher.calls = &calls
	archive.calls = &calls

	undo, err := lifecycle.Apply(ctx, lifecycleUpdateRequest(next, lifecycleManifest(t, next, lifecyclePolicyFail)))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantOrder := []string{
		"backup.create",
		"backup.verify",
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
		"start:" + capsuleUnitName(entry.ID),
	}
	if !reflect.DeepEqual(calls, wantOrder) {
		t.Fatalf("call order = %#v, want %#v", calls, wantOrder)
	}
	if len(archive.creates) != 1 {
		t.Fatalf("backup creates = %d, want 1", len(archive.creates))
	}
	if roots := *archive.creates[0].SourceRoots; len(roots) != 1 || filepath.ToSlash(roots[0].Path) != lifecycleVolumePath(entry.ID) {
		t.Fatalf("backup source roots = %#v, want capsule volume path", archive.creates[0].SourceRoots)
	}
	last := lifecycle.cloneLast()
	if last == nil || last.BackupID != lifecycleBackupID || last.FromVersion != "1.0.0" || last.ToVersion != "2.0.0" || last.Health != "OK" {
		t.Fatalf("last lifecycle status = %#v, want committed update", last)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if len(archive.restores) != 1 || archive.restores[0].BackupID != lifecycleBackupID {
		t.Fatalf("restore requests = %#v, want backup %s", archive.restores, lifecycleBackupID)
	}
	status, _, ok := execute.currentExecution()
	if !ok || status.Version != entry.Version {
		t.Fatalf("current execution after undo = %#v ok=%v, want prior version", status, ok)
	}
}

func TestLifecycleUpdateRollsBackMeasuredUnhealthyNewVersion(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	next := lifecycleEntry("2.0.0")
	calls := []string{}
	launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
	execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
	archive := &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}
	lifecycle := lifecycleCapabilityForTest(execute, archive, func() []capsuleruntime.WorkloadStatus {
		return []capsuleruntime.WorkloadStatus{{
			ID:     next.ID,
			Unit:   capsuleUnitName(next.ID),
			Status: capsuleruntime.StatusDown,
			Health: capsuleruntime.StatusUnhealthy,
		}}
	})
	calls = nil
	launcher.calls = &calls
	archive.calls = &calls

	undo, err := lifecycle.Apply(ctx, lifecycleUpdateRequest(next, lifecycleManifest(t, next, lifecyclePolicyFail)))
	if err == nil {
		t.Fatal("Apply returned nil error, want unhealthy rejection")
	}
	if undo != nil {
		t.Fatalf("Apply returned undo %#v, want nil on rejected unhealthy update", undo)
	}
	var opErr *LifecycleOperationError
	if !errors.As(err, &opErr) || opErr.ApplyErrorCode() != "capsule_lifecycle_unhealthy" {
		t.Fatalf("Apply error = %T %v, want capsule_lifecycle_unhealthy", err, err)
	}

	wantOrder := []string{
		"backup.create",
		"backup.verify",
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
		"start:" + capsuleUnitName(entry.ID),
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
		"backup.restore",
		"start:" + capsuleUnitName(entry.ID),
	}
	if !reflect.DeepEqual(calls, wantOrder) {
		t.Fatalf("call order = %#v, want %#v", calls, wantOrder)
	}
	if len(archive.restores) != 1 || archive.restores[0].BackupID != lifecycleBackupID {
		t.Fatalf("restore requests = %#v, want same backup id", archive.restores)
	}
	last := lifecycle.cloneLast()
	if last == nil || !last.RollbackOnUnhealthyOK || last.RestoredBackupID != lifecycleBackupID || last.Status != lifecycleStatusOK {
		t.Fatalf("last lifecycle status = %#v, want rollback-on-unhealthy OK", last)
	}
	status, _, ok := execute.currentExecution()
	if !ok || status.Version != entry.Version {
		t.Fatalf("current execution = %#v ok=%v, want prior version restarted", status, ok)
	}
}

func TestLifecycleUpdateRequiresMeasuredSupervisorStatusWithoutChecks(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	next := lifecycleEntry("2.0.0")
	targetManifest := lifecycleManifest(t, next, lifecyclePolicyFail)
	targetManifest.HealthChecks = nil
	calls := []string{}
	launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
	execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
	archive := &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}
	lifecycle := lifecycleCapabilityForTest(execute, archive, func() []capsuleruntime.WorkloadStatus {
		return []capsuleruntime.WorkloadStatus{{
			ID:     next.ID,
			Unit:   capsuleUnitName(next.ID),
			Status: capsuleruntime.StatusUnknown,
			Health: capsuleruntime.StatusUnknown,
		}}
	})
	lifecycle.pollInterval = time.Second
	calls = nil
	launcher.calls = &calls
	archive.calls = &calls

	undo, err := lifecycle.Apply(ctx, lifecycleUpdateRequest(next, targetManifest))
	if err == nil {
		t.Fatal("Apply returned nil error, want measured health rejection")
	}
	if undo != nil {
		t.Fatalf("Apply returned undo %#v, want nil on rejected unmeasured update", undo)
	}
	var opErr *LifecycleOperationError
	if !errors.As(err, &opErr) || opErr.ApplyErrorCode() != "capsule_lifecycle_unhealthy" {
		t.Fatalf("Apply error = %T %v, want capsule_lifecycle_unhealthy", err, err)
	}

	wantOrder := []string{
		"backup.create",
		"backup.verify",
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
		"start:" + capsuleUnitName(entry.ID),
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
		"backup.restore",
		"start:" + capsuleUnitName(entry.ID),
	}
	if !reflect.DeepEqual(calls, wantOrder) {
		t.Fatalf("call order = %#v, want %#v", calls, wantOrder)
	}
	if len(archive.restores) != 1 || archive.restores[0].BackupID != lifecycleBackupID {
		t.Fatalf("restore requests = %#v, want same backup id", archive.restores)
	}
	status, _, ok := execute.currentExecution()
	if !ok || status.Version != entry.Version {
		t.Fatalf("current execution = %#v ok=%v, want prior version restarted", status, ok)
	}
}

func TestLifecycleUpdateBackupFailureAbortsBeforeStopStart(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	next := lifecycleEntry("2.0.0")
	calls := []string{}
	launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
	execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
	archive := &recordingLifecycleArchive{
		calls:     &calls,
		backupID:  lifecycleBackupID,
		verifyErr: errors.New("verify failed"),
	}
	lifecycle := lifecycleCapabilityForTest(execute, archive, nil)
	calls = nil
	launcher.calls = &calls
	archive.calls = &calls

	undo, err := lifecycle.Apply(ctx, lifecycleUpdateRequest(next, lifecycleManifest(t, next, lifecyclePolicyFail)))
	if err == nil {
		t.Fatal("Apply returned nil error, want backup failure")
	}
	if undo != nil {
		t.Fatalf("Apply returned undo %#v, want nil", undo)
	}
	if !reflect.DeepEqual(calls, []string{"backup.create", "backup.verify", "backup.undo"}) {
		t.Fatalf("call order = %#v, want backup only", calls)
	}
	if len(launcher.stops) != 0 || len(launcher.starts) != 1 {
		t.Fatalf("launcher stops=%v starts=%d, want old unit still running and no update start", launcher.stops, len(launcher.starts))
	}
	status, _, ok := execute.currentExecution()
	if !ok || status.Version != entry.Version {
		t.Fatalf("current execution = %#v ok=%v, want old version", status, ok)
	}
}

func TestLifecycleUpdateStartFailureRestoresBackupAndPriorRunningInstance(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	next := lifecycleEntry("2.0.0")
	calls := []string{}
	launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
	execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
	archive := &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}
	lifecycle := lifecycleCapabilityForTest(execute, archive, func() []capsuleruntime.WorkloadStatus {
		return []capsuleruntime.WorkloadStatus{{
			ID:     next.ID,
			Unit:   capsuleUnitName(next.ID),
			Status: capsuleruntime.StatusOK,
			Health: capsuleruntime.StatusOK,
		}}
	})
	calls = nil
	launcher.calls = &calls
	archive.calls = &calls
	launcher.startErrs = []error{errors.New("new version start failed"), nil}

	undo, err := lifecycle.Apply(ctx, lifecycleUpdateRequest(next, lifecycleManifest(t, next, lifecyclePolicyFail)))
	if err == nil {
		t.Fatal("Apply returned nil error, want start failure")
	}
	if undo != nil {
		t.Fatalf("Apply returned undo %#v, want nil on rejected update", undo)
	}
	var opErr *LifecycleOperationError
	if !errors.As(err, &opErr) || opErr.ApplyErrorCode() != "capsule_lifecycle_start_failed" {
		t.Fatalf("Apply error = %T %v, want capsule_lifecycle_start_failed", err, err)
	}

	wantOrder := []string{
		"backup.create",
		"backup.verify",
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
		"start:" + capsuleUnitName(entry.ID),
		"backup.restore",
		"start:" + capsuleUnitName(entry.ID),
	}
	if !reflect.DeepEqual(calls, wantOrder) {
		t.Fatalf("call order = %#v, want %#v", calls, wantOrder)
	}
	if len(archive.restores) != 1 || archive.restores[0].BackupID != lifecycleBackupID {
		t.Fatalf("restore requests = %#v, want same backup id", archive.restores)
	}
	status, _, ok := execute.currentExecution()
	if !ok || status.Version != entry.Version {
		t.Fatalf("current execution = %#v ok=%v, want prior version restarted", status, ok)
	}
}

func TestLifecycleRejectsFailClosedWithoutSideEffects(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	next := lifecycleEntry("2.0.0")
	calls := []string{}
	launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
	execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
	archive := &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}
	lifecycle := lifecycleCapabilityForTest(execute, archive, nil)
	calls = nil
	launcher.calls = &calls
	archive.calls = &calls

	undo, err := lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: "delete", ID: entry.ID}})
	assertLifecycleRejected(t, undo, err, "capsule_lifecycle_rejected")
	if len(calls) != 0 {
		t.Fatalf("calls after invalid op = %#v, want none", calls)
	}

	undo, err = lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpRestart, ID: "local.missing.capsule"}})
	assertLifecycleRejected(t, undo, err, "capsule_lifecycle_unknown")
	if len(calls) != 0 {
		t.Fatalf("calls after unknown id = %#v, want none", calls)
	}

	unsafeManifest := lifecycleManifest(t, next, lifecyclePolicyFail)
	unsafeManifest.HealthChecks = []capsuleruntime.Check{lifecycleHealthCheckForUnit("ssh.service")}
	undo, err = lifecycle.Apply(ctx, lifecycleUpdateRequest(next, unsafeManifest))
	assertLifecycleRejected(t, undo, err, "capsule_lifecycle_rejected")
	if len(calls) != 0 || len(archive.creates) != 0 {
		t.Fatalf("calls=%#v creates=%d, want no side effects for invalid manifest", calls, len(archive.creates))
	}
}

func TestLifecycleRestartAndStopRecordRestoringUndos(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	calls := []string{}
	launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
	execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
	lifecycle := lifecycleCapabilityForTest(execute, &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}, func() []capsuleruntime.WorkloadStatus {
		return []capsuleruntime.WorkloadStatus{{
			ID:     entry.ID,
			Unit:   capsuleUnitName(entry.ID),
			Status: capsuleruntime.StatusOK,
			Health: capsuleruntime.StatusOK,
		}}
	})
	calls = nil
	launcher.calls = &calls

	restartUndo, err := lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpRestart, ID: entry.ID}})
	if err != nil {
		t.Fatalf("restart Apply returned error: %v", err)
	}
	if !reflect.DeepEqual(calls, []string{
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
		"start:" + capsuleUnitName(entry.ID),
	}) {
		t.Fatalf("restart calls = %#v, want stop/reset/start", calls)
	}
	if restartUndo == nil {
		t.Fatal("restart returned nil undo")
	}
	calls = nil
	if err := restartUndo.Undo(ctx); err != nil {
		t.Fatalf("restart Undo returned error: %v", err)
	}
	if !reflect.DeepEqual(calls, []string{
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
		"start:" + capsuleUnitName(entry.ID),
	}) {
		t.Fatalf("restart undo calls = %#v, want stop/reset/start", calls)
	}

	calls = nil
	stopUndo, err := lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpStop, ID: entry.ID}})
	if err != nil {
		t.Fatalf("stop Apply returned error: %v", err)
	}
	if !reflect.DeepEqual(calls, []string{
		"stop:" + capsuleUnitName(entry.ID),
		"reset:" + capsuleUnitName(entry.ID),
	}) {
		t.Fatalf("stop calls = %#v, want stop/reset", calls)
	}
	if stopUndo == nil {
		t.Fatal("stop returned nil undo")
	}
	calls = nil
	if err := stopUndo.Undo(ctx); err != nil {
		t.Fatalf("stop Undo returned error: %v", err)
	}
	if !reflect.DeepEqual(calls, []string{"start:" + capsuleUnitName(entry.ID)}) {
		t.Fatalf("stop undo calls = %#v, want start", calls)
	}
}

func TestLifecycleRestartFailureRestoresPriorRunningInstance(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()

	t.Run("start failure", func(t *testing.T) {
		calls := []string{}
		launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
		execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
		lifecycle := lifecycleCapabilityForTest(execute, &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}, func() []capsuleruntime.WorkloadStatus {
			return []capsuleruntime.WorkloadStatus{{
				ID:     entry.ID,
				Unit:   capsuleUnitName(entry.ID),
				Status: capsuleruntime.StatusOK,
				Health: capsuleruntime.StatusOK,
			}}
		})
		calls = nil
		launcher.calls = &calls
		launcher.startErrs = []error{errors.New("restart start failed"), nil}

		undo, err := lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpRestart, ID: entry.ID}})
		if err == nil {
			t.Fatal("restart Apply returned nil error, want start failure")
		}
		if undo != nil {
			t.Fatalf("restart Apply returned undo %#v, want nil on rejected restart", undo)
		}
		var opErr *LifecycleOperationError
		if !errors.As(err, &opErr) || opErr.ApplyErrorCode() != "capsule_lifecycle_start_failed" {
			t.Fatalf("Apply error = %T %v, want capsule_lifecycle_start_failed", err, err)
		}
		if !reflect.DeepEqual(calls, []string{
			"stop:" + capsuleUnitName(entry.ID),
			"reset:" + capsuleUnitName(entry.ID),
			"start:" + capsuleUnitName(entry.ID),
			"start:" + capsuleUnitName(entry.ID),
		}) {
			t.Fatalf("restart calls = %#v, want stop/reset/start/restore-start", calls)
		}
		status, _, ok := execute.currentExecution()
		if !ok || status.Version != entry.Version {
			t.Fatalf("current execution = %#v ok=%v, want prior version restarted", status, ok)
		}
	})

	t.Run("health gate failure", func(t *testing.T) {
		calls := []string{}
		launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
		execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
		lifecycle := lifecycleCapabilityForTest(execute, &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}, func() []capsuleruntime.WorkloadStatus {
			return []capsuleruntime.WorkloadStatus{{
				ID:     entry.ID,
				Unit:   capsuleUnitName(entry.ID),
				Status: capsuleruntime.StatusDown,
				Health: capsuleruntime.StatusUnhealthy,
			}}
		})
		calls = nil
		launcher.calls = &calls

		undo, err := lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpRestart, ID: entry.ID}})
		if err == nil {
			t.Fatal("restart Apply returned nil error, want health failure")
		}
		if undo != nil {
			t.Fatalf("restart Apply returned undo %#v, want nil on rejected restart", undo)
		}
		var opErr *LifecycleOperationError
		if !errors.As(err, &opErr) || opErr.ApplyErrorCode() != "capsule_lifecycle_unhealthy" {
			t.Fatalf("Apply error = %T %v, want capsule_lifecycle_unhealthy", err, err)
		}
		if !reflect.DeepEqual(calls, []string{
			"stop:" + capsuleUnitName(entry.ID),
			"reset:" + capsuleUnitName(entry.ID),
			"start:" + capsuleUnitName(entry.ID),
			"stop:" + capsuleUnitName(entry.ID),
			"reset:" + capsuleUnitName(entry.ID),
			"start:" + capsuleUnitName(entry.ID),
		}) {
			t.Fatalf("restart calls = %#v, want failed restart stopped and prior restarted", calls)
		}
		status, _, ok := execute.currentExecution()
		if !ok || status.Version != entry.Version {
			t.Fatalf("current execution = %#v ok=%v, want prior version restarted", status, ok)
		}
	})
}

func TestLifecycleStopTeardownFailureRestoresPriorRunningInstance(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	next := lifecycleEntry("2.0.0")

	tests := []struct {
		name    string
		policy  string
		request LifecycleApplyRequest
		archive bool
	}{
		{
			name:    "update",
			policy:  lifecyclePolicyFail,
			request: lifecycleUpdateRequest(next, lifecycleNetworkManifest(t, next, lifecyclePolicyFail)),
			archive: true,
		},
		{
			name:    "restart",
			policy:  lifecyclePolicyFail,
			request: LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpRestart, ID: entry.ID}},
		},
		{
			name:    "stop",
			policy:  lifecyclePolicyFail,
			request: LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpStop, ID: entry.ID}},
		},
		{
			name:    "remediate fail",
			policy:  lifecyclePolicyFail,
			request: LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpRemediate, ID: entry.ID}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := []string{}
			launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
			netns := &recordingNetnsManager{tearErr: errors.New("teardown failed")}
			manifest := lifecycleNetworkManifest(t, entry, tt.policy)
			execute := lifecycleNetworkExecute(t, entry, manifest, launcher, netns)
			archive := &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}
			lifecycle := lifecycleCapabilityForTest(execute, archive, func() []capsuleruntime.WorkloadStatus {
				return []capsuleruntime.WorkloadStatus{{
					ID:     entry.ID,
					Unit:   capsuleUnitName(entry.ID),
					Status: capsuleruntime.StatusOK,
					Health: capsuleruntime.StatusOK,
				}}
			})
			calls = nil
			launcher.calls = &calls
			archive.calls = &calls

			undo, err := lifecycle.Apply(ctx, tt.request)
			if err == nil {
				t.Fatal("Apply returned nil error, want teardown failure")
			}
			if undo != nil {
				t.Fatalf("Apply returned undo %#v, want nil on rejected lifecycle op", undo)
			}
			var opErr *LifecycleOperationError
			if !errors.As(err, &opErr) || opErr.ApplyErrorCode() != "capsule_lifecycle_stop_failed" {
				t.Fatalf("Apply error = %T %v, want capsule_lifecycle_stop_failed", err, err)
			}

			wantOrder := []string{
				"stop:" + capsuleUnitName(entry.ID),
				"reset:" + capsuleUnitName(entry.ID),
				"start:" + capsuleUnitName(entry.ID),
			}
			if tt.archive {
				wantOrder = append([]string{"backup.create", "backup.verify"}, wantOrder...)
			}
			if !reflect.DeepEqual(calls, wantOrder) {
				t.Fatalf("call order = %#v, want %#v", calls, wantOrder)
			}
			status, _, ok := execute.currentExecution()
			if !ok || status.Version != entry.Version {
				t.Fatalf("current execution = %#v ok=%v, want prior version restarted", status, ok)
			}
		})
	}
}

func TestLifecycleRemediateHonorsManifestPolicy(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	t.Run("restart", func(t *testing.T) {
		calls := []string{}
		launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
		execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyRestart), launcher)
		lifecycle := lifecycleCapabilityForTest(execute, &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}, func() []capsuleruntime.WorkloadStatus {
			return []capsuleruntime.WorkloadStatus{{
				ID:     entry.ID,
				Unit:   capsuleUnitName(entry.ID),
				Status: capsuleruntime.StatusOK,
				Health: capsuleruntime.StatusOK,
			}}
		})
		calls = nil
		launcher.calls = &calls

		undo, err := lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpRemediate, ID: entry.ID}})
		if err != nil {
			t.Fatalf("remediate restart returned error: %v", err)
		}
		if undo == nil {
			t.Fatal("remediate restart returned nil undo")
		}
		if !reflect.DeepEqual(calls, []string{
			"stop:" + capsuleUnitName(entry.ID),
			"reset:" + capsuleUnitName(entry.ID),
			"start:" + capsuleUnitName(entry.ID),
		}) {
			t.Fatalf("remediate restart calls = %#v, want stop/reset/start", calls)
		}
		last := lifecycle.cloneLast()
		if last == nil || last.Op != lifecycleOpRemediate || last.Policy != lifecyclePolicyRestart || last.Restarts != 1 || last.Status != lifecycleStatusOK {
			t.Fatalf("last = %#v, want restart remediation OK", last)
		}
	})

	t.Run("default fail stops", func(t *testing.T) {
		calls := []string{}
		launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
		manifest := lifecycleManifest(t, entry, "")
		execute := lifecycleExecute(t, entry, manifest, launcher)
		lifecycle := lifecycleCapabilityForTest(execute, &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}, nil)
		calls = nil
		launcher.calls = &calls

		undo, err := lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpRemediate, ID: entry.ID}})
		if err != nil {
			t.Fatalf("remediate fail returned error: %v", err)
		}
		if undo == nil {
			t.Fatal("remediate fail returned nil undo")
		}
		if !reflect.DeepEqual(calls, []string{
			"stop:" + capsuleUnitName(entry.ID),
			"reset:" + capsuleUnitName(entry.ID),
		}) {
			t.Fatalf("remediate fail calls = %#v, want stop/reset", calls)
		}
		last := lifecycle.cloneLast()
		if last == nil || last.Policy != lifecyclePolicyFail || !last.Stopped || last.Status != lifecycleStatusFailed {
			t.Fatalf("last = %#v, want fail policy stopped status", last)
		}
	})
}

func TestLifecycleRejectsNonComputedRunningUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	calls := []string{}
	launcher := &orderedLifecycleLauncher{calls: &calls, status: transientUnitStatus{DynamicUID: "61408"}}
	execute := lifecycleExecute(t, entry, lifecycleManifest(t, entry, lifecyclePolicyFail), launcher)
	status, manifest, ok := execute.currentExecution()
	if !ok {
		t.Fatal("missing seeded execution")
	}
	status.Unit = "ssh.service"
	execute.setLastManifest(status, &manifest)
	archive := &recordingLifecycleArchive{calls: &calls, backupID: lifecycleBackupID}
	lifecycle := lifecycleCapabilityForTest(execute, archive, nil)
	calls = nil
	launcher.calls = &calls
	archive.calls = &calls

	undo, err := lifecycle.Apply(ctx, LifecycleApplyRequest{Desired: &LifecycleDesired{Op: lifecycleOpStop, ID: entry.ID}})
	assertLifecycleRejected(t, undo, err, "capsule_lifecycle_own_unit")
	if len(calls) != 0 || len(archive.creates) != 0 {
		t.Fatalf("calls=%#v creates=%d, want no side effects", calls, len(archive.creates))
	}
}

const lifecycleBackupID = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func lifecycleExecute(t *testing.T, entry CapsuleEntry, manifest ExecutionManifest, launcher *orderedLifecycleLauncher) *ExecuteCapability {
	t.Helper()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	execute := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
	)
	if _, err := execute.Apply(context.Background(), executeApply(entry)); err != nil {
		t.Fatalf("seed execute Apply returned error: %v", err)
	}
	return execute
}

func lifecycleNetworkExecute(t *testing.T, entry CapsuleEntry, manifest ExecutionManifest, launcher *orderedLifecycleLauncher, netns capsuleNetnsManager) *ExecuteCapability {
	t.Helper()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	execute := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		netns,
		nil,
	)
	if _, err := execute.Apply(context.Background(), executeApply(entry)); err != nil {
		t.Fatalf("seed execute Apply returned error: %v", err)
	}
	return execute
}

func lifecycleCapabilityForTest(execute *ExecuteCapability, archive lifecycleArchive, snapshot func() []capsuleruntime.WorkloadStatus) *LifecycleCapability {
	lifecycle := newLifecycleCapability(execute, archive, snapshot)
	now := time.Unix(0, 0)
	lifecycle.now = func() time.Time {
		return now
	}
	lifecycle.sleep = func(ctx context.Context, delay time.Duration) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if delay <= 0 {
			delay = time.Nanosecond
		}
		now = now.Add(delay)
		return nil
	}
	lifecycle.pollInterval = time.Nanosecond
	return lifecycle
}

func lifecycleEntry(version string) CapsuleEntry {
	entry := executeEntry()
	entry.Version = version
	return entry
}

func lifecycleManifest(t *testing.T, entry CapsuleEntry, onUnhealthy string) ExecutionManifest {
	t.Helper()
	manifest := executeManifest(entry)
	manifest.Data = ExecutionData{
		Classes: []capsulestorage.DataClass{capsulestorage.DataClassAppState},
		Volumes: []capsulestorage.VolumeSpec{
			executeVolumeSpec(t, entry.ID, "state"),
		},
	}
	manifest.HealthChecks = []capsuleruntime.Check{lifecycleHealthCheckForUnit("self")}
	manifest.baseDir = lifecycleVersionBaseDir(entry.ID, entry.Version)
	if entry.Version == "1.0.0" {
		manifest.baseDir = "/usr/lib/vita/capsules/local.test.capsule"
	}
	if onUnhealthy != "" {
		manifest.LifecyclePolicy = LifecyclePolicy{OnUnhealthy: onUnhealthy}
	}
	return manifest
}

func lifecycleNetworkManifest(t *testing.T, entry CapsuleEntry, onUnhealthy string) ExecutionManifest {
	t.Helper()
	manifest := lifecycleManifest(t, entry, onUnhealthy)
	manifest.Network = validExecutionNetworkNoGrants()
	return manifest
}

func lifecycleHealthCheckForUnit(target string) capsuleruntime.Check {
	return capsuleruntime.Check{
		Name:            "lifecycle",
		Type:            capsuleruntime.CheckTypeLifecycle,
		Target:          target,
		IntervalSeconds: 1,
		TimeoutSeconds:  1,
		Interval:        time.Nanosecond,
		Timeout:         time.Nanosecond,
	}
}

func lifecycleUpdateRequest(entry CapsuleEntry, manifest ExecutionManifest) LifecycleApplyRequest {
	target := &LifecycleTarget{Entry: entry, Manifest: manifest}
	return LifecycleApplyRequest{Desired: &LifecycleDesired{
		Op:     lifecycleOpUpdate,
		ID:     entry.ID,
		Target: target,
	}}
}

func lifecycleVolumePath(id string) string {
	path, err := capsulestorage.VolumePath(id, "state")
	if err != nil {
		panic(err)
	}
	return path
}

func assertLifecycleRejected(t *testing.T, undo interface{}, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("Apply returned nil error, want %s", code)
	}
	if undo != nil {
		t.Fatalf("Apply returned undo %#v, want nil", undo)
	}
	var invalid *LifecycleInvalidRequestError
	if errors.As(err, &invalid) {
		if invalid.ApplyErrorCode() != code {
			t.Fatalf("ApplyErrorCode = %q, want %q", invalid.ApplyErrorCode(), code)
		}
		return
	}
	var opErr *LifecycleOperationError
	if errors.As(err, &opErr) {
		if opErr.ApplyErrorCode() != code {
			t.Fatalf("ApplyErrorCode = %q, want %q", opErr.ApplyErrorCode(), code)
		}
		return
	}
	t.Fatalf("Apply error = %T %v, want coded lifecycle error %s", err, err, code)
}

type orderedLifecycleLauncher struct {
	calls     *[]string
	starts    []transientUnit
	stops     []string
	resets    []string
	status    transientUnitStatus
	err       error
	startErrs []error
}

func (l *orderedLifecycleLauncher) StartTransientUnit(ctx context.Context, unit transientUnit) (transientUnitStatus, error) {
	if err := ctx.Err(); err != nil {
		return transientUnitStatus{}, err
	}
	if l.calls != nil {
		*l.calls = append(*l.calls, "start:"+unit.Name)
	}
	l.starts = append(l.starts, cloneTransientUnit(unit))
	if len(l.startErrs) > 0 {
		err := l.startErrs[0]
		l.startErrs = l.startErrs[1:]
		if err != nil {
			return transientUnitStatus{}, err
		}
	} else if l.err != nil {
		return transientUnitStatus{}, l.err
	}
	status := l.status
	if status.DynamicUID == "" {
		status.DynamicUID = "61408"
	}
	if unit.NetNS != nil && status.NetworkNamespacePath == "" {
		status.NetworkNamespacePath = "/proc/123/ns/net"
	}
	return status, nil
}

func (l *orderedLifecycleLauncher) ConfirmOCILimits(ctx context.Context, unit string, limits ExecutionResourceLimits) (OCILimitsStatus, error) {
	if err := ctx.Err(); err != nil {
		return OCILimitsStatus{}, err
	}
	return OCILimitsStatus{}, nil
}

func (l *orderedLifecycleLauncher) StopTransientUnit(ctx context.Context, unit string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if l.calls != nil {
		*l.calls = append(*l.calls, "stop:"+unit)
	}
	l.stops = append(l.stops, unit)
	return nil
}

func (l *orderedLifecycleLauncher) ResetFailedUnit(ctx context.Context, unit string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if l.calls != nil {
		*l.calls = append(*l.calls, "reset:"+unit)
	}
	l.resets = append(l.resets, unit)
	return nil
}

type recordingLifecycleArchive struct {
	calls      *[]string
	backupID   string
	createErr  error
	verifyErr  error
	restoreErr error
	creates    []backup.ArchiveCreateRequest
	verifies   []backup.ArchiveVerifyRequest
	restores   []backup.ArchiveRestoreRequest
}

func (a *recordingLifecycleArchive) Create(ctx context.Context, req backup.ArchiveCreateRequest) (backup.ArchiveCreateResult, transaction.Undo, error) {
	if err := ctx.Err(); err != nil {
		return backup.ArchiveCreateResult{}, nil, err
	}
	if a.calls != nil {
		*a.calls = append(*a.calls, "backup.create")
	}
	a.creates = append(a.creates, req)
	if a.createErr != nil {
		return backup.ArchiveCreateResult{}, nil, a.createErr
	}
	id := a.backupID
	if id == "" {
		id = lifecycleBackupID
	}
	return backup.ArchiveCreateResult{BackupID: id, Files: 1}, archiveCallUndo{calls: a.calls}, nil
}

func (a *recordingLifecycleArchive) Verify(ctx context.Context, req backup.ArchiveVerifyRequest) (backup.ArchiveVerifyResult, error) {
	if err := ctx.Err(); err != nil {
		return backup.ArchiveVerifyResult{}, err
	}
	if a.calls != nil {
		*a.calls = append(*a.calls, "backup.verify")
	}
	a.verifies = append(a.verifies, req)
	if a.verifyErr != nil {
		return backup.ArchiveVerifyResult{}, a.verifyErr
	}
	return backup.ArchiveVerifyResult{OK: true, BackupID: req.BackupID, Files: 1}, nil
}

func (a *recordingLifecycleArchive) Restore(ctx context.Context, req backup.ArchiveRestoreRequest) (backup.ArchiveRestoreResult, transaction.Undo, error) {
	if err := ctx.Err(); err != nil {
		return backup.ArchiveRestoreResult{}, nil, err
	}
	if a.calls != nil {
		*a.calls = append(*a.calls, "backup.restore")
	}
	a.restores = append(a.restores, req)
	if a.restoreErr != nil {
		return backup.ArchiveRestoreResult{}, nil, a.restoreErr
	}
	return backup.ArchiveRestoreResult{BackupID: req.BackupID, Files: 1, Restored: true}, archiveCallUndo{calls: a.calls}, nil
}

type archiveCallUndo struct {
	calls *[]string
}

func (u archiveCallUndo) Undo(context.Context) error {
	if u.calls != nil {
		*u.calls = append(*u.calls, "backup.undo")
	}
	return nil
}
