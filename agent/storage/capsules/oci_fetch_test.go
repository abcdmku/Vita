package capsules

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestFetchOCIImageVerifiesDigestGraphAssemblesRootfsAndReturnsRuntimeConfig(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)

	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{entries: []ociLayerEntry{
			{name: "bin", typeflag: tar.TypeDir},
			{name: "bin/vita-oci-test", body: "#!/bin/sh\necho ok\n", mode: 0o755},
			{name: "etc/config", body: "lower\n"},
		}},
	})
	source := writeArtifact(t, fixture.archive)
	logs := captureLogs(t)

	result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", fixture.imageDigest)
	if err != nil {
		t.Fatalf("FetchOCIImageFor returned error: %v", err)
	}

	wantCapsulePath := filepath.Join(cacheRoot, "local.test.oci", "1.0.0")
	wantRootfsPath := filepath.Join(wantCapsulePath, "rootfs")
	if result.CapsulePath != wantCapsulePath || result.RootFSPath != wantRootfsPath {
		t.Fatalf("result paths = capsule %q rootfs %q, want %q %q", result.CapsulePath, result.RootFSPath, wantCapsulePath, wantRootfsPath)
	}
	if result.ImageDigest != fixture.imageDigest || result.Layers != 1 {
		t.Fatalf("result digest/layers = %q/%d, want %q/1", result.ImageDigest, result.Layers, fixture.imageDigest)
	}
	if !reflect.DeepEqual(result.Entrypoint, []string{"/bin/vita-oci-test", "--serve"}) {
		t.Fatalf("Entrypoint = %#v, want resolved entrypoint+cmd", result.Entrypoint)
	}
	if !reflect.DeepEqual(result.Env, []string{"VITA_TEST=1"}) {
		t.Fatalf("Env = %#v, want config env", result.Env)
	}
	if got := readFile(t, filepath.Join(wantRootfsPath, "etc/config")); got != "lower\n" {
		t.Fatalf("assembled config = %q, want lower layer file", got)
	}
	info, err := os.Stat(filepath.Join(wantRootfsPath, "bin/vita-oci-test"))
	if err != nil {
		t.Fatalf("stat entrypoint returned error: %v", err)
	}
	if info.Mode().Perm()&0o200 != 0 {
		t.Fatalf("entrypoint mode = %s, want owner write bit removed", info.Mode())
	}
	if !strings.Contains(logs.String(), "VITA-CAPSULE-OCI-FETCH: id=local.test.oci") ||
		!strings.Contains(logs.String(), "image-digest="+ShortOCIDigest(fixture.imageDigest)) ||
		!strings.Contains(logs.String(), "layers=1 verified=OK status=OK") {
		t.Fatalf("fetch log = %q, want verified OCI marker", logs.String())
	}
}

func TestFetchOCIImageIsIdempotentWhenExistingRootfsMatchesVerifiedDigest(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)

	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{entries: []ociLayerEntry{
			{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755},
			{name: "var/data", body: "first\n"},
		}},
	})
	source := writeArtifact(t, fixture.archive)
	integrity := sriFor(fixture.archive)

	first, err := FetchOCIImageFor(context.Background(), source, integrity, "local.test.oci", "1.0.0", fixture.imageDigest)
	if err != nil {
		t.Fatalf("first FetchOCIImageFor returned error: %v", err)
	}
	second, err := FetchOCIImageFor(context.Background(), source, integrity, "local.test.oci", "1.0.0", fixture.imageDigest)
	if err != nil {
		t.Fatalf("second FetchOCIImageFor returned error: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("second result = %#v, want first result %#v", second, first)
	}
	if got := readFile(t, filepath.Join(first.RootFSPath, "var/data")); got != "first\n" {
		t.Fatalf("rootfs file after idempotent fetch = %q, want original content", got)
	}
}

func TestFetchOCIImageAcceptsPlainLayoutTarArtifact(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)

	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{entries: []ociLayerEntry{{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755}}},
	})
	plainArchive := plainOCILayoutTar(t, fixture.files)
	source := writeArtifact(t, plainArchive)

	result, err := FetchOCIImageFor(context.Background(), source, sriFor(plainArchive), "local.test.oci", "1.0.0", fixture.imageDigest)
	if err != nil {
		t.Fatalf("FetchOCIImageFor returned error: %v", err)
	}
	if result.RootFSPath != filepath.Join(cacheRoot, "local.test.oci", "1.0.0", "rootfs") {
		t.Fatalf("RootFSPath = %q, want plain tar artifact assembled", result.RootFSPath)
	}
}

