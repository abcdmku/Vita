package capsules

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/klauspost/compress/zstd"
	"github.com/vita/agent/internal/jsonsafe"
)

const (
	ociRootFSDir       = "rootfs"
	ociFetchMetaName   = "oci-fetch.json"
	ociLayoutFile      = "oci-layout"
	ociIndexFile       = "index.json"
	ociBlobDir         = "blobs"
	ociSHA256BlobDir   = "sha256"
	ociDigestAlgorithm = "sha256"

	ociMediaTypeImageManifest        = "application/vnd.oci.image.manifest.v1+json"
	dockerMediaTypeImageManifest     = "application/vnd.docker.distribution.manifest.v2+json"
	ociMediaTypeImageIndex           = "application/vnd.oci.image.index.v1+json"
	dockerMediaTypeImageManifestList = "application/vnd.docker.distribution.manifest.list.v2+json"
)

var (
	ErrOCIDigestMismatch  = errors.New("capsule oci fetch: digest mismatch")
	ErrOCIWhiteout        = errors.New("capsule oci fetch: whiteout")
	ErrOCIBomb            = errors.New("capsule oci fetch: bomb")
	ErrOCITraversal       = errors.New("capsule oci fetch: traversal")
	ErrOCIArchUnsupported = errors.New("capsule oci fetch: arch unsupported")

	ociDigestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	zstdFrameMagic   = []byte{0x28, 0xb5, 0x2f, 0xfd}
)

type OCIFetchResult struct {
	CapsulePath string
	RootFSPath  string
	ImageDigest string
	Layers      int
	Entrypoint  []string
	Env         []string
}

type ociFetchMetadata struct {
	ID          string   `json:"id"`
	Version     string   `json:"version"`
	ImageDigest string   `json:"imageDigest"`
	Layers      int      `json:"layers"`
	Entrypoint  []string `json:"entrypoint"`
	Env         []string `json:"env"`
}

type ociDescriptor struct {
	MediaType    string            `json:"mediaType,omitempty"`
	Digest       string            `json:"digest"`
	Size         int64             `json:"size,omitempty"`
	URLs         []string          `json:"urls,omitempty"`
	Annotations  map[string]string `json:"annotations,omitempty"`
	Platform     *ociPlatform      `json:"platform,omitempty"`
	ArtifactType string            `json:"artifactType,omitempty"`
}

type ociPlatform struct {
	Architecture string   `json:"architecture,omitempty"`
	OS           string   `json:"os,omitempty"`
	OSVersion    string   `json:"os.version,omitempty"`
	OSFeatures   []string `json:"os.features,omitempty"`
	Variant      string   `json:"variant,omitempty"`
	Features     []string `json:"features,omitempty"`
}

type ociIndex struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType,omitempty"`
	Manifests     []ociDescriptor   `json:"manifests"`
	Annotations   map[string]string `json:"annotations,omitempty"`
}

type ociImageManifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType,omitempty"`
	Config        ociDescriptor     `json:"config"`
	Layers        []ociDescriptor   `json:"layers"`
	Annotations   map[string]string `json:"annotations,omitempty"`
	Subject       *ociDescriptor    `json:"subject,omitempty"`
	ArtifactType  string            `json:"artifactType,omitempty"`
}

type ociImageConfig struct {
	Architecture string           `json:"architecture,omitempty"`
	OS           string           `json:"os,omitempty"`
	Config       ociRuntimeConfig `json:"config"`
}

type ociRuntimeConfig struct {
	Env        []string `json:"Env,omitempty"`
	Entrypoint []string `json:"Entrypoint,omitempty"`
	Cmd        []string `json:"Cmd,omitempty"`
	WorkingDir string   `json:"WorkingDir,omitempty"`
}

type ociLayerCaps struct {
	entries                  int
	payloadBytes             int64
	decodedTarBytesRemaining int64
}

type nodePlatform struct {
	OS           string
	Architecture string
	Variant      string
}

func FetchOCIImageFor(ctx context.Context, ref string, integrity string, id string, version string, imageDigest string) (OCIFetchResult, error) {
	return fetchOCIImage(ctx, ref, integrity, Manifest{ID: id, Version: version}, imageDigest)
}

func IsValidOCIDigest(value string) bool {
	return ociDigestPattern.MatchString(value)
}

func ShortOCIDigest(value string) string {
	algorithm, hexDigest, ok := splitOCIDigest(value)
	if !ok {
		return value
	}
	if len(hexDigest) > 12 {
		hexDigest = hexDigest[:12]
	}
	return algorithm + "-" + hexDigest
}

