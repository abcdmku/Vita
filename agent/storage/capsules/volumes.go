package capsules

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/vita/agent/internal/jsonsafe"
)

const (
	VolumeMountRoot = "/var/lib/vita/runtime/volumes"

	stateDirectoryRoot = "vita/runtime/volumes"
	stateDirectoryMode = "0700"
)

type DataClass string

const (
	DataClassUserContent   DataClass = "user-content"
	DataClassAppState      DataClass = "app-state"
	DataClassCache         DataClass = "cache"
	DataClassLogs          DataClass = "logs"
	DataClassTelemetry     DataClass = "telemetry"
	DataClassConfiguration DataClass = "configuration"
)

type VolumeAccess string

const (
	VolumeAccessReadOnly  VolumeAccess = "read-only"
	VolumeAccessReadWrite VolumeAccess = "read-write"
)

type VolumePersistence string

const (
	VolumePersistencePersistent VolumePersistence = "persistent"
)

type VolumeSpec struct {
	Name        string            `json:"name"`
	MountPath   string            `json:"mountPath"`
	Class       DataClass         `json:"class"`
	Access      VolumeAccess      `json:"access"`
	Persistence VolumePersistence `json:"persistence"`
	Backup      bool              `json:"backup"`
	SizeMiB     int64             `json:"sizeMiB"`
}

type VolumeMount struct {
	Name           string
	Path           string
	StateDirectory string
	Access         VolumeAccess
}

func (s *VolumeSpec) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return err
	}

	fields, err := decodeVolumeObject(raw)
	if err != nil {
		return err
	}
	if err := rejectUnknownVolumeFields(fields, volumeSpecFields); err != nil {
		return err
	}

	name, err := requiredVolumeString(fields, "name")
	if err != nil {
		return err
	}
	mountPath, err := requiredVolumeString(fields, "mountPath")
	if err != nil {
		return err
	}
	classValue, err := requiredVolumeString(fields, "class")
	if err != nil {
		return err
	}
	accessValue, err := requiredVolumeString(fields, "access")
	if err != nil {
		return err
	}
	persistenceValue, err := requiredVolumeString(fields, "persistence")
	if err != nil {
		return err
	}
	backup, err := requiredVolumeBool(fields, "backup")
	if err != nil {
		return err
	}
	sizeMiB, err := requiredVolumePositiveInt64(fields, "sizeMiB")
	if err != nil {
		return err
	}

	out := VolumeSpec{
		Name:        name,
		MountPath:   mountPath,
		Class:       DataClass(classValue),
		Access:      VolumeAccess(accessValue),
		Persistence: VolumePersistence(persistenceValue),
		Backup:      backup,
		SizeMiB:     sizeMiB,
	}
	if err := out.Validate(); err != nil {
		return err
	}

	*s = out
	return nil
}

func (s VolumeSpec) Validate() error {
	if !validVolumeName(s.Name) {
		return errors.New("volume.name must be a safe volume name")
	}
	if !validAbsoluteVolumePath(s.MountPath) {
		return errors.New("volume.mountPath must be a canonical absolute path")
	}
	if !validDataClass(s.Class) {
		return errors.New("volume.class must be a supported data class")
	}
	if s.Access != VolumeAccessReadOnly && s.Access != VolumeAccessReadWrite {
		return errors.New("volume.access must be read-only or read-write")
	}
	if s.Persistence != VolumePersistencePersistent {
		return errors.New("volume.persistence must be persistent")
	}
	if s.SizeMiB <= 0 {
		return errors.New("volume.sizeMiB must be positive")
	}
	return nil
}

func SetupVolume(capsuleID string, spec VolumeSpec) (VolumeMount, error) {
	if !validCapsuleID(capsuleID) {
		return VolumeMount{}, errors.New("capsule id is unsafe")
	}
	if err := spec.Validate(); err != nil {
		return VolumeMount{}, err
	}

	stateDirectory := path.Join(stateDirectoryRoot, capsuleVolumeScope(capsuleID), spec.Name)
	mountPath := "/" + path.Join("var/lib", stateDirectory)
	if spec.MountPath != mountPath {
		return VolumeMount{}, fmt.Errorf("volume.mountPath must match state directory path %q", mountPath)
	}

	return VolumeMount{
		Name:           spec.Name,
		Path:           mountPath,
		StateDirectory: stateDirectory,
		Access:         spec.Access,
	}, nil
}