func TestFetchOCIImageRejectsTamperedBlobWithoutStaging(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*ociLayoutFixture)
	}{
		{
			name: "layer blob",
			mutate: func(f *ociLayoutFixture) {
				f.files[blobName(f.layerDigests[0])] = append([]byte("tampered"), f.files[blobName(f.layerDigests[0])]...)
			},
		},
		{
			name: "config blob",
			mutate: func(f *ociLayoutFixture) {
				f.files[blobName(f.configDigest)] = []byte(`{"config":{"Entrypoint":["/bin/other"]}}`)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cacheRoot := filepath.Join(t.TempDir(), "cache")
			t.Setenv(cacheRootEnv, cacheRoot)
			fixture := newOCILayoutFixture(t, []ociTestLayer{
				{entries: []ociLayerEntry{{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755}}},
			})
			tt.mutate(fixture)
			fixture.archive = archiveOCILayout(t, fixture.files)
			source := writeArtifact(t, fixture.archive)
			logs := captureLogs(t)

			result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", fixture.imageDigest)
			if result.CapsulePath != "" || result.RootFSPath != "" {
				t.Fatalf("result = %#v, want empty on tampered blob", result)
			}
			if !errors.Is(err, ErrOCIDigestMismatch) {
				t.Fatalf("FetchOCIImageFor error = %v, want ErrOCIDigestMismatch", err)
			}
			assertCacheRootEmpty(t, cacheRoot)
			if !strings.Contains(logs.String(), "VITA-CAPSULE-OCI-FETCH-REJECT: reason=digest_mismatch status=OK") {
				t.Fatalf("fetch log = %q, want digest mismatch reject", logs.String())
			}
		})
	}
}

func TestFetchOCIImageRejectsManifestDigestMismatchWithoutStaging(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)
	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{entries: []ociLayerEntry{{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755}}},
	})
	source := writeArtifact(t, fixture.archive)
	badDigest := "sha256:" + strings.Repeat("0", 64)
	if badDigest == fixture.imageDigest {
		badDigest = "sha256:" + strings.Repeat("1", 64)
	}

	result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", badDigest)

	if result.CapsulePath != "" || result.RootFSPath != "" {
		t.Fatalf("result = %#v, want empty on digest mismatch", result)
	}
	if !errors.Is(err, ErrOCIDigestMismatch) {
		t.Fatalf("FetchOCIImageFor error = %v, want ErrOCIDigestMismatch", err)
	}
	assertCacheRootEmpty(t, cacheRoot)
}

func TestFetchOCIImageAppliesWhiteoutsAcrossLayerStack(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)
	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{entries: []ociLayerEntry{
			{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755},
			{name: "etc/keep", body: "keep\n"},
			{name: "etc/delete", body: "delete\n"},
			{name: "opaque/old", body: "old\n"},
			{name: "opaque/nested/file", body: "nested\n"},
		}},
		{entries: []ociLayerEntry{
			{name: "etc/.wh.delete"},
			{name: "opaque/.wh..wh..opq"},
			{name: "opaque/new", body: "new\n"},
		}},
	})
	source := writeArtifact(t, fixture.archive)

	result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", fixture.imageDigest)
	if err != nil {
		t.Fatalf("FetchOCIImageFor returned error: %v", err)
	}

	if got := readFile(t, filepath.Join(result.RootFSPath, "etc/keep")); got != "keep\n" {
		t.Fatalf("etc/keep = %q, want lower layer survivor", got)
	}
	assertNotExist(t, filepath.Join(result.RootFSPath, "etc/delete"))
	assertNotExist(t, filepath.Join(result.RootFSPath, "opaque/old"))
	assertNotExist(t, filepath.Join(result.RootFSPath, "opaque/nested/file"))
	if got := readFile(t, filepath.Join(result.RootFSPath, "opaque/new")); got != "new\n" {
		t.Fatalf("opaque/new = %q, want upper layer file", got)
	}
}