func fetchOCIImage(ctx context.Context, ref string, integrity string, expected Manifest, imageDigest string) (OCIFetchResult, error) {
	if err := ctx.Err(); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}
	if !validCapsuleID(expected.ID) || !validVersion(expected.Version) {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("expected capsule id/version is unsafe")
	}
	if !IsValidOCIDigest(imageDigest) {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("OCI image digest must be sha256:<64 lowercase hex>")
	}

	parsedIntegrity, err := ParseIntegrity(integrity)
	if err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}
	sourcePath, err := ResolveLocalRef(ref)
	if err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}

	artifact, cleanupArtifact, err := verifiedArtifact(ctx, sourcePath, parsedIntegrity)
	if err != nil {
		if errors.Is(err, ErrSRIMismatch) {
			log.Printf("VITA-CAPSULE-OCI-FETCH-REJECT: reason=sri_mismatch status=OK")
			return OCIFetchResult{}, err
		}
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}
	defer cleanupArtifact()

	root := CacheRoot()
	if err := os.MkdirAll(root, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("create capsule cache root: %w", err)
	}
	if err := os.Chmod(root, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("secure capsule cache root: %w", err)
	}

	layoutDir, err := os.MkdirTemp(root, ".oci-layout-*.tmp")
	if err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("create OCI layout temp dir: %w", err)
	}
	defer os.RemoveAll(layoutDir)
	if err := os.Chmod(layoutDir, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("secure OCI layout temp dir: %w", err)
	}

	if err := extractOCIArtifact(ctx, artifact, layoutDir); err != nil {
		logOCIReject(err)
		return OCIFetchResult{}, err
	}

	verified, err := verifyOCILayout(ctx, layoutDir, imageDigest)
	if err != nil {
		logOCIReject(err)
		return OCIFetchResult{}, err
	}

	target, err := CachePath(expected.ID, expected.Version)
	if err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}
	targetParent := filepath.Dir(target)
	targetParentPreexisting := pathExists(targetParent)
	if err := os.MkdirAll(targetParent, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("create OCI capsule cache parent: %w", err)
	}
	if err := os.Chmod(targetParent, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("secure OCI capsule cache parent: %w", err)
	}

	metadata := ociFetchMetadata{
		ID:          expected.ID,
		Version:     expected.Version,
		ImageDigest: verified.ImageDigest,
		Layers:      len(verified.Manifest.Layers),
		Entrypoint:  cloneStrings(verified.Entrypoint),
		Env:         cloneStrings(verified.Env),
	}
	if complete, err := existingOCIComplete(target, metadata); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	} else if complete {
		result := ociResultFromMetadata(target, metadata)
		log.Printf("VITA-CAPSULE-OCI-FETCH: id=%s image-digest=%s arch=%s/%s layers=%d verified=OK status=OK", expected.ID, ShortOCIDigest(verified.ImageDigest), verified.Platform.OS, verified.Platform.Architecture, len(verified.Manifest.Layers))
		return result, nil
	}

	tmpDir, err := os.MkdirTemp(targetParent, ".oci-fetch-*.tmp")
	if err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("create OCI rootfs temp dir: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(tmpDir)
			if !targetParentPreexisting {
				_ = os.Remove(targetParent)
			}
		}
	}()
	if err := os.Chmod(tmpDir, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("secure OCI rootfs temp dir: %w", err)
	}

	rootfs := filepath.Join(tmpDir, ociRootFSDir)
	if err := os.MkdirAll(rootfs, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("create OCI rootfs: %w", err)
	}
	caps := newOCILayerCaps()
	for _, layer := range verified.Manifest.Layers {
		if err := applyOCILayer(ctx, layoutDir, rootfs, layer, caps); err != nil {
			logOCIReject(err)
			return OCIFetchResult{}, err
		}
	}
	if err := ensureEntrypointExists(rootfs, verified.Entrypoint); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}
	if err := makeTreeReadOnly(rootfs); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}
	if err := writeOCIMetadata(tmpDir, metadata); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}

	if err := ctx.Err(); err != nil {
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, err
	}
	if err := os.Rename(tmpDir, target); err != nil {
		if complete, completeErr := existingOCIComplete(target, metadata); completeErr == nil && complete {
			result := ociResultFromMetadata(target, metadata)
			log.Printf("VITA-CAPSULE-OCI-FETCH: id=%s image-digest=%s arch=%s/%s layers=%d verified=OK status=OK", expected.ID, ShortOCIDigest(verified.ImageDigest), verified.Platform.OS, verified.Platform.Architecture, len(verified.Manifest.Layers))
			return result, nil
		}
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
		return OCIFetchResult{}, fmt.Errorf("commit OCI capsule rootfs: %w", err)
	}
	committed = true

	result := ociResultFromMetadata(target, metadata)
	log.Printf("VITA-CAPSULE-OCI-FETCH: id=%s image-digest=%s arch=%s/%s layers=%d verified=OK status=OK", expected.ID, ShortOCIDigest(verified.ImageDigest), verified.Platform.OS, verified.Platform.Architecture, len(verified.Manifest.Layers))
	return result, nil
}

type verifiedOCIImage struct {
	ImageDigest string
	Platform    nodePlatform
	Manifest    ociImageManifest
	Entrypoint  []string
	Env         []string
}

