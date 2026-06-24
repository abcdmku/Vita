package export

import (
	"errors"
	"strings"
	"testing"
)

func TestParseManifestAcceptsValidCanonicalManifest(t *testing.T) {
	manifest := validManifest(t, map[string][]byte{
		"alpha.txt":  []byte("alpha"),
		"state.json": []byte(`{"hostname":"vita-node-7"}` + "\n"),
	})
	raw := renderManifest(t, manifest)

	parsed, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("ParseManifest returned error: %v", err)
	}
	if parsed.RootDigest != manifest.RootDigest {
		t.Fatalf("RootDigest = %q, want %q", parsed.RootDigest, manifest.RootDigest)
	}
	if len(parsed.Entries) != len(manifest.Entries) {
		t.Fatalf("entries = %d, want %d", len(parsed.Entries), len(manifest.Entries))
	}
}

func TestParseManifestRejectsMalformedOversizedAndDuplicateKeys(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  []byte
		code string
	}{
		{
			name: "malformed",
			raw:  []byte(`{"formatVersion":`),
			code: "invalid_manifest",
		},
		{
			name: "duplicate top level",
			raw: []byte(
				`{"formatVersion":1,"formatVersion":1,"entries":[],"rootDigest":"` +
					mustRootDigest(t, nil) + `"}`,
			),
			code: "invalid_manifest",
		},
		{
			name: "duplicate entry",
			raw: []byte(
				`{"entries":[{"path":"a.txt","path":"b.txt","kind":"file","bytes":0,"integrity":"` +
					SHA256Integrity(nil) + `"}],"formatVersion":1,"rootDigest":"` + mustRootDigest(t, []Entry{{
					Path:      "a.txt",
					Kind:      EntryKindFile,
					Bytes:     0,
					Integrity: SHA256Integrity(nil),
				}}) + `"}`,
			),
			code: "invalid_manifest",
		},
		{
			name: "too deep",
			raw:  []byte(strings.Repeat("[", 1002) + strings.Repeat("]", 1002)),
			code: "invalid_manifest",
		},
		{
			name: "oversized",
			raw:  make([]byte, MaxManifestBytes+1),
			code: "size_limit",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseManifest(tc.raw)
			assertBundleCode(t, err, tc.code)
		})
	}
}

func TestParseManifestRejectsInvalidIntegrity(t *testing.T) {
	manifest := validManifest(t, map[string][]byte{"a.txt": []byte("alpha")})
	manifest.Entries[0].Integrity = "sha512-not-this-format"
	raw := []byte(
		`{"entries":[{"bytes":5,"integrity":"sha512-not-this-format","kind":"file","path":"a.txt"}],` +
			`"formatVersion":1,"rootDigest":"` + manifest.RootDigest + `"}` + "\n",
	)

	_, err := ParseManifest(raw)
	assertBundleCode(t, err, "invalid_manifest")
}

func TestParseManifestRejectsUnsafePaths(t *testing.T) {
	for _, path := range []string{
		"",
		".",
		"..",
		"/abs",
		"../escape",
		"a//b",
		"a/./b",
		"a/../b",
		`a\b`,
		"a\x00b",
	} {
		t.Run(path, func(t *testing.T) {
			manifest := validManifest(t, map[string][]byte{"safe.txt": []byte("alpha")})
			manifest.Entries[0].Path = path
			raw := []byte(
				`{"entries":[{"bytes":5,"integrity":"` + manifest.Entries[0].Integrity +
					`","kind":"file","path":` + quoteForTest(t, path) + `}],` +
					`"formatVersion":1,"rootDigest":"` + manifest.RootDigest + `"}` + "\n",
			)

			_, err := ParseManifest(raw)
			assertBundleCode(t, err, "path_traversal")
		})
	}
}

