package files

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestHandlerWriteReadStatAndListWithinGrant(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)

	rootData := []byte("root file")
	writeResp, err := handler.Handle(ctx, Request{
		Op:    OperationWrite,
		Grant: "rw",
		Path:  "root.txt",
		Data:  stringPtr(base64.StdEncoding.EncodeToString(rootData)),
	})
	if err != nil {
		t.Fatalf("root write returned error: %v", err)
	}
	if writeResp.Kind == nil || *writeResp.Kind != KindFile || writeResp.Size == nil || *writeResp.Size != int64(len(rootData)) {
		t.Fatalf("write response = %#v, want file size %d", writeResp, len(rootData))
	}

	base := filepath.Join(stateRoot, "scope", "rw")
	if err := os.Mkdir(filepath.Join(base, "docs"), 0o700); err != nil {
		t.Fatalf("Mkdir docs returned error: %v", err)
	}

	data := []byte("hello mediated files\n")
	if _, err := handler.Handle(ctx, Request{
		Op:    OperationWrite,
		Grant: "rw",
		Path:  "docs/note.txt",
		Data:  stringPtr(base64.StdEncoding.EncodeToString(data)),
	}); err != nil {
		t.Fatalf("write returned error: %v", err)
	}

	readResp, err := handler.Handle(ctx, Request{
		Op:    OperationRead,
		Grant: "rw",
		Path:  "docs/note.txt",
	})
	if err != nil {
		t.Fatalf("read returned error: %v", err)
	}
	if readResp.Data == nil {
		t.Fatalf("read response = %#v, want data", readResp)
	}
	gotData, err := base64.StdEncoding.DecodeString(*readResp.Data)
	if err != nil {
		t.Fatalf("read data is not base64: %v", err)
	}
	if !reflect.DeepEqual(gotData, data) {
		t.Fatalf("read data = %q, want %q", gotData, data)
	}
	if readResp.Size == nil || *readResp.Size != int64(len(data)) || readResp.MTime == nil || *readResp.MTime == "" {
		t.Fatalf("read response = %#v, want size and mtime", readResp)
	}

	statResp, err := handler.Handle(ctx, Request{
		Op:    OperationStat,
		Grant: "rw",
		Path:  "docs/note.txt",
	})
	if err != nil {
		t.Fatalf("stat returned error: %v", err)
	}
	if statResp.Kind == nil || *statResp.Kind != KindFile || statResp.Size == nil || *statResp.Size != int64(len(data)) || statResp.MTime == nil || *statResp.MTime == "" {
		t.Fatalf("stat response = %#v, want file size and mtime", statResp)
	}

	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(base, "docs", "outside-link")); err != nil {
		t.Fatalf("Symlink returned error: %v", err)
	}
	listResp, err := handler.Handle(ctx, Request{
		Op:    OperationList,
		Grant: "rw",
		Path:  "docs",
	})
	if err != nil {
		t.Fatalf("list returned error: %v", err)
	}
	if listResp.Entries == nil || len(*listResp.Entries) != 2 {
		t.Fatalf("list entries = %#v, want 2 entries", listResp.Entries)
	}
	entries := *listResp.Entries
	if entries[0].Name != "note.txt" ||
		entries[0].Kind != KindFile ||
		entries[0].Size != int64(len(data)) ||
		entries[1].Name != "outside-link" ||
		entries[1].Kind != KindSymlinkSkipped ||
		entries[1].Size != 0 {
		t.Fatalf("list entries = %#v, want note plus symlink-skipped", listResp.Entries)
	}
}