func verifyOCILayout(ctx context.Context, layoutDir string, expectedImageDigest string) (verifiedOCIImage, error) {
	if err := verifyOCILayoutMarker(layoutDir); err != nil {
		return verifiedOCIImage{}, err
	}

	indexRaw, err := readOCIFile(layoutDir, ociIndexFile)
	if err != nil {
		return verifiedOCIImage{}, err
	}
	var index ociIndex
	if err := decodeOCIJSON(indexRaw, &index); err != nil {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "parse OCI index: %v", err)
	}
	if index.SchemaVersion != 2 || len(index.Manifests) == 0 {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI index has no image manifests")
	}

	pinnedDescriptor, ok := findDescriptor(index.Manifests, expectedImageDigest)
	if !ok {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI index does not contain pinned descriptor %s", expectedImageDigest)
	}
	if !isRunnableDescriptor(pinnedDescriptor) {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI pinned descriptor %s is incomplete", expectedImageDigest)
	}

	switch {
	case isImageManifestMediaType(pinnedDescriptor.MediaType):
		return verifyOCIImageManifest(ctx, layoutDir, pinnedDescriptor, expectedImageDigest)
	case isImageIndexMediaType(pinnedDescriptor.MediaType):
		node, err := nodeOCIPlatform()
		if err != nil {
			return verifiedOCIImage{}, err
		}
		indexRaw, err := readVerifiedBlob(ctx, layoutDir, pinnedDescriptor)
		if err != nil {
			return verifiedOCIImage{}, err
		}
		var imageIndex ociIndex
		if err := decodeOCIJSON(indexRaw, &imageIndex); err != nil {
			return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "parse OCI image index: %v", err)
		}
		if imageIndex.SchemaVersion != 2 || !isImageIndexMediaType(imageIndex.MediaType) || len(imageIndex.Manifests) == 0 {
			return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI image index is malformed")
		}
		manifestDescriptor, err := selectOCIPlatformManifest(imageIndex, node)
		if err != nil {
			return verifiedOCIImage{}, err
		}
		return verifyOCIImageManifest(ctx, layoutDir, manifestDescriptor, manifestDescriptor.Digest)
	default:
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI pinned descriptor media type %q is unsupported", pinnedDescriptor.MediaType)
	}
}

func verifyOCIImageManifest(ctx context.Context, layoutDir string, manifestDescriptor ociDescriptor, imageDigest string) (verifiedOCIImage, error) {
	if !isRunnableDescriptor(manifestDescriptor) || !isImageManifestMediaType(manifestDescriptor.MediaType) {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI image manifest descriptor is incomplete")
	}
	manifestRaw, err := readVerifiedBlob(ctx, layoutDir, manifestDescriptor)
	if err != nil {
		return verifiedOCIImage{}, err
	}
	var manifest ociImageManifest
	if err := decodeOCIJSON(manifestRaw, &manifest); err != nil {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "parse OCI image manifest: %v", err)
	}
	if manifest.SchemaVersion != 2 || len(manifest.Layers) == 0 {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI image manifest has no layers")
	}
	if !isLayerConfigDescriptor(manifest.Config) {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI image config descriptor is incomplete")
	}

	configRaw, err := readVerifiedBlob(ctx, layoutDir, manifest.Config)
	if err != nil {
		return verifiedOCIImage{}, err
	}
	var config ociImageConfig
	if err := decodeOCIConfig(configRaw, &config); err != nil {
		return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "parse OCI image config: %v", err)
	}
	platform, err := resolvedOCIPlatform(manifestDescriptor, config)
	if err != nil {
		return verifiedOCIImage{}, err
	}
	entrypoint, err := resolveOCIEntrypoint(config.Config.Entrypoint, config.Config.Cmd)
	if err != nil {
		return verifiedOCIImage{}, err
	}
	env, err := validateOCIEnv(config.Config.Env)
	if err != nil {
		return verifiedOCIImage{}, err
	}

	for _, layer := range manifest.Layers {
		if !isLayerDescriptor(layer) {
			return verifiedOCIImage{}, rejectOCI(ErrOCIDigestMismatch, "OCI layer descriptor is incomplete")
		}
		if _, err := readVerifiedBlob(ctx, layoutDir, layer); err != nil {
			return verifiedOCIImage{}, err
		}
	}

	return verifiedOCIImage{
		ImageDigest: imageDigest,
		Platform:    platform,
		Manifest:    manifest,
		Entrypoint:  entrypoint,
		Env:         env,
	}, nil
}

func verifyOCILayoutMarker(layoutDir string) error {
	raw, err := readOCIFile(layoutDir, ociLayoutFile)
	if err != nil {
		return err
	}
	var layout struct {
		ImageLayoutVersion string `json:"imageLayoutVersion"`
	}
	if err := decodeOCIJSON(raw, &layout); err != nil {
		return rejectOCI(ErrOCIDigestMismatch, "parse OCI layout marker: %v", err)
	}
	if layout.ImageLayoutVersion != "1.0.0" {
		return rejectOCI(ErrOCIDigestMismatch, "OCI layout marker version is unsupported")
	}
	return nil
}

func readOCIFile(layoutDir string, name string) ([]byte, error) {
	entryName, err := safeArchiveName(name)
	if err != nil {
		return nil, rejectOCI(ErrOCITraversal, "%v", err)
	}
	target, err := safeExtractPath(layoutDir, entryName)
	if err != nil {
		return nil, rejectOCI(ErrOCITraversal, "%v", err)
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return nil, rejectOCI(ErrOCIDigestMismatch, "read OCI layout file %s: %v", name, err)
	}
	return raw, nil
}

