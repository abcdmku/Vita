package capsule

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"strconv"
	"strings"

	"github.com/vita/agent/internal/jsonsafe"
	capsulestorage "github.com/vita/agent/storage/capsules"
)

type OCIExecution struct {
	Image OCIImageExecution `json:"image"`
}

func (e *OCIExecution) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, ociExecutionFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	var image OCIImageExecution
	if err := requiredObjectField(fields, "image", &image); err != nil {
		return err
	}

	out := OCIExecution{Image: image}
	if err := out.Validate(); err != nil {
		return err
	}

	*e = out
	return nil
}

func (e OCIExecution) Validate() error {
	return e.Image.Validate()
}

type OCIImageExecution struct {
	Digest     string   `json:"digest"`
	Entrypoint []string `json:"entrypoint"`
}

func (e *OCIImageExecution) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, ociImageExecutionFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	digest, err := requiredStringField(fields, "digest")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	entrypoint, err := requiredOCIEntrypointField(fields, "entrypoint")
	if err != nil {
		return err
	}

	out := OCIImageExecution{
		Digest:     digest,
		Entrypoint: entrypoint,
	}
	if err := out.Validate(); err != nil {
		return err
	}

	*e = out
	return nil
}

func (e OCIImageExecution) Validate() error {
	if !validOCIDigest(e.Digest) {
		return &ExecuteInvalidRequestError{Reason: "runtime.oci.image.digest must be a sha256 OCI digest"}
	}
	if len(e.Entrypoint) == 0 {
		return &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "runtime.oci.image.entrypoint is required"}
	}
	for i, arg := range e.Entrypoint {
		if err := validateOCIArgvElement(arg, i == 0); err != nil {
			return &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: fmt.Sprintf("runtime.oci.image.entrypoint[%d]: %v", i, err)}
		}
	}
	return nil
}

func composeOCITransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	if err := manifest.Runtime.ValidateForPackageClass(executePackageClassOCIService); err != nil {
		return transientUnit{}, err
	}

	unitName := capsuleUnitName(manifest.ID)
	limits := manifest.ResourceLimits
	volumes, err := capsulestorage.SetupVolumes(manifest.ID, manifest.Data.Volumes)
	if err != nil {
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	properties := hardenedTransientUnitProperties(manifest, false)
	properties = append(properties,
		systemdProperty{Name: "RootDirectory", Value: ociRootDirectory(manifest)},
		systemdProperty{Name: "MountAPIVFS", Value: "yes"},
		systemdProperty{Name: "MemoryMax", Value: strconv.FormatInt(limits.RamMiB*1024*1024, 10)},
		systemdProperty{Name: "CPUQuota", Value: cpuQuota(limits.CPUCores)},
		systemdProperty{Name: "TasksMax", Value: strconv.FormatInt(limits.TasksMax, 10)},
	)
	if len(volumes) > 0 {
		properties = append(properties,
			systemdProperty{Name: "StateDirectory", Value: stateDirectories(volumes)},
			systemdProperty{Name: "StateDirectoryMode", Value: capsulestorage.StateDirectoryMode()},
		)
	}

	return transientUnit{
		Name:       unitName,
		Argv:       append([]string(nil), manifest.Runtime.OCI.Image.Entrypoint...),
		Properties: properties,
		Volumes:    volumes,
	}, nil
}

func statOCIManifestArtifacts(manifest ExecutionManifest) error {
	rootfs := ociRootDirectory(manifest)
	info, err := os.Stat(rootfs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &ExecuteInvalidRequestError{Code: "rootfs_absent", Reason: "capsule oci rootfs is absent"}
		}
		return fmt.Errorf("stat capsule oci rootfs: %w", err)
	}
	if !info.IsDir() {
		return &ExecuteInvalidRequestError{Code: "rootfs_inaccessible", Reason: "capsule oci rootfs must be a directory"}
	}
	if !worldReadableExecutable(info.Mode()) {
		return &ExecuteInvalidRequestError{Code: "permission_denied", Reason: "capsule oci rootfs must be world-readable and executable"}
	}

	entrypointPath, err := ociEntrypointHostPath(manifest)
	if err != nil {
		return err
	}
	if err := statOCIEntrypointDirectories(rootfs, entrypointPath); err != nil {
		return err
	}
	info, err = os.Stat(entrypointPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &ExecuteInvalidRequestError{Code: "exec_failed", Reason: "capsule oci entrypoint is absent"}
		}
		return fmt.Errorf("stat capsule oci entrypoint: %w", err)
	}
	if info.IsDir() {
		return &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "capsule oci entrypoint must be a file"}
	}
	if !worldReadableExecutable(info.Mode()) {
		return &ExecuteInvalidRequestError{Code: "permission_denied", Reason: "capsule oci entrypoint must be world-readable and executable"}
	}
	return nil
}