func TestFetchOCIImageRejectsLayerStackEntryCapWithoutStaging(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)
	firstLayerEntries := []ociLayerEntry{{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755}}
	for i := 0; i < maxCapsuleTarEntries/2; i++ {
		firstLayerEntries = append(firstLayerEntries, ociLayerEntry{name: fmt.Sprintf("a/file-%04d", i), body: "a"})
	}
	secondLayerEntries := make([]ociLayerEntry, 0, maxCapsuleTarEntries/2+2)
	for i := 0; i < maxCapsuleTarEntries/2+2; i++ {
		secondLayerEntries = append(secondLayerEntries, ociLayerEntry{name: fmt.Sprintf("b/file-%04d", i), body: "b"})
	}
	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{entries: firstLayerEntries},
		{entries: secondLayerEntries},
	})
	source := writeArtifact(t, fixture.archive)

	result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", fixture.imageDigest)

	if result.CapsulePath != "" || result.RootFSPath != "" {
		t.Fatalf("result = %#v, want empty on layer bomb", result)
	}
	if !errors.Is(err, ErrOCIBomb) {
		t.Fatalf("FetchOCIImageFor error = %v, want ErrOCIBomb", err)
	}
	assertCacheRootEmpty(t, cacheRoot)
}

func TestFetchOCIImageRejectsWhiteoutPayloadOverEntryCapWithoutStaging(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)
	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{entries: []ociLayerEntry{
			{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755},
			{name: "etc/delete", body: "delete\n"},
		}},
		{entries: []ociLayerEntry{
			{name: "etc/.wh.delete", size: maxCapsuleTarEntryBytes + 1, fill: 'w'},
		}},
	})
	source := writeArtifact(t, fixture.archive)

	result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", fixture.imageDigest)

	if result.CapsulePath != "" || result.RootFSPath != "" {
		t.Fatalf("result = %#v, want empty on whiteout bomb", result)
	}
	if !errors.Is(err, ErrOCIBomb) {
		t.Fatalf("FetchOCIImageFor error = %v, want ErrOCIBomb", err)
	}
	assertCacheRootEmpty(t, cacheRoot)
}

func TestFetchOCIImageRejectsLayerStackDecodedByteCapWithoutStaging(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)
	firstTrailing := int64(maxCapsuleDecodedTarBytes / 2)
	secondTrailing := int64(maxCapsuleDecodedTarBytes) - firstTrailing + 1
	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{archive: gzipLayerArchiveWithTrailingData(t, []ociLayerEntry{
			{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755},
		}, firstTrailing)},
		{archive: gzipLayerArchiveWithTrailingData(t, nil, secondTrailing)},
	})
	source := writeArtifact(t, fixture.archive)

	result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", fixture.imageDigest)

	if result.CapsulePath != "" || result.RootFSPath != "" {
		t.Fatalf("result = %#v, want empty on decoded-byte bomb", result)
	}
	if !errors.Is(err, ErrOCIBomb) {
		t.Fatalf("FetchOCIImageFor error = %v, want ErrOCIBomb", err)
	}
	assertCacheRootEmpty(t, cacheRoot)
}

func TestFetchOCIImageRejectsLyingHeaderDecodedBombWithoutStaging(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	t.Setenv(cacheRootEnv, cacheRoot)
	fixture := newOCILayoutFixture(t, []ociTestLayer{
		{archive: gzipLayerArchiveWithLyingHeader(t, 1, maxCapsuleDecodedTarBytes)},
	})
	source := writeArtifact(t, fixture.archive)

	result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", fixture.imageDigest)

	if result.CapsulePath != "" || result.RootFSPath != "" {
		t.Fatalf("result = %#v, want empty on lying-header bomb", result)
	}
	if !errors.Is(err, ErrOCIBomb) {
		t.Fatalf("FetchOCIImageFor error = %v, want ErrOCIBomb", err)
	}
	assertCacheRootEmpty(t, cacheRoot)
}