func TestHandlerAtomicWriteUsesExclusiveTempAndMode(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	base := filepath.Join(stateRoot, "scope", "rw")
	if err := os.MkdirAll(base, 0o700); err != nil {
		t.Fatalf("MkdirAll base returned error: %v", err)
	}
	attackerPath := filepath.Join(t.TempDir(), "attacker.txt")
	if err := os.WriteFile(attackerPath, []byte("attacker"), 0o600); err != nil {
		t.Fatalf("WriteFile attacker returned error: %v", err)
	}
	predictableTemp := filepath.Join(base, "note.txt.tmp")
	if err := os.Symlink(attackerPath, predictableTemp); err != nil {
		t.Fatalf("Symlink predictable temp returned error: %v", err)
	}

	handler := mustFilesHandler(t, stateRoot)
	data := []byte("safe replacement")
	if _, err := handler.Handle(ctx, Request{
		Op:    OperationWrite,
		Grant: "rw",
		Path:  "note.txt",
		Data:  stringPtr(base64.StdEncoding.EncodeToString(data)),
	}); err != nil {
		t.Fatalf("write returned error: %v", err)
	}

	target := filepath.Join(base, "note.txt")
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("ReadFile target returned error: %v", err)
	}
	if !reflect.DeepEqual(got, data) {
		t.Fatalf("target data = %q, want %q", got, data)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("Stat target returned error: %v", err)
	}
	if gotMode := info.Mode().Perm(); gotMode != fileMode {
		t.Fatalf("target mode = %o, want %o", gotMode, fileMode)
	}
	attacker, err := os.ReadFile(attackerPath)
	if err != nil {
		t.Fatalf("ReadFile attacker returned error: %v", err)
	}
	if string(attacker) != "attacker" {
		t.Fatalf("attacker file = %q, want unchanged", attacker)
	}
	if _, err := os.Lstat(predictableTemp); err != nil {
		t.Fatalf("predictable temp symlink was removed or followed: %v", err)
	}
	leftovers, err := filepath.Glob(filepath.Join(base, ".note.txt-*.tmp"))
	if err != nil {
		t.Fatalf("Glob temp leftovers returned error: %v", err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("leftover exclusive temp files = %v, want none", leftovers)
	}
}

func TestHandlerRejectsUnknownGrantReadOnlyWriteTraversalAndSymlink(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	encoded := base64.StdEncoding.EncodeToString([]byte("data"))

	tests := []struct {
		name string
		req  Request
		code string
	}{
		{
			name: "unknown read grant",
			req:  Request{Op: OperationRead, Grant: "missing", Path: "note.txt"},
			code: "unknown_grant",
		},
		{
			name: "unknown write grant",
			req:  Request{Op: OperationWrite, Grant: "missing", Path: "note.txt", Data: &encoded},
			code: "unknown_grant",
		},
		{
			name: "read-only write",
			req:  Request{Op: OperationWrite, Grant: "ro", Path: "note.txt", Data: &encoded},
			code: "read_only_grant",
		},
		{
			name: "traversal",
			req:  Request{Op: OperationRead, Grant: "rw", Path: "../escape"},
			code: "path_traversal",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := handler.Handle(ctx, tt.req)
			assertFilesErrorCode(t, err, tt.code)
		})
	}

	if _, err := handler.Handle(ctx, Request{
		Op:    OperationWrite,
		Grant: "rw",
		Path:  "safe.txt",
		Data:  &encoded,
	}); err != nil {
		t.Fatalf("seed write returned error: %v", err)
	}
	base := filepath.Join(stateRoot, "scope", "rw")
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(base, "escape")); err != nil {
		t.Fatalf("Symlink returned error: %v", err)
	}
	_, err := handler.Handle(ctx, Request{Op: OperationRead, Grant: "rw", Path: "escape/secret.txt"})
	assertFilesErrorCode(t, err, "path_traversal")
}