func readVerifiedBlob(ctx context.Context, layoutDir string, descriptor ociDescriptor) ([]byte, error) {
	_, hexDigest, ok := splitOCIDigest(descriptor.Digest)
	if !ok {
		return nil, rejectOCI(ErrOCIDigestMismatch, "OCI descriptor digest %q is not a sha256 digest", descriptor.Digest)
	}
	blobPath := filepath.Join(layoutDir, ociBlobDir, ociSHA256BlobDir, hexDigest)
	file, err := os.Open(blobPath)
	if err != nil {
		return nil, rejectOCI(ErrOCIDigestMismatch, "open OCI blob %s: %v", descriptor.Digest, err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, rejectOCI(ErrOCIDigestMismatch, "stat OCI blob %s: %v", descriptor.Digest, err)
	}
	if !info.Mode().IsRegular() {
		return nil, rejectOCI(ErrOCIDigestMismatch, "OCI blob %s is not a regular file", descriptor.Digest)
	}
	if descriptor.Size < 0 {
		return nil, rejectOCI(ErrOCIDigestMismatch, "OCI blob %s has negative descriptor size", descriptor.Digest)
	}
	if descriptor.Size > 0 && info.Size() != descriptor.Size {
		return nil, rejectOCI(ErrOCIDigestMismatch, "OCI blob %s size mismatch", descriptor.Digest)
	}

	hasher := sha256.New()
	var buffer bytes.Buffer
	if err := copyWithContext(ctx, io.MultiWriter(&buffer, hasher), file); err != nil {
		return nil, rejectOCI(ErrOCIDigestMismatch, "read OCI blob %s: %v", descriptor.Digest, err)
	}
	expected, err := hex.DecodeString(hexDigest)
	if err != nil {
		return nil, rejectOCI(ErrOCIDigestMismatch, "decode OCI blob digest %s: %v", descriptor.Digest, err)
	}
	if subtle.ConstantTimeCompare(hasher.Sum(nil), expected) != 1 {
		return nil, rejectOCI(ErrOCIDigestMismatch, "OCI blob %s content digest mismatch", descriptor.Digest)
	}
	return buffer.Bytes(), nil
}

func extractOCIArtifact(ctx context.Context, artifact *os.File, dest string) error {
	if _, err := artifact.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind OCI artifact: %w", err)
	}
	reader, closeReader, err := ociArtifactTarReader(artifact)
	if err != nil {
		return err
	}
	defer closeReader()

	limitedArchive := &maxBytesReader{
		reader:    reader,
		remaining: maxCapsuleDecodedTarBytes,
		limit:     maxCapsuleDecodedTarBytes,
	}
	tarReader := tar.NewReader(limitedArchive)
	entries := 0
	var totalPayloadBytes int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return rejectOCI(ErrOCIBomb, "read OCI artifact tar entry: %v", err)
		}
		entries++
		if entries > maxCapsuleTarEntries {
			return rejectOCI(ErrOCIBomb, "OCI artifact tar archive exceeds entry limit (%d)", maxCapsuleTarEntries)
		}
		if header.Size < 0 {
			return rejectOCI(ErrOCIBomb, "OCI artifact tar entry %q has negative size", header.Name)
		}

		entryName, err := safeArchiveName(header.Name)
		if err != nil {
			return rejectOCI(ErrOCITraversal, "%v", err)
		}
		target, err := safeExtractPath(dest, entryName)
		if err != nil {
			return rejectOCI(ErrOCITraversal, "%v", err)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := ensureLayerDirectory(target); err != nil {
				return err
			}
		case tar.TypeReg:
			if header.Size > maxCapsuleTarEntryBytes {
				return rejectOCI(ErrOCIBomb, "OCI artifact tar entry %q exceeds per-entry size limit (%d bytes)", header.Name, maxCapsuleTarEntryBytes)
			}
			if totalPayloadBytes > maxCapsuleTarPayloadBytes-header.Size {
				return rejectOCI(ErrOCIBomb, "OCI artifact tar archive exceeds total payload size limit (%d bytes)", maxCapsuleTarPayloadBytes)
			}
			totalPayloadBytes += header.Size
			if err := writeLayerFile(ctx, target, tarReader, header.Size, 0o600); err != nil {
				return err
			}
		default:
			return rejectOCI(ErrOCITraversal, "OCI artifact tar entry %q has unsupported type %d", header.Name, header.Typeflag)
		}
	}
	if entries == 0 {
		return rejectOCI(ErrOCIDigestMismatch, "OCI artifact tar archive is empty")
	}
	return nil
}

func ociArtifactTarReader(artifact *os.File) (io.Reader, func(), error) {
	var prefix [4]byte
	n, err := io.ReadFull(artifact, prefix[:])
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, func() {}, fmt.Errorf("read OCI artifact header: %w", err)
	}
	if _, err := artifact.Seek(0, io.SeekStart); err != nil {
		return nil, func() {}, fmt.Errorf("rewind OCI artifact: %w", err)
	}
	if n != len(prefix) || !bytes.Equal(prefix[:], zstdFrameMagic) {
		return artifact, func() {}, nil
	}

	decoder, err := zstd.NewReader(
		artifact,
		zstd.WithDecoderConcurrency(1),
		zstd.WithDecoderMaxMemory(uint64(maxCapsuleDecodedTarBytes)),
		zstd.WithDecoderMaxWindow(uint64(maxCapsuleTarEntryBytes)),
	)
	if err == nil {
		return decoder, decoder.Close, nil
	}
	return nil, func() {}, fmt.Errorf("create OCI zstd artifact decoder: %w", err)
}

