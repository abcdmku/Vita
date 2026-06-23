package capsules

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"log"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/klauspost/compress/zstd"
	"github.com/vita/agent/internal/jsonsafe"
)

const (
	defaultCacheRoot = "/var/lib/vita-agent/capsule-storage"
	cacheRootEnv     = "VITA_CAPSULE_STORAGE_ROOT"

	cacheDirMode  = 0o700
	cacheFileMode = 0o600

	// Bundle manifests are inside the untrusted archive, so extraction is
	// bounded before manifest validation to keep integrity-valid zstd bombs
	// from exhausting disk or decoder memory.
	maxCapsuleTarEntryBytes   = 16 * 1024 * 1024
	maxCapsuleTarPayloadBytes = 64 * 1024 * 1024
	maxCapsuleTarEntries      = 1024
	maxCapsuleDecodedTarBytes = maxCapsuleTarPayloadBytes + 4*1024*1024
)

var (
	ErrSRIMismatch = errors.New("capsule fetch: sri mismatch")

	sriPattern       = regexp.MustCompile(`^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$`)
	reverseDNSID     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
	opaqueCapsuleID  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$`)
	capsuleVersion   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$`)
	controlCharacter = regexp.MustCompile(`[\x00-\x1f\x7f]`)
)

type Integrity struct {
	Algorithm string
	Digest    []byte
	Token     string
}

type Manifest struct {
	ID      string
	Version string
}

func FetchCapsule(ctx context.Context, ref string, integrity string) (string, error) {
	return fetchCapsule(ctx, ref, integrity, Manifest{})
}

func FetchCapsuleFor(ctx context.Context, ref string, integrity string, id string, version string) (string, error) {
	return fetchCapsule(ctx, ref, integrity, Manifest{ID: id, Version: version})
}

func fetchCapsule(ctx context.Context, ref string, integrity string, expected Manifest) (string, error) {
	if err := ctx.Err(); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}

	parsedIntegrity, err := ParseIntegrity(integrity)
	if err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}

	sourcePath, err := ResolveLocalRef(ref)
	if err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}

	artifact, cleanupArtifact, err := verifiedArtifact(ctx, sourcePath, parsedIntegrity)
	if err != nil {
		if errors.Is(err, ErrSRIMismatch) {
			log.Printf("VITA-CAPSULE-FETCH-REJECT: reason=sri_mismatch")
			return "", err
		}
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}
	defer cleanupArtifact()

	root := CacheRoot()
	if err := os.MkdirAll(root, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", fmt.Errorf("create capsule cache root: %w", err)
	}
	if err := os.Chmod(root, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", fmt.Errorf("secure capsule cache root: %w", err)
	}

	tmpDir, err := os.MkdirTemp(root, ".fetch-*.tmp")
	if err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", fmt.Errorf("create capsule extract temp dir: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(tmpDir)
		}
	}()

	if err := os.Chmod(tmpDir, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", fmt.Errorf("secure capsule extract temp dir: %w", err)
	}
	if err := extractTar(ctx, artifact, tmpDir); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}

	manifest, err := ReadManifest(tmpDir)
	if err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}
	if expected.ID != "" || expected.Version != "" {
		if !validCapsuleID(expected.ID) || !validVersion(expected.Version) {
			log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
			return "", fmt.Errorf("expected capsule id/version is unsafe")
		}
		if manifest != expected {
			log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
			return "", fmt.Errorf("capsule artifact manifest does not match fetch request")
		}
	}
	target, err := CachePath(manifest.ID, manifest.Version)
	if err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}
	if err := verifyCompleteness(tmpDir, manifest); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}

	targetParent := filepath.Dir(target)
	if err := os.MkdirAll(targetParent, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", fmt.Errorf("create capsule cache parent: %w", err)
	}
	if err := os.Chmod(targetParent, cacheDirMode); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", fmt.Errorf("secure capsule cache parent: %w", err)
	}

	if complete, err := existingComplete(target, manifest); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	} else if complete {
		log.Printf("VITA-CAPSULE-FETCH: id=%s sri=%s verified=OK status=OK", manifest.ID, parsedIntegrity.Short())
		return target, nil
	}

	if err := ctx.Err(); err != nil {
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", err
	}
	// Rename is the single commit point: all validation and fallible staging work
	// is complete before this point, and no fallible work runs after it.
	if err := os.Rename(tmpDir, target); err != nil {
		if complete, completeErr := existingComplete(target, manifest); completeErr == nil && complete {
			log.Printf("VITA-CAPSULE-FETCH: id=%s sri=%s verified=OK status=OK", manifest.ID, parsedIntegrity.Short())
			return target, nil
		}
		log.Printf("VITA-CAPSULE-FETCH-ERROR: FAILSAFE")
		return "", fmt.Errorf("commit capsule cache extract: %w", err)
	}
	committed = true

	log.Printf("VITA-CAPSULE-FETCH: id=%s sri=%s verified=OK status=OK", manifest.ID, parsedIntegrity.Short())
	return target, nil
}