func TestHandlerSharedGrantRoleGate(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	shared := true
	handler, err := NewHandler(Options{
		StateRoot: stateRoot,
		Grants: []Grant{
			{
				Name:   "shared-rw",
				Root:   "scope",
				Shared: &shared,
				Roles: RoleAccessMap{
					RoleOwner:           AccessReadWrite,
					RoleHouseholdMember: AccessReadOnly,
				},
			},
			{
				Name:   "shared-ro",
				Root:   "scope",
				Shared: &shared,
				Roles: RoleAccessMap{
					RoleOwner:           AccessReadOnly,
					RoleHouseholdMember: AccessReadOnly,
				},
			},
			{Name: "flat-ro", Root: "scope", Access: AccessReadOnly},
		},
		Principals: []Principal{
			{PrincipalKey: "peer-owner", Role: RoleOwner},
			{PrincipalKey: "peer-member", Role: RoleHouseholdMember},
		},
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}

	ownerCtx := ContextWithPrincipalKey(ctx, "peer-owner")
	memberCtx := ContextWithPrincipalKey(ctx, "peer-member")
	encoded := base64.StdEncoding.EncodeToString([]byte("shared data"))

	if _, err := handler.Handle(ownerCtx, Request{
		Op:    OperationWrite,
		Grant: "shared-rw",
		Path:  "note.txt",
		Data:  &encoded,
	}); err != nil {
		t.Fatalf("owner write returned error: %v", err)
	}

	info, err := os.Stat(filepath.Join(stateRoot, "scope", "shared-rw", "note.txt"))
	if err != nil {
		t.Fatalf("Stat shared write target returned error: %v", err)
	}
	if gotMode := info.Mode().Perm(); gotMode != fileMode {
		t.Fatalf("shared write mode = %o, want %o", gotMode, fileMode)
	}

	sharedROBase := filepath.Join(stateRoot, "scope", "shared-ro")
	if err := os.MkdirAll(filepath.Join(sharedROBase, "docs"), directoryMode); err != nil {
		t.Fatalf("MkdirAll shared-ro base returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sharedROBase, "docs", "seed.txt"), []byte("seed"), fileMode); err != nil {
		t.Fatalf("WriteFile seed returned error: %v", err)
	}

	for _, op := range []Operation{OperationRead, OperationList, OperationStat} {
		t.Run(string(op), func(t *testing.T) {
			path := "docs/seed.txt"
			if op == OperationList {
				path = "docs"
			}
			_, err := handler.Handle(memberCtx, Request{
				Op:    op,
				Grant: "shared-ro",
				Path:  path,
			})
			if err != nil {
				t.Fatalf("member %s returned error: %v", op, err)
			}
		})
	}

	_, err = handler.Handle(memberCtx, Request{
		Op:    OperationWrite,
		Grant: "shared-ro",
		Path:  "denied.txt",
		Data:  &encoded,
	})
	assertFilesErrorCode(t, err, "role_forbidden")

	_, err = handler.Handle(ContextWithPrincipalKey(ctx, "unbound-peer"), Request{
		Op:    OperationWrite,
		Grant: "shared-rw",
		Path:  "default-denied.txt",
		Data:  &encoded,
	})
	assertFilesErrorCode(t, err, "role_forbidden")

	_, err = handler.Handle(ownerCtx, Request{
		Op:    OperationWrite,
		Grant: "shared-ro",
		Path:  "owner-denied.txt",
		Data:  &encoded,
	})
	assertFilesErrorCode(t, err, "role_forbidden")

	_, err = handler.Handle(ownerCtx, Request{
		Op:    OperationWrite,
		Grant: "flat-ro",
		Path:  "flat-denied.txt",
		Data:  &encoded,
	})
	assertFilesErrorCode(t, err, "read_only_grant")
}

func TestHandlerRejectsEveryOperationWhenSharedRoleHasNoEntry(t *testing.T) {
	ctx := ContextWithPrincipalKey(context.Background(), "peer-member")
	handler := &Handler{
		stateRoot: t.TempDir(),
		grants: map[string]resolvedGrant{
			"owner-only": {
				name:  "owner-only",
				rel:   "scope/owner-only",
				roles: RoleAccessMap{RoleOwner: AccessReadWrite},
			},
		},
		principals: map[string]Role{"peer-member": RoleHouseholdMember},
	}
	encoded := base64.StdEncoding.EncodeToString([]byte("data"))

	for _, req := range []Request{
		{Op: OperationList, Grant: "owner-only", Path: "note.txt"},
		{Op: OperationRead, Grant: "owner-only", Path: "note.txt"},
		{Op: OperationStat, Grant: "owner-only", Path: "note.txt"},
		{Op: OperationWrite, Grant: "owner-only", Path: "note.txt", Data: &encoded},
	} {
		t.Run(string(req.Op), func(t *testing.T) {
			_, err := handler.Handle(ctx, req)
			assertFilesErrorCode(t, err, "role_forbidden")
		})
	}
}

func TestDecodeRequestRejectsDuplicateKeysAndMalformedShapes(t *testing.T) {
	tests := []string{
		`{"op":"read","op":"write","grant":"rw","path":"note.txt","data":"AA=="}`,
		`{"op":"read","grant":"rw","path":"note.txt","extra":true}`,
		`{"op":"read","grant":"rw","path":"note.txt","role":"owner"}`,
		`{"op":"read","grant":"rw","path":"note.txt","principal":"peer-owner"}`,
		`{"op":"read","grant":"rw","path":"note.txt","as":"owner"}`,
		`{"op":["read"],"grant":"rw","path":"note.txt"}`,
		`{"op":"read","grant":"rw","path":`,
	}

	for _, raw := range tests {
		t.Run(raw, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("DecodeRequest panicked: %v", recovered)
				}
			}()
			if _, err := DecodeRequest([]byte(raw)); err == nil {
				t.Fatal("DecodeRequest returned nil error, want rejection")
			}
		})
	}

	if _, err := DecodeRequest([]byte(`{"op":"bogus","grant":"rw","path":"note.txt"}`)); err == nil {
		t.Fatal("DecodeRequest accepted unknown op")
	} else {
		assertFilesErrorCode(t, err, "unknown_op")
	}
}

