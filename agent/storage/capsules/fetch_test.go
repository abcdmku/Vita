package capsules

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFetchCapsuleVerifiesSRIStagesAndReturnsCachePath(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)

	archive := capsuleArchive(t, []tarEntry{
		{name: "manifest.json", body: `{"id":"local.test.capsule","version":"1.0.0"}`},
		{name: "main.ts", body: `console.log("ok");`},
	})
	source := writeArtifact(t, archive)
	integrity := sriFor(archive)
	logs := captureLogs(t)

	localPath, err := FetchCapsule(context.Background(), source, integrity)
	if err != nil {
		t.Fatalf("FetchCapsule returned error: %v", err)
	}

	wantPath := filepath.Join(cacheRoot, "local.test.capsule", "1.0.0")
	if localPath != wantPath {
		t.Fatalf("localPath = %q, want %q", localPath, wantPath)
	}
	assertRegularFile(t, filepath.Join(localPath, "manifest.json"))
	assertRegularFile(t, filepath.Join(localPath, "main.ts"))
	if got := readFile(t, filepath.Join(localPath, "main.ts")); got != `console.log("ok");` {
		t.Fatalf("main.ts = %q, want capsule payload", got)
	}
	if !strings.Contains(logs.String(), "VITA-CAPSULE-FETCH: id=local.test.capsule") ||
		!strings.Contains(logs.String(), "verified=OK status=OK") {
		t.Fatalf("fetch log = %q, want verified marker", logs.String())
	}
}

func TestFetchCapsuleRejectsSRIMismatchWithoutStaging(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)

	archive := capsuleArchive(t, []tarEntry{
		{name: "manifest.json", body: `{"id":"local.test.capsule","version":"1.0.0"}`},
		{name: "main.ts", body: `console.log("ok");`},
	})
	source := writeArtifact(t, append(append([]byte(nil), archive...), byte('x')))
	logs := captureLogs(t)

	localPath, err := FetchCapsule(context.Background(), source, sriFor(archive))
	if localPath != "" {
		t.Fatalf("localPath = %q, want empty on SRI mismatch", localPath)
	}
	if !errors.Is(err, ErrSRIMismatch) {
		t.Fatalf("FetchCapsule error = %v, want ErrSRIMismatch", err)
	}
	if _, statErr := os.Stat(filepath.Join(cacheRoot, "local.test.capsule", "1.0.0")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("staged target stat error = %v, want not exist", statErr)
	}
	if _, statErr := os.Stat(cacheRoot); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("cache root stat error = %v, want not exist after pre-extract reject", statErr)
	}
	if !strings.Contains(logs.String(), "VITA-CAPSULE-FETCH-REJECT: reason=sri_mismatch") {
		t.Fatalf("fetch log = %q, want sri mismatch reject marker", logs.String())
	}
}

func TestFetchCapsuleRemovesTempOnCompletenessFailure(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)

	archive := capsuleArchive(t, []tarEntry{
		{name: "main.ts", body: `console.log("partial");`},
	})
	source := writeArtifact(t, archive)
	logs := captureLogs(t)

	localPath, err := FetchCapsule(context.Background(), source, sriFor(archive))
	if localPath != "" {
		t.Fatalf("localPath = %q, want empty on incomplete archive", localPath)
	}
	if err == nil {
		t.Fatal("FetchCapsule returned nil error, want completeness failure")
	}
	assertCacheRootEmpty(t, cacheRoot)
	if !strings.Contains(logs.String(), "VITA-CAPSULE-FETCH-ERROR: FAILSAFE") {
		t.Fatalf("fetch log = %q, want fail-safe marker", logs.String())
	}
}

func TestFetchCapsuleRejectsTraversalWithoutPartialExtract(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	t.Setenv(cacheRootEnv, cacheRoot)

	archive := capsuleArchive(t, []tarEntry{
		{name: "../evil", body: "owned"},
		{name: "manifest.json", body: `{"id":"local.test.capsule","version":"1.0.0"}`},
		{name: "main.ts", body: `console.log("ok");`},
	})
	source := writeArtifact(t, archive)

	localPath, err := FetchCapsule(context.Background(), source, sriFor(archive))
	if localPath != "" {
		t.Fatalf("localPath = %q, want empty on traversal archive", localPath)
	}
	if err == nil || !strings.Contains(err.Error(), "escapes capsule root") {
		t.Fatalf("FetchCapsule error = %v, want traversal rejection", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, "evil")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("outside file stat error = %v, want not exist", statErr)
	}
	assertCacheRootEmpty(t, cacheRoot)
}

type tarEntry struct {
	name string
	body string
}

func capsuleArchive(t *testing.T, entries []tarEntry) []byte {
	t.Helper()

	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for _, entry := range entries {
		header := &tar.Header{
			Name: entry.name,
			Mode: 0o600,
			Size: int64(len(entry.body)),
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatalf("WriteHeader returned error: %v", err)
		}
		if _, err := writer.Write([]byte(entry.body)); err != nil {
			t.Fatalf("Write returned error: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("tar writer Close returned error: %v", err)
	}
	return buffer.Bytes()
}

func writeArtifact(t *testing.T, content []byte) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "capsule.tar.zst")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	return path
}

func sriFor(content []byte) string {
	sum := sha256.Sum256(content)
	return "sha256-" + base64.StdEncoding.EncodeToString(sum[:])
}

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()

	var buffer bytes.Buffer
	previousWriter := log.Writer()
	previousFlags := log.Flags()
	log.SetOutput(&buffer)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
	})
	return &buffer
}

func assertRegularFile(t *testing.T, path string) {
	t.Helper()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s returned error: %v", path, err)
	}
	if !info.Mode().IsRegular() {
		t.Fatalf("%s mode = %s, want regular file", path, info.Mode())
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	return string(content)
}

func assertCacheRootEmpty(t *testing.T, cacheRoot string) {
	t.Helper()

	entries, err := os.ReadDir(cacheRoot)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		t.Fatalf("ReadDir cache root returned error: %v", err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("cache root entries = %v, want empty", names)
	}
}