func CacheRoot() string {
	if root := os.Getenv(cacheRootEnv); root != "" {
		return root
	}
	return defaultCacheRoot
}

func CachePath(id string, version string) (string, error) {
	if !validCapsuleID(id) {
		return "", fmt.Errorf("capsule manifest id is unsafe")
	}
	if !validVersion(version) {
		return "", fmt.Errorf("capsule manifest version is unsafe")
	}
	return filepath.Join(CacheRoot(), id, version), nil
}

func RemoveStagedCapsule(ctx context.Context, localPath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if localPath == "" {
		return errors.New("capsule cache path is required")
	}

	root, err := filepath.Abs(CacheRoot())
	if err != nil {
		return fmt.Errorf("resolve capsule cache root: %w", err)
	}
	target, err := filepath.Abs(localPath)
	if err != nil {
		return fmt.Errorf("resolve capsule cache path: %w", err)
	}
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return fmt.Errorf("resolve capsule cache relative path: %w", err)
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("capsule cache path escapes root")
	}

	if err := os.RemoveAll(target); err != nil {
		return fmt.Errorf("remove staged capsule: %w", err)
	}
	return nil
}

func ResolveLocalRef(ref string) (string, error) {
	if ref == "" || ref != strings.TrimSpace(ref) || controlCharacter.MatchString(ref) {
		return "", fmt.Errorf("capsule artifact ref must be a non-empty local reference")
	}
	if runtime.GOOS == "windows" && filepath.IsAbs(ref) {
		return filepath.Clean(ref), nil
	}

	parsed, err := url.Parse(ref)
	if err != nil {
		return "", fmt.Errorf("parse capsule artifact ref: %w", err)
	}
	if parsed.Scheme == "" {
		if strings.Contains(ref, "://") {
			return "", fmt.Errorf("capsule artifact ref must be local")
		}
		return filepath.Clean(ref), nil
	}
	if parsed.Scheme != "file" {
		return "", fmt.Errorf("capsule artifact ref must use file:// or a local path")
	}
	if parsed.Host != "" && parsed.Host != "localhost" {
		return "", fmt.Errorf("capsule artifact file:// host must be empty or localhost")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("capsule artifact file:// ref must not include query or fragment")
	}

	filePath := parsed.Path
	if runtime.GOOS == "windows" {
		filePath = strings.TrimPrefix(filePath, "/")
	}
	if filePath == "" {
		return "", fmt.Errorf("capsule artifact file:// path is required")
	}
	return filepath.Clean(filepath.FromSlash(filePath)), nil
}

func ParseIntegrity(value string) (Integrity, error) {
	matches := sriPattern.FindStringSubmatch(value)
	if len(matches) != 3 {
		return Integrity{}, fmt.Errorf("capsule integrity must be sha256/sha384/sha512 SRI")
	}

	algorithm := "sha" + matches[1]
	expectedLength := 0
	switch algorithm {
	case "sha256":
		expectedLength = sha256.Size
	case "sha384":
		expectedLength = sha512.Size384
	case "sha512":
		expectedLength = sha512.Size
	default:
		return Integrity{}, fmt.Errorf("capsule integrity algorithm is unsupported")
	}

	token := matches[2]
	var digest []byte
	var err error
	if strings.Contains(token, "=") {
		digest, err = base64.StdEncoding.DecodeString(token)
	} else {
		digest, err = base64.RawStdEncoding.DecodeString(token)
	}
	if err != nil || len(digest) != expectedLength {
		return Integrity{}, fmt.Errorf("capsule integrity digest length is invalid")
	}

	return Integrity{
		Algorithm: algorithm,
		Digest:    cloneBytes(digest),
		Token:     token,
	}, nil
}

func IsValidIntegrity(value string) bool {
	_, err := ParseIntegrity(value)
	return err == nil
}

func (i Integrity) Short() string {
	token := i.Token
	if len(token) > 12 {
		token = token[:12]
	}
	return i.Algorithm + "-" + token
}