func TestFetchOCIImageRejectsTraversalAndLinksWithoutStaging(t *testing.T) {
	tests := []struct {
		name    string
		entry   ociLayerEntry
		wantErr error
	}{
		{name: "relative parent", entry: ociLayerEntry{name: "../evil", body: "owned"}, wantErr: ErrOCITraversal},
		{name: "absolute path", entry: ociLayerEntry{name: "/evil", body: "owned"}, wantErr: ErrOCITraversal},
		{name: "symlink", entry: ociLayerEntry{name: "link", typeflag: tar.TypeSymlink, linkname: "../evil"}, wantErr: ErrOCITraversal},
		{name: "hardlink", entry: ociLayerEntry{name: "link", typeflag: tar.TypeLink, linkname: "../evil"}, wantErr: ErrOCITraversal},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			cacheRoot := filepath.Join(root, "cache")
			t.Setenv(cacheRootEnv, cacheRoot)
			fixture := newOCILayoutFixture(t, []ociTestLayer{
				{entries: []ociLayerEntry{
					{name: "bin/vita-oci-test", body: "#!/bin/sh\n", mode: 0o755},
					tt.entry,
				}},
			})
			source := writeArtifact(t, fixture.archive)

			result, err := FetchOCIImageFor(context.Background(), source, sriFor(fixture.archive), "local.test.oci", "1.0.0", fixture.imageDigest)

			if result.CapsulePath != "" || result.RootFSPath != "" {
				t.Fatalf("result = %#v, want empty on traversal", result)
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("FetchOCIImageFor error = %v, want %v", err, tt.wantErr)
			}
			if _, statErr := os.Stat(filepath.Join(root, "evil")); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("outside file stat error = %v, want not exist", statErr)
			}
			assertCacheRootEmpty(t, cacheRoot)
		})
	}
}

type ociTestLayer struct {
	entries []ociLayerEntry
	archive []byte
}

type ociLayerEntry struct {
	name     string
	body     string
	size     int64
	fill     byte
	typeflag byte
	linkname string
	mode     int64
}

type ociLayoutFixture struct {
	files        map[string][]byte
	archive      []byte
	imageDigest  string
	configDigest string
	layerDigests []string
}

func newOCILayoutFixture(t *testing.T, layers []ociTestLayer) *ociLayoutFixture {
	t.Helper()

	files := map[string][]byte{
		ociLayoutFile: []byte(`{"imageLayoutVersion":"1.0.0"}`),
	}

	config := []byte(`{"architecture":"amd64","os":"linux","config":{"Env":["VITA_TEST=1"],"Entrypoint":["/bin/vita-oci-test"],"Cmd":["--serve"],"WorkingDir":"/"}}`)
	configDigest := digestBytes(config)
	files[blobName(configDigest)] = config

	layerDescriptors := make([]ociDescriptor, 0, len(layers))
	layerDigests := make([]string, 0, len(layers))
	for _, layer := range layers {
		layerBytes := layer.archive
		if layerBytes == nil {
			layerBytes = gzipLayerArchive(t, layer.entries)
		}
		layerDigest := digestBytes(layerBytes)
		layerDigests = append(layerDigests, layerDigest)
		files[blobName(layerDigest)] = layerBytes
		layerDescriptors = append(layerDescriptors, ociDescriptor{
			MediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
			Digest:    layerDigest,
			Size:      int64(len(layerBytes)),
		})
	}

	manifestRaw := mustJSON(t, ociImageManifest{
		SchemaVersion: 2,
		MediaType:     "application/vnd.oci.image.manifest.v1+json",
		Config: ociDescriptor{
			MediaType: "application/vnd.oci.image.config.v1+json",
			Digest:    configDigest,
			Size:      int64(len(config)),
		},
		Layers: layerDescriptors,
	})
	imageDigest := digestBytes(manifestRaw)
	files[blobName(imageDigest)] = manifestRaw

	indexRaw := mustJSON(t, ociIndex{
		SchemaVersion: 2,
		MediaType:     "application/vnd.oci.image.index.v1+json",
		Manifests: []ociDescriptor{
			{
				MediaType: "application/vnd.oci.image.manifest.v1+json",
				Digest:    imageDigest,
				Size:      int64(len(manifestRaw)),
				Platform: &ociPlatform{
					Architecture: "amd64",
					OS:           "linux",
				},
			},
		},
	})
	files[ociIndexFile] = indexRaw

	fixture := &ociLayoutFixture{
		files:        files,
		imageDigest:  imageDigest,
		configDigest: configDigest,
		layerDigests: layerDigests,
	}
	fixture.archive = archiveOCILayout(t, files)
	return fixture
}

