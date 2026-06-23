package capsules

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

var zstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}

func TestFetchCapsuleVerifiesSRIStagesAndReturnsCachePath(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)

	archive := capsuleArchive(t, []tarEntry{
		{name: "manifest.json", body: `{"id":"local.test.capsule","version":"1.0.0"}`},
		{name: "main.ts", body: `console.log("ok");`},
	})
	if !bytes.HasPrefix(archive, zstdMagic) {
		t.Fatalf("capsuleArchive produced % x, want zstd magic", archive[:4])
	}
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
	tests := []struct {
		name    string
		entry   tarEntry
		wantErr string
	}{
		{
			name:    "relative parent escape",
			entry:   tarEntry{name: "../evil", body: "owned"},
			wantErr: "escapes capsule root",
		},
		{
			name:    "absolute path escape",
			entry:   tarEntry{name: "/evil", body: "owned"},
			wantErr: "escapes capsule root",
		},
		{
			name:    "symlink escaping linkname rejected",
			entry:   tarEntry{name: "link", typeflag: tar.TypeSymlink, linkname: "../evil"},
			wantErr: "unsupported type",
		},
		{
			name:    "hardlink escaping linkname rejected",
			entry:   tarEntry{name: "link", typeflag: tar.TypeLink, linkname: "../evil"},
			wantErr: "unsupported type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			cacheRoot := filepath.Join(root, "cache")
			t.Setenv(cacheRootEnv, cacheRoot)

			archive := capsuleArchive(t, []tarEntry{
				tt.entry,
				{name: "manifest.json", body: `{"id":"local.test.capsule","version":"1.0.0"}`},
				{name: "main.ts", body: `console.log("ok");`},
			})
			source := writeArtifact(t, archive)

			localPath, err := FetchCapsule(context.Background(), source, sriFor(archive))
			if localPath != "" {
				t.Fatalf("localPath = %q, want empty on traversal archive", localPath)
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("FetchCapsule error = %v, want %q rejection", err, tt.wantErr)
			}
			if _, statErr := os.Stat(filepath.Join(root, "evil")); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("outside file stat error = %v, want not exist", statErr)
			}
			assertCacheRootEmpty(t, cacheRoot)
		})
	}
}

func TestFetchCapsuleRejectsExtractionResourceCapsWithoutStaging(t *testing.T) {
	tests := []struct {
		name    string
		archive func(t *testing.T) []byte
		wantErr string
	}{
		{
			name: "per entry size cap",
			archive: func(t *testing.T) []byte {
				return capsuleArchive(t, []tarEntry{
					{name: "manifest.json", body: `{"id":"local.test.capsule","version":"1.0.0"}`},
					{name: "main.ts", size: maxCapsuleTarEntryBytes + 1, fill: 'a'},
				})
			},
			wantErr: "per-entry size limit",
		},
		{
			name: "total payload cap",
			archive: func(t *testing.T) []byte {
				entries := []tarEntry{
					{name: "manifest.json", body: `{"id":"local.test.capsule","version":"1.0.0"}`},
					{name: "main.ts", body: `console.log("ok");`},
				}
				for i := 0; i < int(maxCapsuleTarPayloadBytes/maxCapsuleTarEntryBytes)+1; i++ {
					entries = append(entries, tarEntry{
						name: fmt.Sprintf("assets/blob-%02d.bin", i),
						size: maxCapsuleTarEntryBytes,
						fill: byte('a' + i%26),
					})
				}
				return capsuleArchive(t, entries)
			},
			wantErr: "total payload size limit",
		},
		{
			name: "entry count cap",
			archive: func(t *testing.T) []byte {
				entries := make([]tarEntry, 0, maxCapsuleTarEntries+1)
				for i := 0; i < maxCapsuleTarEntries+1; i++ {
					entries = append(entries, tarEntry{name: fmt.Sprintf("empty-%04d", i)})
				}
				return capsuleArchive(t, entries)
			},
			wantErr: "entry limit",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cacheRoot := filepath.Join(t.TempDir(), "cache")
			t.Setenv(cacheRootEnv, cacheRoot)

			archive := tt.archive(t)
			source := writeArtifact(t, archive)

			localPath, err := FetchCapsule(context.Background(), source, sriFor(archive))
			if localPath != "" {
				t.Fatalf("localPath = %q, want empty on capped archive", localPath)
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("FetchCapsule error = %v, want %q rejection", err, tt.wantErr)
			}
			assertCacheRootEmpty(t, cacheRoot)
		})
	}
}

type tarEntry struct {
	name     string
	body     string
	size     int64
	fill     byte
	typeflag byte
	linkname string
}

func capsuleArchive(t *testing.T, entries []tarEntry) []byte {
	t.Helper()

	var buffer bytes.Buffer
	encoder, err := zstd.NewWriter(&buffer, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatalf("zstd NewWriter returned error: %v", err)
	}
	writer := tar.NewWriter(encoder)
	for _, entry := range entries {
		typeflag := entry.typeflag
		if typeflag == 0 {
			typeflag = tar.TypeReg
		}
		mode := int64(0o600)
		if typeflag == tar.TypeDir {
			mode = 0o700
		}
		header := &tar.Header{
			Name:     entry.name,
			Mode:     mode,
			Typeflag: typeflag,
			Linkname: entry.linkname,
		}
		if typeflag == tar.TypeReg {
			header.Size = int64(len(entry.body))
			if entry.size > 0 {
				header.Size = entry.size
			}
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatalf("WriteHeader returned error: %v", err)
		}
		if typeflag == tar.TypeReg && header.Size > 0 {
			var body io.Reader = strings.NewReader(entry.body)
			if entry.size > 0 {
				body = io.LimitReader(repeatingByteReader{b: entry.fill}, entry.size)
			}
			if _, err := io.Copy(writer, body); err != nil {
				t.Fatalf("tar body write returned error: %v", err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("tar writer Close returned error: %v", err)
	}
	if err := encoder.Close(); err != nil {
		t.Fatalf("zstd encoder Close returned error: %v", err)
	}
	return buffer.Bytes()
}

type repeatingByteReader struct {
	b byte
}

func (r repeatingByteReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = r.b
	}
	return len(p), nil
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