func ReadManifest(dir string) (Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return Manifest{}, fmt.Errorf("read capsule manifest: %w", err)
	}
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return Manifest{}, fmt.Errorf("parse capsule manifest: %w", err)
	}

	var fields map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&fields); err != nil {
		return Manifest{}, fmt.Errorf("parse capsule manifest: %w", err)
	}
	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return Manifest{}, fmt.Errorf("parse capsule manifest: body must contain exactly one JSON value")
		}
		return Manifest{}, fmt.Errorf("parse capsule manifest: %w", err)
	}

	id, err := requiredManifestString(fields, "id")
	if err != nil {
		return Manifest{}, err
	}
	version, err := requiredManifestString(fields, "version")
	if err != nil {
		return Manifest{}, err
	}
	manifest := Manifest{ID: id, Version: version}
	if _, err := CachePath(manifest.ID, manifest.Version); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func verifiedArtifact(ctx context.Context, sourcePath string, integrity Integrity) (*os.File, func(), error) {
	source, err := os.Open(sourcePath)
	if err != nil {
		return nil, nil, fmt.Errorf("open capsule artifact: %w", err)
	}
	defer source.Close()

	info, err := source.Stat()
	if err != nil {
		return nil, nil, fmt.Errorf("stat capsule artifact: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("capsule artifact must be a regular file")
	}

	tmp, err := os.CreateTemp("", ".vita-capsule-artifact-*.tmp")
	if err != nil {
		return nil, nil, fmt.Errorf("create capsule artifact verification temp: %w", err)
	}
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}

	if err := tmp.Chmod(cacheFileMode); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("secure capsule artifact verification temp: %w", err)
	}

	hasher, err := integrityHasher(integrity.Algorithm)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	if err := copyWithContext(ctx, io.MultiWriter(tmp, hasher), source); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("read capsule artifact: %w", err)
	}
	if subtle.ConstantTimeCompare(hasher.Sum(nil), integrity.Digest) != 1 {
		cleanup()
		return nil, nil, ErrSRIMismatch
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("sync capsule artifact verification temp: %w", err)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("rewind capsule artifact verification temp: %w", err)
	}

	return tmp, cleanup, nil
}

func integrityHasher(algorithm string) (hash.Hash, error) {
	switch algorithm {
	case "sha256":
		return sha256.New(), nil
	case "sha384":
		return sha512.New384(), nil
	case "sha512":
		return sha512.New(), nil
	default:
		return nil, fmt.Errorf("capsule integrity algorithm is unsupported")
	}
}

func extractTar(ctx context.Context, reader io.Reader, dest string) error {
	decoder, err := zstd.NewReader(
		reader,
		zstd.WithDecoderConcurrency(1),
		zstd.WithDecoderMaxMemory(uint64(maxCapsuleDecodedTarBytes)),
		zstd.WithDecoderMaxWindow(uint64(maxCapsuleTarEntryBytes)),
	)
	if err != nil {
		return fmt.Errorf("create capsule zstd decoder: %w", err)
	}
	defer decoder.Close()

	limitedArchive := &maxBytesReader{
		reader:    decoder,
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
			return fmt.Errorf("read capsule tar entry: %w", err)
		}
		entries++
		if entries > maxCapsuleTarEntries {
			return fmt.Errorf("capsule tar archive exceeds entry limit (%d)", maxCapsuleTarEntries)
		}
		if header.Size < 0 {
			return fmt.Errorf("capsule tar entry %q has negative size", header.Name)
		}

		entryName, err := safeArchiveName(header.Name)
		if err != nil {
			return err
		}
		target, err := safeExtractPath(dest, entryName)
		if err != nil {
			return err
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, cacheDirMode); err != nil {
				return fmt.Errorf("create capsule tar directory: %w", err)
			}
			if err := os.Chmod(target, cacheDirMode); err != nil {
				return fmt.Errorf("secure capsule tar directory: %w", err)
			}
		case tar.TypeReg:
			if header.Size > maxCapsuleTarEntryBytes {
				return fmt.Errorf("capsule tar entry %q exceeds per-entry size limit (%d bytes)", header.Name, maxCapsuleTarEntryBytes)
			}
			if totalPayloadBytes > maxCapsuleTarPayloadBytes-header.Size {
				return fmt.Errorf("capsule tar archive exceeds total payload size limit (%d bytes)", maxCapsuleTarPayloadBytes)
			}
			totalPayloadBytes += header.Size
			if err := writeTarFile(ctx, target, tarReader, header.Size); err != nil {
				return err
			}
		default:
			return fmt.Errorf("capsule tar entry %q has unsupported type %d", header.Name, header.Typeflag)
		}
	}
	if entries == 0 {
		return fmt.Errorf("capsule tar archive is empty")
	}
	return nil
}

