//go:build linux

package restore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/backup"
	"github.com/vita/agent/transaction"
)

var errSimulatedCommit = errors.New("simulated replacement commit failure")

func TestReplacementRestoreEmptyDestinationAndUndo(t *testing.T) {
	ctx := context.Background()
	fixture := createBackupFixture(t)
	live := t.TempDir()
	capsuleDest := filepath.Join(live, "runtime", "volumes")
	agentDest := filepath.Join(live, "vita-agent")
	before := mustDigestTree(t, live)

	capability := newCapability(staticNodeID("node-b.example"))
	result, undo, err := capability.Replace(ctx, ReplacementRequest{
		BackupSource: fixture.archiveDir,
		ExpectFrom:   strPtr("node-a.example"),
		Plan:         &[]PlanMapping{capsuleMapping(capsuleDest), agentMapping(agentDest)},
	})
	if err != nil {
		t.Fatalf("Replace returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Replace returned nil undo")
	}
	if result.BackupID != fixture.backupID || result.Files != fixture.files || !result.Restored || !result.Verified {
		t.Fatalf("Replace result = %#v, want backup %q files %d restored+verified", result, fixture.backupID, fixture.files)
	}
	if result.From != "node-a.example" || result.To != "node-b.example" {
		t.Fatalf("from/to = %q/%q, want node-a.example/node-b.example", result.From, result.To)
	}
	if len(result.Roots) != 2 || !result.Roots[0].Verified || !result.Roots[1].Verified {
		t.Fatalf("root statuses = %#v, want two verified roots", result.Roots)
	}
	assertTreeEqual(t, capsuleDest, fixture.capsule)
	assertTreeEqual(t, agentDest, fixture.agent)
	assertRestoredMatchesManifest(t, fixture.target, fixture.backupID, capsuleDest, agentDest)

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := mustDigestTree(t, live); !reflect.DeepEqual(got, before) {
		t.Fatalf("live tree after undo = %#v, want prior %#v", got, before)
	}
	assertNoReplacementTemps(t, filepath.Dir(live))
}

