package capsule

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestExecuteWithoutNetworkGrantDoesNotCreateNetns(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	netns := &recordingNetnsManager{}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: executeManifest(entry)},
		launcher,
		netns,
		nil,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if len(netns.created) != 0 || len(netns.checked) != 0 {
		t.Fatalf("netns calls = create:%d check:%d, want none", len(netns.created), len(netns.checked))
	}
	if len(launcher.starts) != 1 {
		t.Fatalf("StartTransientUnit calls = %d, want 1", len(launcher.starts))
	}

	started := launcher.starts[0]
	if started.NetNS != nil {
		t.Fatalf("NetNS = %#v, want nil", started.NetNS)
	}
	props := propertyValues(started.Properties)
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX")
	assertNoProperty(t, props, "NetworkNamespacePath")
}

func TestExecuteNetworkGrantTearsDownNetnsWhenStartFails(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	manifest := executeManifest(entry)
	manifest.Network = validExecutionNetwork()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		err: errors.New("unit failed"),
	}
	netns := &recordingNetnsManager{}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		netns,
		nil,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var startErr *ExecuteStartError
	if !errors.As(err, &startErr) {
		t.Fatalf("Apply error = %T %v, want ExecuteStartError", err, err)
	}
	if len(netns.created) != 1 {
		t.Fatalf("created netns = %d, want 1", len(netns.created))
	}
	if !reflect.DeepEqual(netns.tornDown, netns.created) {
		t.Fatalf("tornDown = %#v, want created %#v", netns.tornDown, netns.created)
	}
}

func TestExecuteNetworkGrantStopsAndTearsDownWhenNetnsCheckFails(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	manifest := executeManifest(entry)
	manifest.Network = validExecutionNetwork()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	netns := &recordingNetnsManager{
		check: &capsuleNetnsCheck{
			Interfaces: []string{"lo", "eth0"},
			Isolation:  "not_enforced",
			Status:     capsuleNetnsMeasuredStatusFail,
		},
	}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		netns,
		nil,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var startErr *ExecuteStartError
	if !errors.As(err, &startErr) {
		t.Fatalf("Apply error = %T %v, want ExecuteStartError", err, err)
	}
	if startErr.ApplyErrorCode() != "capsule_netns_failed" {
		t.Fatalf("ApplyErrorCode = %q, want capsule_netns_failed", startErr.ApplyErrorCode())
	}
	if !reflect.DeepEqual(launcher.stops, []string{capsuleUnitName(entry.ID)}) {
		t.Fatalf("stops = %v, want unit cleanup", launcher.stops)
	}
	if !reflect.DeepEqual(launcher.resets, []string{capsuleUnitName(entry.ID)}) {
		t.Fatalf("resets = %v, want unit cleanup", launcher.resets)
	}
	if !reflect.DeepEqual(netns.tornDown, netns.created) {
		t.Fatalf("tornDown = %#v, want created %#v", netns.tornDown, netns.created)
	}
}

func TestExecuteNetworkProofRefreshesReadStateFromMeasuredWorkload(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	manifest := executeManifest(entry)
	manifest.Network = validExecutionNetwork()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	proofPath := filepath.Join(t.TempDir(), "netns-proof.json")
	netns := &recordingNetnsManager{
		check: &capsuleNetnsCheck{
			Interfaces: []string{"lo"},
			Isolation:  capsuleNetnsIsolationEnforced,
			Status:     capsuleNetnsMeasuredStatusOK,
		},
		proofPath: proofPath,
	}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		netns,
		nil,
	)

	if _, err := capability.Apply(ctx, executeApply(entry)); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if err := os.WriteFile(proofPath, []byte(`{"id":"local.test.capsule","loopback":"OK","external":"FAIL","status":"OK"}`), 0o600); err != nil {
		t.Fatalf("WriteFile proof returned error: %v", err)
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last == nil || readResponse.Last.Network == nil {
		t.Fatalf("Last.Network = %#v, want network status", readResponse.Last)
	}
	if readResponse.Last.Network.Loopback != capsuleNetnsLoopbackOK {
		t.Fatalf("Loopback = %q, want OK", readResponse.Last.Network.Loopback)
	}
	if readResponse.Last.Network.Isolation != capsuleNetnsIsolationEnforced {
		t.Fatalf("Isolation = %q, want enforced", readResponse.Last.Network.Isolation)
	}
}

type recordingNetnsManager struct {
	created  []capsuleNetns
	checked  []capsuleNetns
	tornDown []capsuleNetns

	check     *capsuleNetnsCheck
	createErr error
	checkErr  error
	tearErr   error
	proofPath string
}

func (m *recordingNetnsManager) Create(ctx context.Context, netns capsuleNetns) (capsuleNetns, error) {
	if err := ctx.Err(); err != nil {
		return capsuleNetns{}, err
	}
	if m.createErr != nil {
		return capsuleNetns{}, m.createErr
	}
	if m.proofPath != "" {
		netns.ProofPath = m.proofPath
	}
	m.created = append(m.created, netns)
	return netns, nil
}

func (m *recordingNetnsManager) Check(ctx context.Context, netns capsuleNetns) (capsuleNetnsCheck, error) {
	if err := ctx.Err(); err != nil {
		return capsuleNetnsCheck{}, err
	}
	m.checked = append(m.checked, netns)
	if m.checkErr != nil {
		return capsuleNetnsCheck{}, m.checkErr
	}
	if m.check == nil {
		return capsuleNetnsCheck{
			Interfaces: []string{"lo"},
			Isolation:  capsuleNetnsIsolationEnforced,
			Status:     capsuleNetnsMeasuredStatusOK,
		}, nil
	}
	return *m.check, nil
}

func (m *recordingNetnsManager) Teardown(ctx context.Context, netns capsuleNetns) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.tornDown = append(m.tornDown, netns)
	return m.tearErr
}