func SetupVolumes(capsuleID string, specs []VolumeSpec) ([]VolumeMount, error) {
	if len(specs) == 0 {
		return nil, nil
	}

	mounts := make([]VolumeMount, 0, len(specs))
	seen := make(map[string]int, len(specs))
	for i, spec := range specs {
		if previous, ok := seen[spec.Name]; ok {
			return nil, fmt.Errorf("volume.name %q duplicates volume %d", spec.Name, previous)
		}
		seen[spec.Name] = i

		mount, err := SetupVolume(capsuleID, spec)
		if err != nil {
			return nil, fmt.Errorf("volumes[%d]: %w", i, err)
		}
		mounts = append(mounts, mount)
	}
	return mounts, nil
}

func TeardownVolume(context.Context, VolumeMount) error {
	// StateDirectory is owned by systemd's unit lifecycle. Stopping the unit removes
	// the private mount namespace only; the /var/lib state directory data persists.
	return nil
}

func StateDirectoryMode() string {
	return stateDirectoryMode
}

func VolumePath(capsuleID string, volumeName string) (string, error) {
	if !validCapsuleID(capsuleID) {
		return "", errors.New("capsule id is unsafe")
	}
	if !validVolumeName(volumeName) {
		return "", errors.New("volume name is unsafe")
	}
	return "/" + path.Join("var/lib", stateDirectoryRoot, capsuleVolumeScope(capsuleID), volumeName), nil
}

var (
	volumeNamePattern        = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	systemdSafePathComponent = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$`)

	volumeSpecFields = map[string]struct{}{
		"access":      {},
		"backup":      {},
		"class":       {},
		"mountPath":   {},
		"name":        {},
		"persistence": {},
		"sizeMiB":     {},
	}
)

func capsuleVolumeScope(capsuleID string) string {
	if systemdSafePathComponent.MatchString(capsuleID) && capsuleID != "." && capsuleID != ".." {
		return capsuleID
	}

	slug := strings.NewReplacer(":", "-", "_", "-", ".", ".").Replace(capsuleID)
	slug = regexp.MustCompile(`[^A-Za-z0-9_.-]+`).ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, ".-")
	if slug == "" {
		slug = "capsule"
	}
	if len(slug) > 96 {
		slug = slug[:96]
	}
	sum := sha256.Sum256([]byte(capsuleID))
	return slug + "-" + hex.EncodeToString(sum[:4])
}

func validVolumeName(value string) bool {
	return volumeNamePattern.MatchString(value)
}

func validDataClass(value DataClass) bool {
	switch value {
	case DataClassUserContent, DataClassAppState, DataClassCache, DataClassLogs, DataClassTelemetry, DataClassConfiguration:
		return true
	default:
		return false
	}
}

func validAbsoluteVolumePath(value string) bool {
	if value == "" || !strings.HasPrefix(value, "/") || strings.ContainsRune(value, 0) || strings.Contains(value, `\`) {
		return false
	}
	cleaned := path.Clean(value)
	return cleaned == value && value != "/" && !strings.Contains(value, "/../") && !strings.HasSuffix(value, "/..")
}

func decodeVolumeObject(raw []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != '{' {
		return nil, errors.New("expected volume object")
	}

	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("expected volume object key")
		}
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("duplicate JSON object key %q", key)
		}

		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = cloneBytes(value)
	}

	token, err = decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, ok = token.(json.Delim)
	if !ok || delimiter != '}' {
		return nil, errors.New("expected volume object end")
	}

	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, errors.New("body must contain exactly one JSON value")
		}
		return nil, err
	}
	return fields, nil
}

func rejectUnknownVolumeFields(fields map[string]json.RawMessage, allowed map[string]struct{}) error {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		if _, ok := allowed[name]; !ok {
			return fmt.Errorf("unknown volume field %q", name)
		}
	}
	return nil
}

func requiredVolumeString(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", fmt.Errorf("volume.%s is required", key)
	}
	var value string
	if err := decodeVolumeSingleJSONValue(raw, &value); err != nil {
		return "", fmt.Errorf("volume.%s must be a string", key)
	}
	if value == "" {
		return "", fmt.Errorf("volume.%s is required", key)
	}
	return value, nil
}

func requiredVolumeBool(fields map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, fmt.Errorf("volume.%s is required", key)
	}
	var value bool
	if err := decodeVolumeSingleJSONValue(raw, &value); err != nil {
		return false, fmt.Errorf("volume.%s must be a boolean", key)
	}
	return value, nil
}

func requiredVolumePositiveInt64(fields map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, fmt.Errorf("volume.%s is required", key)
	}
	var value int64
	if err := decodeVolumeSingleJSONValue(raw, &value); err != nil {
		return 0, fmt.Errorf("volume.%s must be an integer", key)
	}
	if value <= 0 {
		return 0, fmt.Errorf("volume.%s must be positive", key)
	}
	return value, nil
}

func decodeVolumeSingleJSONValue(raw []byte, target interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(target); err != nil {
		return err
	}

	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("body must contain exactly one JSON value")
		}
		return err
	}
	return nil
}
