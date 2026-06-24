package export

import "testing"

func TestVerifyBundleAcceptsMatchingContent(t *testing.T) {
	contents := map[string][]byte{
		"alpha.txt":           []byte("alpha"),
		"pds-sync-state.json": []byte(`{"cursor":42}` + "\n"),
		"state.json":          []byte(`{"hostname":"vita-node-7"}` + "\n"),
	}
	manifest := validManifest(t, contents)

	result, err := VerifyBundle(renderManifest(t, manifest), lookupMap(contents))
	if err != nil {
		t.Fatalf("VerifyBundle returned error: %v", err)
	}
	if !result.Verified {
		t.Fatal("Verified = false, want true")
	}
	if result.Entries != len(contents) {
		t.Fatalf("Entries = %d, want %d", result.Entries, len(contents))
	}
	if result.Bytes != int64(len(contents["alpha.txt"])+len(contents["pds-sync-state.json"])+len(contents["state.json"])) {
		t.Fatalf("Bytes = %d, want content byte total", result.Bytes)
	}
	if result.RootDigest != manifest.RootDigest {
		t.Fatalf("RootDigest = %q, want %q", result.RootDigest, manifest.RootDigest)
	}
}

func TestVerifyBundleRejectsEntryIntegrityMismatch(t *testing.T) {
	contents := map[string][]byte{"note.txt": []byte("untampered")}
	manifest := validManifest(t, contents)

	_, err := VerifyBundle(renderManifest(t, manifest), lookupMap(map[string][]byte{
		"note.txt": []byte("tampered"),
	}))

	assertBundleCode(t, err, "integrity_mismatch")
}

func TestVerifyBundleRejectsRootDigestMismatch(t *testing.T) {
	contents := map[string][]byte{"note.txt": []byte("untampered")}
	manifest := validManifest(t, contents)
	manifest.RootDigest = SHA256Integrity([]byte("wrong root"))

	_, err := VerifyBundle(renderManifestWithoutValidation(t, manifest), lookupMap(contents))

	assertBundleCode(t, err, "integrity_mismatch")
}

func TestVerifyBundleRejectsMissingContent(t *testing.T) {
	contents := map[string][]byte{"note.txt": []byte("untampered")}
	manifest := validManifest(t, contents)

	_, err := VerifyBundle(renderManifest(t, manifest), lookupMap(nil))

	assertBundleCode(t, err, "integrity_mismatch")
}

func lookupMap(contents map[string][]byte) LookupFunc {
	return func(path string) ([]byte, error) {
		content, ok := contents[path]
		if !ok {
			return nil, errMissingContentForTest
		}
		out := make([]byte, len(content))
		copy(out, content)
		return out, nil
	}
}

var errMissingContentForTest = &BundleError{Code: "not_found", Message: "missing content"}

func renderManifestWithoutValidation(t *testing.T, manifest Manifest) []byte {
	t.Helper()

	entries, err := CanonicalEntriesJSON(manifest.Entries)
	if err != nil {
		t.Fatalf("CanonicalEntriesJSON returned error: %v", err)
	}
	return []byte(
		`{"entries":` + string(entries) +
			`,"formatVersion":1,"rootDigest":"` + manifest.RootDigest + `"}` + "\n",
	)
}