func newOCILayerCaps() *ociLayerCaps {
	return &ociLayerCaps{
		decodedTarBytesRemaining: maxCapsuleDecodedTarBytes,
	}
}

func applyOCILayer(ctx context.Context, layoutDir string, rootfs string, descriptor ociDescriptor, caps *ociLayerCaps) error {
	reader, closeReader, err := ociLayerTarReader(layoutDir, descriptor)
	if err != nil {
		return err
	}
	defer closeReader()

	limitedReader := &maxBytesReader{
		reader:       reader,
		remainingRef: &caps.decodedTarBytesRemaining,
		limit:        maxCapsuleDecodedTarBytes,
		limitErr:     rejectOCI(ErrOCIBomb, "OCI layer stack exceeds decompressed size limit (%d bytes)", maxCapsuleDecodedTarBytes),
	}
	tarReader := tar.NewReader(limitedReader)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			if err := drainOCILayerRemainder(ctx, limitedReader); err != nil {
				return err
			}
			return nil
		}
		if err != nil {
			return rejectOCI(ErrOCIBomb, "read OCI layer tar entry: %v", err)
		}
		caps.entries++
		if caps.entries > maxCapsuleTarEntries {
			return rejectOCI(ErrOCIBomb, "OCI layer stack exceeds entry limit (%d)", maxCapsuleTarEntries)
		}
		if header.Size < 0 {
			return rejectOCI(ErrOCIBomb, "OCI layer tar entry %q has negative size", header.Name)
		}
		if err := reserveOCILayerEntryPayload(caps, header); err != nil {
			return err
		}

		entryName, err := safeArchiveName(header.Name)
		if err != nil {
			return rejectOCI(ErrOCITraversal, "%v", err)
		}
		if isWhiteoutEntry(entryName) {
			if err := applyOCIWhiteout(rootfs, entryName, header); err != nil {
				return err
			}
			if header.Size > 0 {
				if _, err := io.Copy(io.Discard, io.LimitReader(tarReader, header.Size)); err != nil {
					if errors.Is(err, ErrOCIBomb) {
						return err
					}
					return rejectOCI(ErrOCIWhiteout, "discard OCI whiteout payload: %v", err)
				}
			}
			continue
		}

		target, err := safeExtractPath(rootfs, entryName)
		if err != nil {
			return rejectOCI(ErrOCITraversal, "%v", err)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := ensureLayerDirectory(target); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := writeLayerFile(ctx, target, tarReader, header.Size, executableFileMode(header.Mode)); err != nil {
				return err
			}
		default:
			return rejectOCI(ErrOCITraversal, "OCI layer tar entry %q has unsupported type %d", header.Name, header.Typeflag)
		}
	}
}

func drainOCILayerRemainder(ctx context.Context, reader io.Reader) error {
	if _, err := copyWithContextCount(ctx, io.Discard, reader); err != nil {
		if errors.Is(err, ErrOCIBomb) {
			return err
		}
		return rejectOCI(ErrOCIBomb, "read OCI layer trailing data: %v", err)
	}
	return nil
}

func reserveOCILayerEntryPayload(caps *ociLayerCaps, header *tar.Header) error {
	if header.Size > maxCapsuleTarEntryBytes {
		return rejectOCI(ErrOCIBomb, "OCI layer tar entry %q exceeds per-entry size limit (%d bytes)", header.Name, maxCapsuleTarEntryBytes)
	}
	if caps.payloadBytes > maxCapsuleTarPayloadBytes-header.Size {
		return rejectOCI(ErrOCIBomb, "OCI layer stack exceeds total payload size limit (%d bytes)", maxCapsuleTarPayloadBytes)
	}
	caps.payloadBytes += header.Size
	return nil
}

func ociLayerTarReader(layoutDir string, descriptor ociDescriptor) (io.Reader, func(), error) {
	_, hexDigest, ok := splitOCIDigest(descriptor.Digest)
	if !ok {
		return nil, func() {}, rejectOCI(ErrOCIDigestMismatch, "OCI layer descriptor digest %q is not a sha256 digest", descriptor.Digest)
	}
	blobPath := filepath.Join(layoutDir, ociBlobDir, ociSHA256BlobDir, hexDigest)
	file, err := os.Open(blobPath)
	if err != nil {
		return nil, func() {}, rejectOCI(ErrOCIDigestMismatch, "open OCI layer blob %s: %v", descriptor.Digest, err)
	}

	closeFile := func() {
		_ = file.Close()
	}
	if strings.Contains(descriptor.MediaType, "+gzip") || strings.HasSuffix(descriptor.MediaType, ".gzip") {
		gzipReader, err := gzip.NewReader(file)
		if err != nil {
			closeFile()
			return nil, func() {}, rejectOCI(ErrOCIDigestMismatch, "create OCI gzip layer reader: %v", err)
		}
		return gzipReader, func() {
			_ = gzipReader.Close()
			closeFile()
		}, nil
	}
	if strings.Contains(descriptor.MediaType, "+zstd") {
		decoder, err := zstd.NewReader(
			file,
			zstd.WithDecoderConcurrency(1),
			zstd.WithDecoderMaxMemory(uint64(maxCapsuleDecodedTarBytes)),
			zstd.WithDecoderMaxWindow(uint64(maxCapsuleTarEntryBytes)),
		)
		if err != nil {
			closeFile()
			return nil, func() {}, rejectOCI(ErrOCIDigestMismatch, "create OCI zstd layer reader: %v", err)
		}
		return decoder, func() {
			decoder.Close()
			closeFile()
		}, nil
	}
	closeFile()
	return nil, func() {}, rejectOCI(ErrOCIDigestMismatch, "OCI layer media type %q is unsupported", descriptor.MediaType)
}