func TestReplacementRestoreReplacesLiveRootsWithSingleCommonSwap(t *testing.T) {
	ctx := context.Background()
	fixture := createBackupFixture(t)
	live := t.TempDir()
	capsuleDest := filepath.Join(live, "runtime", "volumes")
	agentDest := filepath.Join(live, "vita-agent")
	writeTestFile(t, filepath.Join(capsuleDest, "stale.txt"), []byte("stale capsule"), 0o600)
	writeTestFile(t, filepath.Join(agentDest, "stale.txt"), []byte("stale agent"), 0o600)
	writeTestFile(t, filepath.Join(live, "sibling", "keep.txt"), []byte("preserved sibling"), 0o600)

	capability := newCapability(staticNodeID("node-b.example"))
	result, undo, err := capability.Replace(ctx, ReplacementRequest{
		BackupSource: fixture.target,
		Plan:         &[]PlanMapping{agentMapping(agentDest), capsuleMapping(capsuleDest)},
	})
	if err != nil {
		t.Fatalf("Replace returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Replace returned nil undo")
	}
	if !result.Restored || !result.Verified {
		t.Fatalf("Replace result = %#v, want restored+verified", result)
	}
	assertTreeEqual(t, capsuleDest, fixture.capsule)
	assertTreeEqual(t, agentDest, fixture.agent)
	if got := string(mustReadFile(t, filepath.Join(live, "sibling", "keep.txt"))); got != "preserved sibling" {
		t.Fatalf("sibling content = %q, want preserved sibling", got)
	}
	if _, err := os.Stat(filepath.Join(capsuleDest, "stale.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale capsule file stat err = %v, want absent", err)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := string(mustReadFile(t, filepath.Join(capsuleDest, "stale.txt"))); got != "stale capsule" {
		t.Fatalf("undo stale capsule content = %q, want stale capsule", got)
	}
	if got := string(mustReadFile(t, filepath.Join(agentDest, "stale.txt"))); got != "stale agent" {
		t.Fatalf("undo stale agent content = %q, want stale agent", got)
	}
}

func TestReplacementRestoreTamperRefusesBeforeMutationOrLeaks(t *testing.T) {
	ctx := context.Background()
	fixture := createBackupFixture(t)
	live := t.TempDir()
	capsuleDest := filepath.Join(live, "runtime", "volumes")
	agentDest := filepath.Join(live, "vita-agent")
	writeTestFile(t, filepath.Join(capsuleDest, "live.txt"), []byte("live capsule"), 0o600)
	writeTestFile(t, filepath.Join(agentDest, "live.txt"), []byte("live agent"), 0o600)
	before := mustDigestTree(t, live)

	tamperFirstObject(t, fixture.archiveDir)
	capability := newCapability(staticNodeID("node-b.example"))
	result, undo, err := capability.Replace(ctx, ReplacementRequest{
		BackupSource: fixture.archiveDir,
		Plan:         &[]PlanMapping{capsuleMapping(capsuleDest), agentMapping(agentDest)},
	})
	if err == nil {
		t.Fatalf("Replace result = %#v undo = %v, want verification failure", result, undo)
	}
	if undo != nil {
		t.Fatalf("Replace returned undo %v, want nil", undo)
	}
	var verifyErr *backup.ArchiveVerificationError
	if !errors.As(err, &verifyErr) {
		t.Fatalf("Replace error = %T %v, want ArchiveVerificationError", err, err)
	}
	if code := verifyErr.ApplyErrorCode(); code != "verify_digest_mismatch" {
		t.Fatalf("ApplyErrorCode = %q, want verify_digest_mismatch", code)
	}
	if got := mustDigestTree(t, live); !reflect.DeepEqual(got, before) {
		t.Fatalf("live tree after tamper refusal = %#v, want unchanged %#v", got, before)
	}
	assertNoReplacementTemps(t, filepath.Dir(live))
}

func TestReplacementRestoreExpectFromGuard(t *testing.T) {
	ctx := context.Background()
	fixture := createBackupFixture(t)
	live := t.TempDir()
	capability := newCapability(staticNodeID("node-b.example"))

	_, undo, err := capability.Replace(ctx, ReplacementRequest{
		BackupSource: fixture.archiveDir,
		ExpectFrom:   strPtr("node-a.example"),
		Plan: &[]PlanMapping{
			capsuleMapping(filepath.Join(live, "ok", "volumes")),
			agentMapping(filepath.Join(live, "ok", "agent")),
		},
	})
	if err != nil {
		t.Fatalf("matching expectFrom returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("matching expectFrom returned nil undo")
	}

	before := mustDigestTree(t, live)
	result, undo, err := capability.Replace(ctx, ReplacementRequest{
		BackupSource: fixture.archiveDir,
		ExpectFrom:   strPtr("other-node.example"),
		Plan: &[]PlanMapping{
			capsuleMapping(filepath.Join(live, "bad", "volumes")),
			agentMapping(filepath.Join(live, "bad", "agent")),
		},
	})
	if err == nil {
		t.Fatalf("mismatching expectFrom result = %#v undo = %v, want from_mismatch", result, undo)
	}
	if undo != nil {
		t.Fatalf("mismatching expectFrom returned undo %v, want nil", undo)
	}
	var invalid *InvalidRequestError
	if !errors.As(err, &invalid) || invalid.ApplyErrorCode() != "from_mismatch" {
		t.Fatalf("mismatching expectFrom error = %T %v, want from_mismatch", err, err)
	}
	if got := mustDigestTree(t, live); !reflect.DeepEqual(got, before) {
		t.Fatalf("live tree after from mismatch = %#v, want unchanged %#v", got, before)
	}

	noOrigin := createBackupFixtureWithoutOrigin(t)
	_, undo, err = capability.Replace(ctx, ReplacementRequest{
		BackupSource: noOrigin.archiveDir,
		ExpectFrom:   strPtr("not-present.example"),
		Plan: &[]PlanMapping{
			capsuleMapping(filepath.Join(live, "no-origin", "volumes")),
			agentMapping(filepath.Join(live, "no-origin", "agent")),
		},
	})
	if err != nil {
		t.Fatalf("expectFrom with no archived identity returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("expectFrom with no archived identity returned nil undo")
	}
}

func TestReplacementRestoreFailClosedInputHandling(t *testing.T) {
	ctx := context.Background()
	capability := NewCapability()
	source := filepath.Join(t.TempDir(), "backup")
	dest := t.TempDir()
	validPlan := []PlanMapping{
		capsuleMapping(filepath.Join(dest, "capsule")),
		agentMapping(filepath.Join(dest, "agent")),
	}

	tests := []struct {
		name string
		req  ApplyRequest
		code string
	}{
		{
			name: "missing required field",
			req:  ApplyRequest{Op: OperationReplace, Replace: &ReplacementRequest{}},
			code: "invalid_request",
		},
		{
			name: "non absolute source",
			req: ApplyRequest{Op: OperationReplace, Replace: &ReplacementRequest{
				BackupSource: "relative",
				Plan:         &validPlan,
			}},
			code: "non_absolute_source",
		},
		{
			name: "control char destination",
			req: ApplyRequest{Op: OperationReplace, Replace: &ReplacementRequest{
				BackupSource: source,
				Plan: &[]PlanMapping{
					capsuleMapping(filepath.Join(dest, "bad\npath")),
					agentMapping(filepath.Join(dest, "agent")),
				},
			}},
			code: "inline_secret_material",
		},
		{
			name: "dot-dot destination",
			req: ApplyRequest{Op: OperationReplace, Replace: &ReplacementRequest{
				BackupSource: source,
				Plan: &[]PlanMapping{
					capsuleMapping(dest + "/bad/../path"),
					agentMapping(filepath.Join(dest, "agent")),
				},
			}},
			code: "invalid_destination",
		},
		{
			name: "inline secret metadata",
			req: ApplyRequest{Op: OperationReplace, Replace: &ReplacementRequest{
				BackupSource: source,
				Plan: &[]PlanMapping{
					{Name: "private-key", BackupRoot: "capsule-volumes", DestinationRoot: filepath.Join(dest, "capsule")},
					agentMapping(filepath.Join(dest, "agent")),
				},
			}},
			code: "inline_secret_material",
		},
		{
			name: "unknown op",
			req: ApplyRequest{Op: Operation("restore-everything"), Replace: &ReplacementRequest{
				BackupSource: source,
				Plan:         &validPlan,
			}},
			code: "unknown_op",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			undo, err := capability.Apply(ctx, tt.req)
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if invalid.ApplyErrorCode() != tt.code {
				t.Fatalf("ApplyErrorCode = %q, want %q", invalid.ApplyErrorCode(), tt.code)
			}
		})
	}

	raw := []byte(`{"op":"replace","replace":{"backupSource":"/tmp/a","backupSource":"/tmp/b","plan":[{"name":"capsule-volumes","backupRoot":"capsule-volumes","destinationRoot":"/tmp/capsule"},{"name":"vita-agent","backupRoot":"vita-agent","destinationRoot":"/tmp/agent"}]}}`)
	var req ApplyRequest
	err := json.Unmarshal(raw, &req)
	if err == nil {
		t.Fatal("Unmarshal returned nil, want duplicate-key rejection")
	}
	if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("Unmarshal error = %v, want duplicate-key rejection", err)
	}
}

func TestReplacementRestoreRegisteredAndDecodedUnderClosedName(t *testing.T) {
	registry, err := capabilities.NewRegistry(NewCapability())
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	if _, ok := registry.Lookup(Name); !ok {
		t.Fatalf("registry missing %q", Name)
	}
	if _, ok := registry.Lookup("restore.anything"); ok {
		t.Fatal("unexpected restore.anything capability registered")
	}
}

func TestReplacementRestoreCommitFailureLeavesLiveTreeUnchanged(t *testing.T) {
	ctx := context.Background()
	fixture := createBackupFixture(t)
	live := t.TempDir()
	capsuleDest := filepath.Join(live, "runtime", "volumes")
	agentDest := filepath.Join(live, "vita-agent")
	writeTestFile(t, filepath.Join(capsuleDest, "live.txt"), []byte("live capsule"), 0o600)
	writeTestFile(t, filepath.Join(agentDest, "live.txt"), []byte("live agent"), 0o600)
	before := mustDigestTree(t, live)

	realCommit := commitReplacementRoot
	commitReplacementRoot = func(ctx context.Context, livePath string, stage string, hadPrior bool) (transaction.Undo, error) {
		return nil, errSimulatedCommit
	}
	defer func() {
		commitReplacementRoot = realCommit
	}()

	capability := newCapability(staticNodeID("node-b.example"))
	result, undo, err := capability.Replace(ctx, ReplacementRequest{
		BackupSource: fixture.archiveDir,
		Plan:         &[]PlanMapping{capsuleMapping(capsuleDest), agentMapping(agentDest)},
	})
	if err == nil {
		t.Fatalf("Replace result = %#v undo = %v, want simulated commit failure", result, undo)
	}
	if undo != nil {
		t.Fatalf("Replace returned undo %v, want nil", undo)
	}
	if !errors.Is(err, errSimulatedCommit) {
		t.Fatalf("Replace error = %v, want simulated commit", err)
	}
	if got := mustDigestTree(t, live); !reflect.DeepEqual(got, before) {
		t.Fatalf("live tree after commit failure = %#v, want unchanged %#v", got, before)
	}
	assertNoReplacementTemps(t, filepath.Dir(live))
}

type backupFixture struct {
	target     string
	archiveDir string
	backupID   string
	files      int
	capsule    string
	agent      string
}

func createBackupFixture(t *testing.T) backupFixture {
	t.Helper()
	return createBackupFixtureWithOrigin(t, true)
}

func createBackupFixtureWithoutOrigin(t *testing.T) backupFixture {
	t.Helper()
	return createBackupFixtureWithOrigin(t, false)
}

func createBackupFixtureWithOrigin(t *testing.T, withOrigin bool) backupFixture {
	t.Helper()
	ctx := context.Background()
	target := t.TempDir()
	capsule := filepath.Join(t.TempDir(), "capsule")
	agent := filepath.Join(t.TempDir(), "agent")
	writeTestFile(t, filepath.Join(capsule, "app", "sentinel.txt"), []byte("node A capsule sentinel\n"), 0o600)
	writeTestFile(t, filepath.Join(agent, "node-config.env"), []byte("mode=normal\nremote_access=disabled\n"), 0o600)
	if withOrigin {
		writeTestFile(t, filepath.Join(agent, "pds-sync-state.json"), []byte(`{"repo":"did:plc:bbbbbbbbbbbbbbbbbbbbbbbb","cursor":42,"repoHead":"bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`+"\n"), 0o600)
		writeTestFile(t, filepath.Join(agent, "identity-attestation.json"), []byte(`{"did":"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa","handle":"node-a.example","signingKeyRef":{"id":"key:identity-signing-primary","handle":"identity-signing-primary"}}`+"\n"), 0o600)
	}

	roots := []backup.ArchiveSourceRoot{
		{Name: "capsule-volumes", Path: capsule},
		{Name: "vita-agent", Path: agent},
	}
	created, _, err := backup.NewArchiveCapability().Create(ctx, backup.ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &roots,
	})
	if err != nil {
		t.Fatalf("Create backup archive returned error: %v", err)
	}
	return backupFixture{
		target:     target,
		archiveDir: filepath.Join(target, created.BackupID),
		backupID:   created.BackupID,
		files:      created.Files,
		capsule:    capsule,
		agent:      agent,
	}
}