func gzipLayerArchive(t *testing.T, entries []ociLayerEntry) []byte {
	t.Helper()

	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(gzipWriter)
	writeOCITestLayerEntries(t, writer, entries)
	if err := writer.Close(); err != nil {
		t.Fatalf("tar writer Close returned error: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("gzip writer Close returned error: %v", err)
	}
	return buffer.Bytes()
}

func gzipLayerArchiveWithTrailingData(t *testing.T, entries []ociLayerEntry, trailingBytes int64) []byte {
	t.Helper()

	var tarBuffer bytes.Buffer
	writer := tar.NewWriter(&tarBuffer)
	writeOCITestLayerEntries(t, writer, entries)
	if err := writer.Close(); err != nil {
		t.Fatalf("tar writer Close returned error: %v", err)
	}
	if trailingBytes > 0 {
		if _, err := io.Copy(&tarBuffer, io.LimitReader(repeatingByteReader{b: 't'}, trailingBytes)); err != nil {
			t.Fatalf("trailing tar data write returned error: %v", err)
		}
	}
	return gzipBytes(t, tarBuffer.Bytes())
}

func gzipLayerArchiveWithLyingHeader(t *testing.T, declaredSize int64, trailingBytes int64) []byte {
	t.Helper()

	var tarBuffer bytes.Buffer
	writer := tar.NewWriter(&tarBuffer)
	if err := writer.WriteHeader(&tar.Header{
		Name:     "bin/vita-oci-test",
		Mode:     0o755,
		Size:     declaredSize,
		Typeflag: tar.TypeReg,
	}); err != nil {
		t.Fatalf("WriteHeader returned error: %v", err)
	}
	if declaredSize > 0 {
		if _, err := io.Copy(writer, io.LimitReader(repeatingByteReader{b: '#'}, declaredSize)); err != nil {
			t.Fatalf("declared tar body write returned error: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("tar writer Close returned error: %v", err)
	}
	if trailingBytes > 0 {
		if _, err := io.Copy(&tarBuffer, io.LimitReader(repeatingByteReader{b: 'x'}, trailingBytes)); err != nil {
			t.Fatalf("lying tar body write returned error: %v", err)
		}
	}
	return gzipBytes(t, tarBuffer.Bytes())
}

func gzipBytes(t *testing.T, content []byte) []byte {
	t.Helper()

	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	if _, err := gzipWriter.Write(content); err != nil {
		t.Fatalf("gzip Write returned error: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("gzip writer Close returned error: %v", err)
	}
	return buffer.Bytes()
}

func writeOCITestLayerEntries(t *testing.T, writer *tar.Writer, entries []ociLayerEntry) {
	t.Helper()

	for _, entry := range entries {
		typeflag := entry.typeflag
		if typeflag == 0 {
			typeflag = tar.TypeReg
		}
		mode := entry.mode
		if mode == 0 {
			mode = 0o600
		}
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
}

func archiveOCILayout(t *testing.T, files map[string][]byte) []byte {
	t.Helper()

	tarBuffer := plainOCILayoutTar(t, files)
	var compressed bytes.Buffer
	encoder, err := zstd.NewWriter(&compressed, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatalf("zstd NewWriter returned error: %v", err)
	}
	if _, err := encoder.Write(tarBuffer); err != nil {
		t.Fatalf("zstd Write returned error: %v", err)
	}
	if err := encoder.Close(); err != nil {
		t.Fatalf("zstd Close returned error: %v", err)
	}
	return compressed.Bytes()
}

func plainOCILayoutTar(t *testing.T, files map[string][]byte) []byte {
	t.Helper()

	var tarBuffer bytes.Buffer
	writer := tar.NewWriter(&tarBuffer)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		content := files[name]
		header := &tar.Header{
			Name:     name,
			Mode:     0o600,
			Size:     int64(len(content)),
			Typeflag: tar.TypeReg,
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatalf("WriteHeader returned error: %v", err)
		}
		if _, err := writer.Write(content); err != nil {
			t.Fatalf("tar Write returned error: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("tar writer Close returned error: %v", err)
	}
	return tarBuffer.Bytes()
}

func mustJSON(t *testing.T, value interface{}) []byte {
	t.Helper()

	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json Marshal returned error: %v", err)
	}
	return raw
}

func digestBytes(content []byte) string {
	sum := sha256.Sum256(content)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func blobName(digest string) string {
	return filepath.ToSlash(filepath.Join(ociBlobDir, ociSHA256BlobDir, strings.TrimPrefix(digest, "sha256:")))
}

func assertNotExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat %s returned %v, want not exist", path, err)
	}
}