func TestHandlerRejectsReadAndWriteExceedingSizeCap(t *testing.T) {
	ctx := context.Background()
	stateRoot := t.TempDir()
	handler := mustFilesHandler(t, stateRoot)
	data := make([]byte, int(MaxFileBytes)+1)
	encoded := base64.StdEncoding.EncodeToString(data)

	_, err := handler.Handle(ctx, Request{
		Op:    OperationWrite,
		Grant: "rw",
		Path:  "too-large.bin",
		Data:  &encoded,
	})
	assertFilesErrorCode(t, err, "file_too_large")

	oversizedPath := filepath.Join(stateRoot, "scope", "rw", "oversized.bin")
	if err := os.WriteFile(oversizedPath, data, 0o600); err != nil {
		t.Fatalf("WriteFile oversized fixture returned error: %v", err)
	}
	_, err = handler.Handle(ctx, Request{
		Op:    OperationRead,
		Grant: "rw",
		Path:  "oversized.bin",
	})
	assertFilesErrorCode(t, err, "file_too_large")
}

func mustFilesHandler(t *testing.T, stateRoot string) *Handler {
	t.Helper()

	handler, err := NewHandler(Options{
		StateRoot: stateRoot,
		Grants: []Grant{
			{Name: "rw", Root: "scope", Access: AccessReadWrite},
			{Name: "ro", Root: "scope", Access: AccessReadOnly},
		},
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}
	return handler
}

func assertFilesErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("error = nil, want %s", code)
	}
	var requestErr *RequestError
	if !errors.As(err, &requestErr) {
		t.Fatalf("error = %T %v, want *RequestError", err, err)
	}
	if requestErr.Code != code {
		t.Fatalf("error code = %q, want %q; err=%v", requestErr.Code, code, err)
	}
	if strings.TrimSpace(requestErr.Message) == "" {
		t.Fatalf("error message is empty for code %q", code)
	}
}

func stringPtr(value string) *string {
	return &value
}
