package files

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestCopyFileAndDirectory(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	base := ensureFilesTestBase(t, stateRoot)

	writeFilesFixture(t, filepath.Join(base, "note.txt"), []byte("copy me"))
	if _, err := handler.Handle(ctx, Request{
		Op:    OperationCopy,
		Grant: "rw",
		Path:  "note.txt",
		Dest:  "note-copy.txt",
	}); err != nil {
		t.Fatalf("copy file returned error: %v", err)
	}
	assertFileContent(t, filepath.Join(base, "note-copy.txt"), []byte("copy me"))
	assertMode(t, filepath.Join(base, "note-copy.txt"), fileMode)

	mkdirFilesFixture(t, filepath.Join(base, "docs", "nested"))
	writeFilesFixture(t, filepath.Join(base, "docs", "nested", "deep.txt"), []byte("deep copy"))
	if _, err := handler.Handle(ctx, Request{
		Op:    OperationCopy,
		Grant: "rw",
		Path:  "docs",
		Dest:  "docs-copy",
	}); err != nil {
		t.Fatalf("copy directory returned error: %v", err)
	}
	assertMode(t, filepath.Join(base, "docs-copy"), directoryMode)
	assertMode(t, filepath.Join(base, "docs-copy", "nested"), directoryMode)
	assertMode(t, filepath.Join(base, "docs-copy", "nested", "deep.txt"), fileMode)
	assertFileContent(t, filepath.Join(base, "docs-copy", "nested", "deep.txt"), []byte("deep copy"))

	writeFilesFixture(t, filepath.Join(base, "existing.txt"), []byte("original"))
	_, err := handler.Handle(ctx, Request{
		Op:    OperationCopy,
		Grant: "rw",
		Path:  "note.txt",
		Dest:  "existing.txt",
	})
	assertFilesErrorCode(t, err, "already_exists")
	assertFileContent(t, filepath.Join(base, "existing.txt"), []byte("original"))

	_, err = handler.Handle(ctx, Request{
		Op:    OperationCopy,
		Grant: "rw",
		Path:  "docs",
		Dest:  "docs/nested/copy",
	})
	assertFilesErrorCode(t, err, "invalid_request")
	assertPathAbsent(t, filepath.Join(base, "docs", "nested", "copy"))

	_, err = handler.Handle(ctx, Request{
		Op:    OperationCopy,
		Grant: "rw",
		Path:  "note.txt",
		Dest:  "note.txt",
	})
	assertFilesErrorCode(t, err, "invalid_request")
	assertFileContent(t, filepath.Join(base, "note.txt"), []byte("copy me"))
}

func TestMoveFileAndDirectory(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	base := ensureFilesTestBase(t, stateRoot)

	writeFilesFixture(t, filepath.Join(base, "move-src.txt"), []byte("move file"))
	if _, err := handler.Handle(ctx, Request{
		Op:    OperationMove,
		Grant: "rw",
		Path:  "move-src.txt",
		Dest:  "move-dst.txt",
	}); err != nil {
		t.Fatalf("move file returned error: %v", err)
	}
	assertPathAbsent(t, filepath.Join(base, "move-src.txt"))
	assertFileContent(t, filepath.Join(base, "move-dst.txt"), []byte("move file"))

	mkdirFilesFixture(t, filepath.Join(base, "move-dir", "nested"))
	writeFilesFixture(t, filepath.Join(base, "move-dir", "nested", "deep.txt"), []byte("move dir"))
	if _, err := handler.Handle(ctx, Request{
		Op:    OperationMove,
		Grant: "rw",
		Path:  "move-dir",
		Dest:  "moved-dir",
	}); err != nil {
		t.Fatalf("move directory returned error: %v", err)
	}
	assertPathAbsent(t, filepath.Join(base, "move-dir"))
	assertFileContent(t, filepath.Join(base, "moved-dir", "nested", "deep.txt"), []byte("move dir"))
}

func TestRenameWithinSameParent(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	base := ensureFilesTestBase(t, stateRoot)

	mkdirFilesFixture(t, filepath.Join(base, "docs"))
	writeFilesFixture(t, filepath.Join(base, "docs", "old.txt"), []byte("renamed"))
	if _, err := handler.Handle(ctx, Request{
		Op:    OperationMove,
		Grant: "rw",
		Path:  "docs/old.txt",
		Dest:  "docs/new.txt",
	}); err != nil {
		t.Fatalf("rename returned error: %v", err)
	}
	assertPathAbsent(t, filepath.Join(base, "docs", "old.txt"))
	assertFileContent(t, filepath.Join(base, "docs", "new.txt"), []byte("renamed"))
}