func capsuleMapping(destination string) PlanMapping {
	return PlanMapping{Name: "capsule-volumes", BackupRoot: "capsule-volumes", DestinationRoot: destination}
}

func agentMapping(destination string) PlanMapping {
	return PlanMapping{Name: "vita-agent", BackupRoot: "vita-agent", DestinationRoot: destination}
}

func assertRestoredMatchesManifest(t *testing.T, target string, backupID string, capsuleDest string, agentDest string) {
	t.Helper()
	mappings := []backup.RootMapping{
		{Name: "capsule-volumes", Path: capsuleDest},
		{Name: "vita-agent", Path: agentDest},
	}
	result, err := backup.NewArchiveCapability().VerifyRestored(context.Background(), backup.ArchiveVerifyRestoredRequest{
		TargetPath:   target,
		BackupID:     backupID,
		RootMappings: &mappings,
	})
	if err != nil {
		t.Fatalf("VerifyRestored returned error: %v", err)
	}
	if !result.Verified || result.Volumes != 2 {
		t.Fatalf("VerifyRestored = %#v, want two verified roots", result)
	}
}

func assertTreeEqual(t *testing.T, left string, right string) {
	t.Helper()
	leftTree := mustDigestTree(t, left)
	rightTree := mustDigestTree(t, right)
	if !reflect.DeepEqual(leftTree, rightTree) {
		t.Fatalf("tree %s = %#v, want %s %#v", left, leftTree, right, rightTree)
	}
}

