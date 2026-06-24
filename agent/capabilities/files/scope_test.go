package files

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveWithinScopeAcceptsInScopeRelativePaths(t *testing.T) {
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "docs"), 0o700); err != nil {
		t.Fatalf("MkdirAll docs returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(base, "docs", "note.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatalf("WriteFile note returned error: %v", err)
	}

	got, ok := ResolveWithinScope(base, "docs/note.txt")
	if !ok {
		t.Fatal("ResolveWithinScope rejected an in-scope relative path")
	}
	want := filepath.Join(base, "docs", "note.txt")
	if got != want {
		t.Fatalf("resolved path = %q, want %q", got, want)
	}

	missing, ok := ResolveWithinScope(base, "docs/new.txt")
	if !ok {
		t.Fatal("ResolveWithinScope rejected an in-scope missing leaf")
	}
	if missing != filepath.Join(base, "docs", "new.txt") {
		t.Fatalf("missing leaf = %q, want under docs", missing)
	}
}

func TestResolveWithinScopeRejectsTraversalAndMalformedSegments(t *testing.T) {
	base := t.TempDir()
	tests := []string{
		"",
		".",
		"..",
		"/absolute",
		"../escape",
		"docs/../escape",
		"docs/./note.txt",
		"docs//note.txt",
		"docs/",
		"docs/\x00note.txt",
		`docs\note.txt`,
	}

	for _, rel := range tests {
		t.Run(rel, func(t *testing.T) {
			if got, ok := ResolveWithinScope(base, rel); ok {
				t.Fatalf("ResolveWithinScope(%q) = %q, true; want rejected", rel, got)
			}
		})
	}
}

func TestResolveWithinScopeRejectsSymlinkEscape(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatalf("WriteFile outside secret returned error: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(base, "link")); err != nil {
		t.Fatalf("Symlink returned error: %v", err)
	}

	if got, ok := ResolveWithinScope(base, "link"); ok {
		t.Fatalf("ResolveWithinScope accepted symlink itself: %q", got)
	}
	if got, ok := ResolveWithinScope(base, "link/secret.txt"); ok {
		t.Fatalf("ResolveWithinScope accepted symlink escape: %q", got)
	}
}