func writeTarFile(ctx context.Context, target string, reader io.Reader, expectedSize int64) error {
	if err := os.MkdirAll(filepath.Dir(target), cacheDirMode); err != nil {
		return fmt.Errorf("create capsule tar file parent: %w", err)
	}

	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, cacheFileMode)
	if err != nil {
		return fmt.Errorf("create capsule tar file: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
	}()

	if err := file.Chmod(cacheFileMode); err != nil {
		return fmt.Errorf("secure capsule tar file: %w", err)
	}
	limitedReader := &io.LimitedReader{R: reader, N: expectedSize + 1}
	written, err := copyWithContextCount(ctx, file, limitedReader)
	if err != nil {
		return fmt.Errorf("write capsule tar file: %w", err)
	}
	if written > expectedSize || limitedReader.N == 0 {
		return fmt.Errorf("capsule tar file exceeds declared size")
	}
	if written != expectedSize {
		return fmt.Errorf("capsule tar file is truncated")
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync capsule tar file: %w", err)
	}
	if err := file.Close(); err != nil {
		closed = true
		return fmt.Errorf("close capsule tar file: %w", err)
	}
	closed = true
	return nil
}

type maxBytesReader struct {
	reader    io.Reader
	remaining int64
	limit     int64
}

func (r *maxBytesReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		var one [1]byte
		n, err := r.reader.Read(one[:])
		if n > 0 {
			return 0, fmt.Errorf("capsule zstd stream exceeds decoded tar limit (%d bytes)", r.limit)
		}
		return 0, err
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.reader.Read(p)
	r.remaining -= int64(n)
	return n, err
}

func safeArchiveName(name string) (string, error) {
	if name == "" || strings.Contains(name, `\`) || strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("capsule tar entry has unsafe path")
	}
	cleaned := path.Clean(name)
	if cleaned == "." || cleaned == ".." || path.IsAbs(cleaned) || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("capsule tar entry %q escapes capsule root", name)
	}
	for _, part := range strings.Split(cleaned, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("capsule tar entry %q escapes capsule root", name)
		}
	}
	return cleaned, nil
}

func safeExtractPath(dest string, archiveName string) (string, error) {
	target := filepath.Join(dest, filepath.FromSlash(archiveName))
	rel, err := filepath.Rel(dest, target)
	if err != nil {
		return "", fmt.Errorf("resolve capsule tar entry path: %w", err)
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("capsule tar entry %q escapes capsule root", archiveName)
	}
	return target, nil
}

func verifyCompleteness(dir string, manifest Manifest) error {
	if _, err := ReadManifest(dir); err != nil {
		return err
	}
	if !validCapsuleID(manifest.ID) || !validVersion(manifest.Version) {
		return fmt.Errorf("capsule manifest id/version is unsafe")
	}

	entrypoint := filepath.Join(dir, "main.ts")
	info, err := os.Stat(entrypoint)
	if err != nil {
		return fmt.Errorf("stat capsule entrypoint: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("capsule entrypoint must be a regular file")
	}
	return nil
}

func existingComplete(target string, manifest Manifest) (bool, error) {
	info, err := os.Stat(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("stat existing capsule cache entry: %w", err)
	}
	if !info.IsDir() {
		return false, fmt.Errorf("existing capsule cache entry is not a directory")
	}
	existing, err := ReadManifest(target)
	if err != nil {
		return false, fmt.Errorf("validate existing capsule cache entry: %w", err)
	}
	if existing != manifest {
		return false, fmt.Errorf("existing capsule cache entry does not match artifact manifest")
	}
	if err := verifyCompleteness(target, manifest); err != nil {
		return false, fmt.Errorf("validate existing capsule cache completeness: %w", err)
	}
	return true, nil
}

func requiredManifestString(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("capsule manifest %s is required", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("capsule manifest %s must be a string", key)
	}
	if value == "" {
		return "", fmt.Errorf("capsule manifest %s is required", key)
	}
	return value, nil
}

func validCapsuleID(value string) bool {
	if len(value) > 255 ||
		value != strings.TrimSpace(value) ||
		controlCharacter.MatchString(value) ||
		strings.ContainsAny(value, `/\`) {
		return false
	}
	return reverseDNSID.MatchString(value) || opaqueCapsuleID.MatchString(value)
}

func validVersion(value string) bool {
	if len(value) > 128 ||
		value != strings.TrimSpace(value) ||
		controlCharacter.MatchString(value) ||
		strings.ContainsAny(value, `/\`) {
		return false
	}
	return capsuleVersion.MatchString(value)
}

func copyWithContext(ctx context.Context, writer io.Writer, reader io.Reader) error {
	_, err := copyWithContextCount(ctx, writer, reader)
	return err
}

func copyWithContextCount(ctx context.Context, writer io.Writer, reader io.Reader) (int64, error) {
	buffer := make([]byte, 32*1024)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}

		read, readErr := reader.Read(buffer)
		if read > 0 {
			written, writeErr := writer.Write(buffer[:read])
			if writeErr != nil {
				return total, writeErr
			}
			if written != read {
				return total, io.ErrShortWrite
			}
			total += int64(written)
		}
		if errors.Is(readErr, io.EOF) {
			return total, nil
		}
		if readErr != nil {
			return total, readErr
		}
	}
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}