type digestEntry struct {
	Type   string
	Mode   os.FileMode
	Size   int64
	Digest string
}

func mustDigestTree(t *testing.T, root string) map[string]digestEntry {
	t.Helper()
	entries := map[string]digestEntry{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		if d.IsDir() {
			entries[rel] = digestEntry{Type: "dir", Mode: info.Mode().Perm()}
			return nil
		}
		if !info.Mode().IsRegular() {
			return errors.New("unexpected non-regular file")
		}
		digest, size := digestFileForTest(t, path)
		entries[rel] = digestEntry{Type: "file", Mode: info.Mode().Perm(), Size: size, Digest: digest}
		return nil
	})
	if err != nil {
		t.Fatalf("digest tree %s: %v", root, err)
	}
	return entries
}

func digestFileForTest(t *testing.T, path string) (string, int64) {
	t.Helper()
	content := mustReadFile(t, path)
	return string(contentDigestForTest(content)), int64(len(content))
}

func contentDigestForTest(content []byte) []byte {
	// Test-only tree comparisons only need a deterministic byte identity token;
	// the restore capability itself verifies SHA-256 archive digests.
	out := make([]byte, len(content))
	copy(out, content)
	return out
}

func tamperFirstObject(t *testing.T, archiveDir string) {
	t.Helper()
	objects := filepath.Join(archiveDir, "objects")
	entries, err := os.ReadDir(objects)
	if err != nil {
		t.Fatalf("read objects: %v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(objects, entry.Name())
		content := mustReadFile(t, path)
		if len(content) == 0 {
			content = []byte("tampered")
		} else {
			content[0] ^= 0xff
		}
		writeTestFile(t, path, content, 0o600)
		return
	}
	t.Fatal("backup archive has no object to tamper")
}

func assertNoReplacementTemps(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatalf("read replacement temp parent: %v", err)
	}
	var temps []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".restore-replacement-") {
			temps = append(temps, entry.Name())
		}
	}
	sort.Strings(temps)
	if len(temps) != 0 {
		t.Fatalf("replacement temp entries = %v, want none", temps)
	}
}

func writeTestFile(t *testing.T, path string, content []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create parent for %s: %v", path, err)
	}
	if err := os.WriteFile(path, content, mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("chmod %s: %v", path, err)
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return content
}

func staticNodeID(id string) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		return id, nil
	}
}

func strPtr(value string) *string {
	return &value
}