func TestMkdirCreatesSingleDirectory(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	base := ensureFilesTestBase(t, stateRoot)

	if _, err := handler.Handle(ctx, Request{Op: OperationMkdir, Grant: "rw", Path: "new-dir"}); err != nil {
		t.Fatalf("mkdir returned error: %v", err)
	}
	assertMode(t, filepath.Join(base, "new-dir"), directoryMode)

	_, err := handler.Handle(ctx, Request{Op: OperationMkdir, Grant: "rw", Path: "new-dir"})
	assertFilesErrorCode(t, err, "already_exists")

	_, err = handler.Handle(ctx, Request{Op: OperationMkdir, Grant: "rw", Path: "missing/child"})
	assertFilesErrorCode(t, err, "not_found")
	assertPathAbsent(t, filepath.Join(base, "missing"))
}

func TestDeleteRecursiveAndFailClosed(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	base := ensureFilesTestBase(t, stateRoot)

	mkdirFilesFixture(t, filepath.Join(base, "doomed", "nested"))
	writeFilesFixture(t, filepath.Join(base, "doomed", "root.txt"), []byte("root"))
	writeFilesFixture(t, filepath.Join(base, "doomed", "nested", "deep.txt"), []byte("deep"))
	if _, err := handler.Handle(ctx, Request{Op: OperationDelete, Grant: "rw", Path: "doomed"}); err != nil {
		t.Fatalf("delete recursive returned error: %v", err)
	}
	assertPathAbsent(t, filepath.Join(base, "doomed"))

	_, err := handler.Handle(ctx, Request{Op: OperationDelete, Grant: "rw", Path: "missing"})
	assertFilesErrorCode(t, err, "not_found")

	mkdirFilesFixture(t, filepath.Join(base, "blocked"))
	writeFilesFixture(t, filepath.Join(base, "blocked", "keep.txt"), []byte("keep"))
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(base, "blocked", "escape-link")); err != nil {
		t.Fatalf("Symlink returned error: %v", err)
	}
	_, err = handler.Handle(ctx, Request{Op: OperationDelete, Grant: "rw", Path: "blocked"})
	assertFilesErrorCode(t, err, "path_traversal")
	assertFileContent(t, filepath.Join(base, "blocked", "keep.txt"), []byte("keep"))
	if _, err := os.Lstat(filepath.Join(base, "blocked", "escape-link")); err != nil {
		t.Fatalf("blocked symlink after failed delete = %v, want still present", err)
	}
}

func TestListRecursiveDepthCapAndSymlinkSkip(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	base := ensureFilesTestBase(t, stateRoot)

	mkdirFilesFixture(t, filepath.Join(base, "root", "dir", "deep"))
	writeFilesFixture(t, filepath.Join(base, "root", "a.txt"), []byte("a"))
	writeFilesFixture(t, filepath.Join(base, "root", "dir", "b.txt"), []byte("b"))
	writeFilesFixture(t, filepath.Join(base, "root", "dir", "deep", "c.txt"), []byte("c"))
	outside := t.TempDir()
	writeFilesFixture(t, filepath.Join(outside, "secret.txt"), []byte("secret"))
	if err := os.Symlink(outside, filepath.Join(base, "root", "link")); err != nil {
		t.Fatalf("Symlink returned error: %v", err)
	}

	resp, err := handler.Handle(ctx, Request{
		Op:    OperationListRecursive,
		Grant: "rw",
		Path:  "root",
		Depth: 2,
	})
	if err != nil {
		t.Fatalf("recursive list returned error: %v", err)
	}
	if resp.Entries == nil {
		t.Fatal("recursive list entries = nil, want entries")
	}
	got := entryKinds(*resp.Entries)
	want := map[string]Kind{
		"a.txt":     KindFile,
		"dir":       KindDir,
		"dir/b.txt": KindFile,
		"dir/deep":  KindDir,
		"link":      KindSymlinkSkipped,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("recursive list entries = %#v, want %#v", got, want)
	}
	if _, ok := got["dir/deep/c.txt"]; ok {
		t.Fatal("recursive list walked beyond requested depth")
	}
	if _, ok := got["link/secret.txt"]; ok {
		t.Fatal("recursive list traversed symlink child")
	}
}

func TestMutatingOpReadOnlyGrant(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)

	for _, req := range mutatingRequests("ro") {
		t.Run("flat/"+string(req.Op), func(t *testing.T) {
			_, err := handler.Handle(ctx, req)
			assertFilesErrorCode(t, err, "read_only_grant")
		})
	}

	shared := true
	sharedHandler, err := NewHandler(Options{
		StateRoot: stateRoot,
		Grants: []Grant{
			{
				Name:   "shared-ro",
				Root:   "scope",
				Shared: &shared,
				Roles:  RoleAccessMap{RoleOwner: AccessReadOnly},
			},
		},
		Principals: []Principal{{PrincipalKey: "peer-owner", Role: RoleOwner}},
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}
	ownerCtx := ContextWithPrincipalKey(ctx, "peer-owner")
	for _, req := range mutatingRequests("shared-ro") {
		t.Run("role/"+string(req.Op), func(t *testing.T) {
			_, err := sharedHandler.Handle(ownerCtx, req)
			assertFilesErrorCode(t, err, "role_forbidden")
		})
	}
}