func applyOCIWhiteout(rootfs string, entryName string, header *tar.Header) error {
	if header.Typeflag != tar.TypeReg {
		return rejectOCI(ErrOCIWhiteout, "OCI whiteout entry %q has unsupported type %d", header.Name, header.Typeflag)
	}
	dirName, base := filepath.Split(pathToNative(entryName))
	if base == ".wh..wh..opq" {
		targetDir := filepath.Join(rootfs, dirName)
		rel, err := filepath.Rel(rootfs, targetDir)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return rejectOCI(ErrOCITraversal, "OCI opaque whiteout %q escapes capsule root", header.Name)
		}
		if err := removeDirectoryContents(targetDir); err != nil {
			return rejectOCI(ErrOCIWhiteout, "apply OCI opaque whiteout %q: %v", header.Name, err)
		}
		return nil
	}
	victimBase := strings.TrimPrefix(base, ".wh.")
	if victimBase == "" || victimBase == "." || victimBase == ".." || strings.ContainsAny(victimBase, `/\`) {
		return rejectOCI(ErrOCIWhiteout, "OCI whiteout entry %q has unsafe victim", header.Name)
	}
	victimName := filepath.ToSlash(filepath.Join(dirName, victimBase))
	victimName, err := safeArchiveName(victimName)
	if err != nil {
		return rejectOCI(ErrOCITraversal, "%v", err)
	}
	target, err := safeExtractPath(rootfs, victimName)
	if err != nil {
		return rejectOCI(ErrOCITraversal, "%v", err)
	}
	if err := os.RemoveAll(target); err != nil {
		return rejectOCI(ErrOCIWhiteout, "apply OCI whiteout %q: %v", header.Name, err)
	}
	return nil
}

func removeDirectoryContents(dir string) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func ensureLayerDirectory(target string) error {
	if info, err := os.Lstat(target); err == nil && !info.IsDir() {
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("replace OCI layer file with directory: %w", err)
		}
	}
	if err := os.MkdirAll(target, cacheDirMode); err != nil {
		return fmt.Errorf("create OCI layer directory: %w", err)
	}
	if err := os.Chmod(target, cacheDirMode); err != nil {
		return fmt.Errorf("secure OCI layer directory: %w", err)
	}
	return nil
}

func writeLayerFile(ctx context.Context, target string, reader io.Reader, expectedSize int64, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), cacheDirMode); err != nil {
		return fmt.Errorf("create OCI layer file parent: %w", err)
	}
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return rejectOCI(ErrOCITraversal, "OCI layer target %q is a symlink", target)
		}
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("replace OCI layer file: %w", err)
		}
	}

	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return fmt.Errorf("create OCI layer file: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
	}()
	if err := file.Chmod(mode); err != nil {
		return fmt.Errorf("secure OCI layer file: %w", err)
	}
	limitedReader := &io.LimitedReader{R: reader, N: expectedSize + 1}
	written, err := copyWithContextCount(ctx, file, limitedReader)
	if err != nil {
		return fmt.Errorf("write OCI layer file: %w", err)
	}
	if written > expectedSize || limitedReader.N == 0 {
		return rejectOCI(ErrOCIBomb, "OCI layer file exceeds declared size")
	}
	if written != expectedSize {
		return rejectOCI(ErrOCIBomb, "OCI layer file is truncated")
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync OCI layer file: %w", err)
	}
	if err := file.Close(); err != nil {
		closed = true
		return fmt.Errorf("close OCI layer file: %w", err)
	}
	closed = true
	return nil
}

func makeTreeReadOnly(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return rejectOCI(ErrOCITraversal, "OCI rootfs contains symlink %q", path)
		}
		if entry.IsDir() {
			return os.Chmod(path, cacheDirMode)
		}
		mode := os.FileMode(0o400)
		if info.Mode()&0o111 != 0 {
			mode = 0o500
		}
		return os.Chmod(path, mode)
	})
}

func writeOCIMetadata(target string, metadata ociFetchMetadata) error {
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("render OCI fetch metadata: %w", err)
	}
	encoded = append(encoded, '\n')
	return writeTarFile(context.Background(), filepath.Join(target, ociFetchMetaName), bytes.NewReader(encoded), int64(len(encoded)))
}

func existingOCIComplete(target string, expected ociFetchMetadata) (bool, error) {
	info, err := os.Stat(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("stat existing OCI capsule cache entry: %w", err)
	}
	if !info.IsDir() {
		return false, fmt.Errorf("existing OCI capsule cache entry is not a directory")
	}
	raw, err := os.ReadFile(filepath.Join(target, ociFetchMetaName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("read existing OCI fetch metadata: %w", err)
	}
	var metadata ociFetchMetadata
	if err := decodeOCIJSON(raw, &metadata); err != nil {
		return false, fmt.Errorf("parse existing OCI fetch metadata: %w", err)
	}
	if !sameOCIMetadata(metadata, expected) {
		return false, nil
	}
	rootfs := filepath.Join(target, ociRootFSDir)
	rootInfo, err := os.Stat(rootfs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("stat existing OCI rootfs: %w", err)
	}
	if !rootInfo.IsDir() {
		return false, fmt.Errorf("existing OCI rootfs is not a directory")
	}
	if err := ensureEntrypointExists(rootfs, metadata.Entrypoint); err != nil {
		return false, nil
	}
	return true, nil
}

func sameOCIMetadata(left ociFetchMetadata, right ociFetchMetadata) bool {
	if left.ID != right.ID || left.Version != right.Version || left.ImageDigest != right.ImageDigest || left.Layers != right.Layers {
		return false
	}
	return sameStrings(left.Entrypoint, right.Entrypoint) && sameStrings(left.Env, right.Env)
}

func ociResultFromMetadata(target string, metadata ociFetchMetadata) OCIFetchResult {
	return OCIFetchResult{
		CapsulePath: target,
		RootFSPath:  filepath.Join(target, ociRootFSDir),
		ImageDigest: metadata.ImageDigest,
		Layers:      metadata.Layers,
		Entrypoint:  cloneStrings(metadata.Entrypoint),
		Env:         cloneStrings(metadata.Env),
	}
}

func ensureEntrypointExists(rootfs string, entrypoint []string) error {
	if len(entrypoint) == 0 {
		return rejectOCI(ErrOCIDigestMismatch, "OCI image config entrypoint is required")
	}
	first := entrypoint[0]
	if first == "" || !strings.HasPrefix(first, "/") || strings.Contains(first, "\x00") {
		return rejectOCI(ErrOCIDigestMismatch, "OCI image config entrypoint must be an absolute path")
	}
	entryName, err := safeArchiveName(strings.TrimPrefix(first, "/"))
	if err != nil {
		return rejectOCI(ErrOCITraversal, "%v", err)
	}
	target, err := safeExtractPath(rootfs, entryName)
	if err != nil {
		return rejectOCI(ErrOCITraversal, "%v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		return rejectOCI(ErrOCIDigestMismatch, "OCI image entrypoint %s is absent: %v", first, err)
	}
	if !info.Mode().IsRegular() {
		return rejectOCI(ErrOCIDigestMismatch, "OCI image entrypoint %s is not a regular file", first)
	}
	return nil
}

func resolveOCIEntrypoint(entrypoint []string, cmd []string) ([]string, error) {
	resolved := make([]string, 0, len(entrypoint)+len(cmd))
	resolved = append(resolved, entrypoint...)
	if len(resolved) == 0 {
		resolved = append(resolved, cmd...)
	} else {
		resolved = append(resolved, cmd...)
	}
	if len(resolved) == 0 {
		return nil, rejectOCI(ErrOCIDigestMismatch, "OCI image config entrypoint is required")
	}
	for i, arg := range resolved {
		if arg == "" || controlCharacter.MatchString(arg) {
			return nil, rejectOCI(ErrOCIDigestMismatch, "OCI image config entrypoint arg %d is unsafe", i)
		}
	}
	if !strings.HasPrefix(resolved[0], "/") {
		return nil, rejectOCI(ErrOCIDigestMismatch, "OCI image config entrypoint must be absolute")
	}
	return resolved, nil
}

func validateOCIEnv(env []string) ([]string, error) {
	out := make([]string, 0, len(env))
	for i, value := range env {
		if value == "" || controlCharacter.MatchString(value) || !strings.Contains(value, "=") {
			return nil, rejectOCI(ErrOCIDigestMismatch, "OCI image config env %d is unsafe", i)
		}
		out = append(out, value)
	}
	return out, nil
}

func decodeOCIJSON(raw []byte, target interface{}) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("body must contain exactly one JSON value")
		}
		return err
	}
	return nil
}

func decodeOCIConfig(raw []byte, target *ociImageConfig) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("body must contain exactly one JSON value")
		}
		return err
	}
	return nil
}

func findDescriptor(manifests []ociDescriptor, expectedDigest string) (ociDescriptor, bool) {
	for _, descriptor := range manifests {
		if descriptor.Digest == expectedDigest {
			return descriptor, true
		}
	}
	return ociDescriptor{}, false
}

func nodeOCIPlatform() (nodePlatform, error) {
	switch runtime.GOARCH {
	case "amd64", "arm64":
		return nodePlatform{OS: "linux", Architecture: runtime.GOARCH}, nil
	default:
		return nodePlatform{}, rejectOCI(ErrOCIArchUnsupported, "node GOARCH %q has no compatible OCI platform", runtime.GOARCH)
	}
}

func selectOCIPlatformManifest(index ociIndex, node nodePlatform) (ociDescriptor, error) {
	if node.OS == "" || node.Architecture == "" {
		return ociDescriptor{}, rejectOCI(ErrOCIArchUnsupported, "node OCI platform is incomplete")
	}
	for _, descriptor := range index.Manifests {
		if !isImageManifestMediaType(descriptor.MediaType) {
			continue
		}
		if err := validateOCIPlatformManifestDescriptor(descriptor); err != nil {
			return ociDescriptor{}, err
		}
		platform := descriptor.Platform
		if platform.OS != node.OS || platform.Architecture != node.Architecture {
			continue
		}
		if platform.Variant != "" && node.Variant != "" && platform.Variant != node.Variant {
			continue
		}
		return descriptor, nil
	}
	return ociDescriptor{}, rejectOCI(ErrOCIArchUnsupported, "OCI image index has no compatible %s/%s manifest", node.OS, node.Architecture)
}

func validateOCIPlatformManifestDescriptor(descriptor ociDescriptor) error {
	if !isRunnableDescriptor(descriptor) {
		return rejectOCI(ErrOCIDigestMismatch, "OCI platform image manifest descriptor is incomplete")
	}
	if descriptor.Platform == nil || descriptor.Platform.OS == "" || descriptor.Platform.Architecture == "" {
		return rejectOCI(ErrOCIDigestMismatch, "OCI platform image manifest descriptor is missing platform")
	}
	return nil
}

func resolvedOCIPlatform(descriptor ociDescriptor, config ociImageConfig) (nodePlatform, error) {
	if descriptor.Platform != nil && descriptor.Platform.OS != "" && descriptor.Platform.Architecture != "" {
		return nodePlatform{
			OS:           descriptor.Platform.OS,
			Architecture: descriptor.Platform.Architecture,
			Variant:      descriptor.Platform.Variant,
		}, nil
	}
	if config.OS != "" && config.Architecture != "" {
		return nodePlatform{OS: config.OS, Architecture: config.Architecture}, nil
	}
	return nodePlatform{}, rejectOCI(ErrOCIDigestMismatch, "OCI image platform is incomplete")
}

func isImageManifestMediaType(mediaType string) bool {
	return mediaType == ociMediaTypeImageManifest || mediaType == dockerMediaTypeImageManifest
}

func isImageIndexMediaType(mediaType string) bool {
	return mediaType == ociMediaTypeImageIndex || mediaType == dockerMediaTypeImageManifestList
}

func isRunnableDescriptor(descriptor ociDescriptor) bool {
	return IsValidOCIDigest(descriptor.Digest) && descriptor.Size >= 0
}

func isLayerConfigDescriptor(descriptor ociDescriptor) bool {
	return IsValidOCIDigest(descriptor.Digest) && descriptor.Size >= 0
}

func isLayerDescriptor(descriptor ociDescriptor) bool {
	return IsValidOCIDigest(descriptor.Digest) && descriptor.Size >= 0 && descriptor.MediaType != ""
}

func splitOCIDigest(value string) (string, string, bool) {
	if !IsValidOCIDigest(value) {
		return "", "", false
	}
	return ociDigestAlgorithm, strings.TrimPrefix(value, ociDigestAlgorithm+":"), true
}

func rejectOCI(sentinel error, format string, args ...interface{}) error {
	return fmt.Errorf("%w: %s", sentinel, fmt.Sprintf(format, args...))
}

func logOCIReject(err error) {
	switch {
	case errors.Is(err, ErrSRIMismatch):
		log.Printf("VITA-CAPSULE-OCI-FETCH-REJECT: reason=sri_mismatch status=OK")
	case errors.Is(err, ErrOCIDigestMismatch):
		log.Printf("VITA-CAPSULE-OCI-FETCH-REJECT: reason=digest_mismatch status=OK")
	case errors.Is(err, ErrOCIWhiteout):
		log.Printf("VITA-CAPSULE-OCI-FETCH-REJECT: reason=whiteout status=OK")
	case errors.Is(err, ErrOCIBomb):
		log.Printf("VITA-CAPSULE-OCI-FETCH-REJECT: reason=bomb status=OK")
	case errors.Is(err, ErrOCITraversal):
		log.Printf("VITA-CAPSULE-OCI-FETCH-REJECT: reason=traversal status=OK")
	case errors.Is(err, ErrOCIArchUnsupported):
		log.Printf("VITA-CAPSULE-OCI-FETCH-REJECT: reason=arch_unsupported status=OK")
	default:
		log.Printf("VITA-CAPSULE-OCI-FETCH-ERROR: status=FAILSAFE")
	}
}

func isWhiteoutEntry(entryName string) bool {
	base := filepath.Base(pathToNative(entryName))
	return base == ".wh..wh..opq" || strings.HasPrefix(base, ".wh.")
}

func pathToNative(value string) string {
	return filepath.FromSlash(value)
}

func executableFileMode(mode int64) os.FileMode {
	if mode&0o111 != 0 {
		return 0o700
	}
	return cacheFileMode
}

func cloneStrings(in []string) []string {
	if in == nil {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func sameStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil || !errors.Is(err, os.ErrNotExist)
}