func statOCIEntrypointDirectories(rootfs string, entrypointPath string) error {
	parent := path.Dir(entrypointPath)
	for {
		if parent == rootfs || parent == "." || parent == "/" {
			return nil
		}
		info, err := os.Stat(parent)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return &ExecuteInvalidRequestError{Code: "exec_failed", Reason: "capsule oci entrypoint directory is absent"}
			}
			return fmt.Errorf("stat capsule oci entrypoint directory: %w", err)
		}
		if !info.IsDir() {
			return &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "capsule oci entrypoint path parent must be a directory"}
		}
		if !worldReadableExecutable(info.Mode()) {
			return &ExecuteInvalidRequestError{Code: "permission_denied", Reason: "capsule oci entrypoint directory must be world-readable and executable"}
		}
		parent = path.Dir(parent)
	}
}

func ociEntrypointHostPath(manifest ExecutionManifest) (string, error) {
	if err := manifest.Runtime.ValidateForPackageClass(executePackageClassOCIService); err != nil {
		return "", err
	}
	entrypoint := manifest.Runtime.OCI.Image.Entrypoint[0]
	cleaned := path.Clean(entrypoint)
	return path.Join(ociRootDirectory(manifest), strings.TrimPrefix(cleaned, "/")), nil
}

func ociRootDirectory(manifest ExecutionManifest) string {
	baseDir := manifest.baseDir
	if baseDir == "" {
		baseDir = path.Join(defaultCapsuleRoot, manifest.ID)
	}
	return path.Join(baseDir, "rootfs")
}

func requiredOCIEntrypointField(fields map[string]json.RawMessage, key string) ([]string, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "runtime.oci.image." + key + " is required"}
	}

	var entrypoint []string
	if err := decodeSingleJSONValue(raw, &entrypoint); err != nil {
		return nil, &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "runtime.oci.image." + key + " must be an argv list"}
	}
	if entrypoint == nil {
		return nil, &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "runtime.oci.image." + key + " must be an argv list"}
	}
	return entrypoint, nil
}

func validOCIDigest(value string) bool {
	algorithm, encoded, ok := strings.Cut(value, ":")
	if !ok || algorithm != "sha256" || len(encoded) != 64 || encoded != strings.ToLower(encoded) {
		return false
	}
	decoded, err := hex.DecodeString(encoded)
	return err == nil && len(decoded) == 32
}

func validateOCIArgvElement(value string, entrypoint bool) error {
	if value == "" {
		return errors.New("must not be empty")
	}
	if controlCharacter.MatchString(value) {
		return errors.New("must not contain control characters")
	}
	if !safeOCIArgvToken(value) {
		return errors.New("contains unsupported argv characters")
	}
	if !entrypoint {
		return nil
	}
	if !path.IsAbs(value) {
		return errors.New("must be an absolute in-rootfs path")
	}
	if value == "/" || path.Clean(value) != value {
		return errors.New("must be a clean absolute in-rootfs path")
	}
	return nil
}

func worldReadableExecutable(mode os.FileMode) bool {
	return mode.Perm()&0o005 == 0o005
}

func safeOCIArgvToken(value string) bool {
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case strings.ContainsRune("/._-:=+,", r):
		default:
			return false
		}
	}
	return true
}

var (
	ociExecutionFields = map[string]struct{}{
		"image": {},
	}
	ociImageExecutionFields = map[string]struct{}{
		"digest":     {},
		"entrypoint": {},
	}
)