func TestMutatingOpScopeEscape(t *testing.T) {
	escapes := []struct {
		name string
		path func(t *testing.T, base string) string
	}{
		{name: "parent", path: func(t *testing.T, base string) string { return "../escape.txt" }},
		{name: "absolute", path: func(t *testing.T, base string) string { return filepath.Join(t.TempDir(), "escape.txt") }},
		{name: "backslash", path: func(t *testing.T, base string) string { return "bad\\name" }},
		{name: "symlink", path: func(t *testing.T, base string) string {
			outside := t.TempDir()
			if err := os.Symlink(outside, filepath.Join(base, "escape-link")); err != nil {
				t.Fatalf("Symlink returned error: %v", err)
			}
			return "escape-link/secret.txt"
		}},
	}

	pathOps := []struct {
		name string
		req  func(path string) Request
	}{
		{name: "copy", req: func(path string) Request {
			return Request{Op: OperationCopy, Grant: "rw", Path: path, Dest: "copy-dst.txt"}
		}},
		{name: "move", req: func(path string) Request {
			return Request{Op: OperationMove, Grant: "rw", Path: path, Dest: "move-dst.txt"}
		}},
		{name: "mkdir", req: func(path string) Request {
			return Request{Op: OperationMkdir, Grant: "rw", Path: path}
		}},
		{name: "delete", req: func(path string) Request {
			return Request{Op: OperationDelete, Grant: "rw", Path: path}
		}},
	}
	for _, op := range pathOps {
		for _, escape := range escapes {
			t.Run(op.name+"/path/"+escape.name, func(t *testing.T) {
				handler, base := scopeEscapeFixture(t)
				_, err := handler.Handle(context.Background(), op.req(escape.path(t, base)))
				assertFilesErrorCode(t, err, "path_traversal")
			})
		}
	}

	destOps := []struct {
		name string
		req  func(dest string) Request
	}{
		{name: "copy", req: func(dest string) Request {
			return Request{Op: OperationCopy, Grant: "rw", Path: "src.txt", Dest: dest}
		}},
		{name: "move", req: func(dest string) Request {
			return Request{Op: OperationMove, Grant: "rw", Path: "src.txt", Dest: dest}
		}},
	}
	for _, op := range destOps {
		for _, escape := range escapes {
			t.Run(op.name+"/dest/"+escape.name, func(t *testing.T) {
				handler, base := scopeEscapeFixture(t)
				_, err := handler.Handle(context.Background(), op.req(escape.path(t, base)))
				assertFilesErrorCode(t, err, "path_traversal")
				assertFileContent(t, filepath.Join(base, "src.txt"), []byte("src"))
			})
		}
	}
}

func mutatingRequests(grant string) []Request {
	return []Request{
		{Op: OperationCopy, Grant: grant, Path: "src.txt", Dest: "dst.txt"},
		{Op: OperationMove, Grant: grant, Path: "src.txt", Dest: "dst.txt"},
		{Op: OperationMkdir, Grant: grant, Path: "new-dir"},
		{Op: OperationDelete, Grant: grant, Path: "old-dir"},
	}
}

func scopeEscapeFixture(t *testing.T) (*Handler, string) {
	t.Helper()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	base := ensureFilesTestBase(t, stateRoot)
	writeFilesFixture(t, filepath.Join(base, "src.txt"), []byte("src"))
	return handler, base
}

func ensureFilesTestBase(t *testing.T, stateRoot string) string {
	t.Helper()
	base := filepath.Join(stateRoot, "scope", "rw")
	mkdirFilesFixture(t, base)
	return base
}

func mkdirFilesFixture(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, directoryMode); err != nil {
		t.Fatalf("MkdirAll %s returned error: %v", path, err)
	}
	if err := os.Chmod(path, directoryMode); err != nil {
		t.Fatalf("Chmod %s returned error: %v", path, err)
	}
}

func writeFilesFixture(t *testing.T, path string, data []byte) {
	t.Helper()
	mkdirFilesFixture(t, filepath.Dir(path))
	if err := os.WriteFile(path, data, fileMode); err != nil {
		t.Fatalf("WriteFile %s returned error: %v", path, err)
	}
	if err := os.Chmod(path, fileMode); err != nil {
		t.Fatalf("Chmod %s returned error: %v", path, err)
	}
}

func assertFileContent(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile %s returned error: %v", path, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("file %s content = %q, want %q", path, got, want)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat %s returned error: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %o, want %o", path, got, want)
	}
}

func assertPathAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err == nil {
		t.Fatalf("%s exists, want absent", path)
	} else if !os.IsNotExist(err) {
		t.Fatalf("Lstat %s returned error %v, want not exist", path, err)
	}
}

func entryKinds(entries []Entry) map[string]Kind {
	out := make(map[string]Kind, len(entries))
	for _, entry := range entries {
		out[entry.Name] = entry.Kind
	}
	return out
}