func TestParseManifestRejectsInlineSecretMetadata(t *testing.T) {
	t.Run("created marker", func(t *testing.T) {
		raw := []byte(
			`{"createdMarker":"api_key=test-only-not-a-real-secret","entries":[],"formatVersion":1,"rootDigest":"` +
				mustRootDigest(t, nil) + `"}` + "\n",
		)

		_, err := ParseManifest(raw)
		assertBundleCode(t, err, "inline_secret_metadata")
	})

	t.Run("path", func(t *testing.T) {
		integrity := SHA256Integrity([]byte("metadata"))
		root := mustRootDigest(t, []Entry{{
			Path:      "private-key.txt",
			Kind:      EntryKindFile,
			Bytes:     int64(len("metadata")),
			Integrity: integrity,
		}})
		raw := []byte(
			`{"entries":[{"bytes":8,"integrity":"` + integrity +
				`","kind":"file","path":"private-key.txt"}],"formatVersion":1,"rootDigest":"` + root + `"}` + "\n",
		)

		_, err := ParseManifest(raw)
		assertBundleCode(t, err, "inline_secret_metadata")
	})
}

func TestParseManifestRejectsDuplicatePathRegardlessOfKind(t *testing.T) {
	// Two entries SHARE a path but differ in kind. They are already in canonical
	// (compareEntries) order — "config" < "file" — so the sort check passes; only the
	// path-uniqueness invariant catches them. The bundle lookup is keyed by path ALONE,
	// so allowing this would let one output path be claimed twice.
	content := []byte("dup")
	integrity := SHA256Integrity(content)
	entries := []Entry{
		{Path: "dup.txt", Kind: EntryKindConfig, Bytes: int64(len(content)), Integrity: integrity},
		{Path: "dup.txt", Kind: EntryKindFile, Bytes: int64(len(content)), Integrity: integrity},
	}
	if compareEntries(entries[0], entries[1]) != -1 {
		t.Fatalf("test precondition: entries must be in canonical sort order (config < file)")
	}
	root := mustRootDigest(t, entries)
	raw := []byte(
		`{"entries":[` +
			`{"bytes":3,"integrity":"` + integrity + `","kind":"config","path":"dup.txt"},` +
			`{"bytes":3,"integrity":"` + integrity + `","kind":"file","path":"dup.txt"}` +
			`],"formatVersion":1,"rootDigest":"` + root + `"}` + "\n",
	)

	_, err := ParseManifest(raw)
	assertBundleCode(t, err, "duplicate_path")
}

func validManifest(t *testing.T, contents map[string][]byte) Manifest {
	t.Helper()

	entries := make([]Entry, 0, len(contents))
	for path, content := range contents {
		entries = append(entries, Entry{
			Path:      path,
			Kind:      entryKindForTest(path),
			Bytes:     int64(len(content)),
			Integrity: SHA256Integrity(content),
		})
	}
	sortEntriesForTest(entries)
	root := mustRootDigest(t, entries)
	return Manifest{
		FormatVersion: ManifestFormatVersion,
		Entries:       entries,
		RootDigest:    root,
	}
}

func entryKindForTest(path string) EntryKind {
	switch path {
	case "state.json":
		return EntryKindConfig
	case "pds-sync-state.json":
		return EntryKindPDS
	default:
		return EntryKindFile
	}
}

func sortEntriesForTest(entries []Entry) {
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && compareEntries(entries[j-1], entries[j]) > 0; j-- {
			entries[j-1], entries[j] = entries[j], entries[j-1]
		}
	}
}

func renderManifest(t *testing.T, manifest Manifest) []byte {
	t.Helper()

	raw, err := RenderManifest(manifest)
	if err != nil {
		t.Fatalf("RenderManifest returned error: %v", err)
	}
	return raw
}

func mustRootDigest(t *testing.T, entries []Entry) string {
	t.Helper()

	root, err := RootDigest(entries)
	if err != nil {
		t.Fatalf("RootDigest returned error: %v", err)
	}
	return root
}

func quoteForTest(t *testing.T, value string) string {
	t.Helper()

	quoted, err := quoteJSONString(value)
	if err != nil {
		t.Fatalf("quoteJSONString returned error: %v", err)
	}
	return quoted
}

func assertBundleCode(t *testing.T, err error, code string) {
	t.Helper()

	var bundleErr *BundleError
	if !errors.As(err, &bundleErr) {
		t.Fatalf("error = %v, want BundleError %q", err, code)
	}
	if bundleErr.Code != code {
		t.Fatalf("BundleError code = %q, want %q; err=%v", bundleErr.Code, code, err)
	}
}
