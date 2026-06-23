package capsules

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/vita/agent/internal/sysdeps"
)

const (
	// VolumeMountRoot is backed by the persistent /var data partition on verity
	// images. Host paths include the capsule id; unit paths intentionally expose
	// only the requested volume name.
	VolumeMountRoot = "/var/lib/vita/runtime/volumes"

	volumeRootMode       fs.FileMode = 0o755
	capsuleDirMode       fs.FileMode = 0o710
	volumeDirMode        fs.FileMode = 0o2770
	capsuleGroupUID                  = 0
	capsuleGroupPrefix               = "vita-cap-"
	capsuleGroupGIDBase              = 1_000_000_000
	capsuleGroupGIDRange             = 1_000_000_000
)

type VolumeSpec struct {
	Name        string
	MountPath   string
	Class       string
	Access      string
	Persistence string
	Backup      bool
	SizeMiB     int64
}

type Mount struct {
	VolumeName  string
	Source      string
	Destination string
	BindPath    string
	Group       string
	GroupID     int
	ReadOnly    bool
}

type groupIdentity struct {
	name      string
	gid       int
	unitToken string
}

type volumeHost interface {
	MkdirAll(string, fs.FileMode) error
	Chown(string, int, int) error
	Chmod(string, fs.FileMode) error
	EnsureGroup(context.Context, string) (groupIdentity, error)
	Unmount(string) error
}

type osVolumeHost struct{}

func (osVolumeHost) MkdirAll(target string, mode fs.FileMode) error {
	return os.MkdirAll(target, mode)
}

func (osVolumeHost) Chown(target string, uid, gid int) error {
	return sysdeps.Chown(target, uid, gid)
}

func (osVolumeHost) Chmod(target string, mode fs.FileMode) error {
	return os.Chmod(target, mode)
}

func (osVolumeHost) EnsureGroup(ctx context.Context, capsuleID string) (groupIdentity, error) {
	return ensureCapsuleGroup(ctx, capsuleID)
}

func (osVolumeHost) Unmount(target string) error {
	return sysdeps.Unmount(target)
}

var (
	capsulePathIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{2,254}$`)
	volumeNamePattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	dataClasses          = map[string]struct{}{
		"app-state":     {},
		"cache":         {},
		"configuration": {},
		"logs":          {},
		"telemetry":     {},
		"user-content":  {},
	}
)

func SetupVolume(capsuleID string, spec VolumeSpec) (Mount, error) {
	return SetupVolumeContext(context.Background(), capsuleID, spec)
}

func SetupVolumeContext(ctx context.Context, capsuleID string, spec VolumeSpec) (Mount, error) {
	return setupVolume(ctx, osVolumeHost{}, VolumeMountRoot, capsuleID, spec)
}

func TeardownVolume(mount Mount) error {
	return TeardownVolumeContext(context.Background(), mount)
}

func TeardownVolumeContext(ctx context.Context, mount Mount) error {
	return teardownVolume(ctx, osVolumeHost{}, mount)
}

func CapsuleGroupName(capsuleID string) string {
	sum := sha256.Sum256([]byte(capsuleID))
	return capsuleGroupPrefix + hex.EncodeToString(sum[:8])
}

func CapsuleGroupID(capsuleID string) int {
	sum := sha256.Sum256([]byte(capsuleID))
	offset := binary.BigEndian.Uint32(sum[8:12]) % capsuleGroupGIDRange
	return capsuleGroupGIDBase + int(offset)
}

func VolumeMountPath(name string) string {
	return path.Join(VolumeMountRoot, name)
}

func VolumeHostPath(capsuleID string, name string) string {
	return path.Join(VolumeMountRoot, capsuleID, name)
}

func setupVolume(ctx context.Context, host volumeHost, root string, capsuleID string, spec VolumeSpec) (Mount, error) {
	if err := ctx.Err(); err != nil {
		return Mount{}, err
	}
	if host == nil {
		return Mount{}, errors.New("capsule volume host is required")
	}

	root, err := cleanAbsolutePath(root, "volume root")
	if err != nil {
		return Mount{}, err
	}
	if err := validateCapsulePathID(capsuleID); err != nil {
		return Mount{}, err
	}
	if err := validateVolumeSpec(spec); err != nil {
		return Mount{}, err
	}

	group, err := host.EnsureGroup(ctx, capsuleID)
	if err != nil {
		return Mount{}, err
	}
	if group.gid <= 0 || group.unitToken == "" {
		return Mount{}, fmt.Errorf("capsule volume group is invalid")
	}

	capsulePath := path.Join(root, capsuleID)
	volumePath := path.Join(capsulePath, spec.Name)
	destination := VolumeMountPath(spec.Name)

	if err := host.MkdirAll(root, volumeRootMode); err != nil {
		return Mount{}, fmt.Errorf("create capsule volume root: %w", err)
	}
	if err := host.Chmod(root, volumeRootMode); err != nil {
		return Mount{}, fmt.Errorf("secure capsule volume root: %w", err)
	}
	if err := host.MkdirAll(capsulePath, capsuleDirMode); err != nil {
		return Mount{}, fmt.Errorf("create capsule volume capsule dir: %w", err)
	}
	if err := host.Chown(capsulePath, capsuleGroupUID, group.gid); err != nil {
		return Mount{}, fmt.Errorf("own capsule volume capsule dir: %w", err)
	}
	if err := host.Chmod(capsulePath, capsuleDirMode); err != nil {
		return Mount{}, fmt.Errorf("secure capsule volume capsule dir: %w", err)
	}
	if err := host.MkdirAll(volumePath, volumeDirMode); err != nil {
		return Mount{}, fmt.Errorf("create capsule volume dir: %w", err)
	}
	if err := host.Chown(volumePath, capsuleGroupUID, group.gid); err != nil {
		return Mount{}, fmt.Errorf("own capsule volume dir: %w", err)
	}
	if err := host.Chmod(volumePath, volumeDirMode); err != nil {
		return Mount{}, fmt.Errorf("secure capsule volume dir: %w", err)
	}

	return Mount{
		VolumeName:  spec.Name,
		Source:      volumePath,
		Destination: destination,
		BindPath:    volumePath + ":" + destination,
		Group:       group.unitToken,
		GroupID:     group.gid,
		ReadOnly:    spec.Access == "read-only",
	}, nil
}

func teardownVolume(ctx context.Context, host volumeHost, mount Mount) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if host == nil {
		return errors.New("capsule volume host is required")
	}
	if mount.Destination == "" {
		return errors.New("capsule volume mount destination is required")
	}

	if err := host.Unmount(mount.Destination); err != nil && !errors.Is(err, sysdeps.ErrNotMounted) {
		return fmt.Errorf("unmount capsule volume: %w", err)
	}
	return nil
}

func ensureCapsuleGroup(ctx context.Context, capsuleID string) (groupIdentity, error) {
	if err := ctx.Err(); err != nil {
		return groupIdentity{}, err
	}

	name := CapsuleGroupName(capsuleID)
	gid := CapsuleGroupID(capsuleID)

	if group, err := user.LookupGroup(name); err == nil {
		groupGID, err := strconv.Atoi(group.Gid)
		if err != nil {
			return groupIdentity{}, fmt.Errorf("read capsule group gid: %w", err)
		}
		if groupGID != gid {
			return groupIdentity{}, fmt.Errorf("capsule group %s has gid %d, want %d", name, groupGID, gid)
		}
		return groupIdentity{name: name, gid: gid, unitToken: name}, nil
	}

	if group, err := user.LookupGroupId(strconv.Itoa(gid)); err == nil && group.Name != name {
		return groupIdentity{}, fmt.Errorf("capsule group gid %d is already assigned to %s", gid, group.Name)
	}

	if err := runGroupAdd(ctx, name, gid); err == nil {
		return groupIdentity{name: name, gid: gid, unitToken: name}, nil
	}

	if group, err := user.LookupGroup(name); err == nil {
		groupGID, parseErr := strconv.Atoi(group.Gid)
		if parseErr != nil {
			return groupIdentity{}, fmt.Errorf("read capsule group gid after create: %w", parseErr)
		}
		if groupGID != gid {
			return groupIdentity{}, fmt.Errorf("capsule group %s has gid %d, want %d", name, groupGID, gid)
		}
		return groupIdentity{name: name, gid: gid, unitToken: name}, nil
	}

	// Verity images keep /etc on the read-only root. systemd accepts numeric
	// SupplementaryGroups= tokens, so a stable per-capsule GID still gives the
	// DynamicUser access without mutating /etc/group.
	return groupIdentity{name: name, gid: gid, unitToken: strconv.Itoa(gid)}, nil
}

func runGroupAdd(ctx context.Context, name string, gid int) error {
	binaryPath := ""
	for _, candidate := range []string{"/usr/sbin/groupadd", "/usr/bin/groupadd", "/sbin/groupadd"} {
		if _, err := os.Stat(candidate); err == nil {
			binaryPath = candidate
			break
		}
	}
	if binaryPath == "" {
		return errors.New("groupadd is absent")
	}

	args := []string{"--system", "--gid", strconv.Itoa(gid), name}
	output, err := exec.CommandContext(ctx, binaryPath, args...).CombinedOutput()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("create capsule group %s: %w: %s", name, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func validateVolumeSpec(spec VolumeSpec) error {
	if !validVolumeName(spec.Name) {
		return fmt.Errorf("volume.name must be a bounded volume name")
	}
	if spec.MountPath != VolumeMountPath(spec.Name) {
		return fmt.Errorf("volume.mountPath must be %s", VolumeMountPath(spec.Name))
	}
	if _, ok := dataClasses[spec.Class]; !ok {
		return fmt.Errorf("volume.class must be a known data class")
	}
	if spec.Access != "read-only" && spec.Access != "read-write" {
		return fmt.Errorf("volume.access must be read-only or read-write")
	}
	if spec.Persistence != "persistent" {
		return fmt.Errorf("volume.persistence must be persistent")
	}
	if spec.SizeMiB <= 0 {
		return fmt.Errorf("volume.sizeMiB must be positive")
	}
	return nil
}

func validateCapsulePathID(value string) error {
	if len(value) == 0 ||
		len(value) > 255 ||
		value != strings.TrimSpace(value) ||
		value == "." ||
		value == ".." ||
		strings.ContainsAny(value, `/\`) ||
		controlCharacter.MatchString(value) ||
		!capsulePathIDPattern.MatchString(value) {
		return fmt.Errorf("capsule id must be safe as a volume path component")
	}
	return nil
}

func validVolumeName(value string) bool {
	return value != "." &&
		value != ".." &&
		value == strings.TrimSpace(value) &&
		!controlCharacter.MatchString(value) &&
		volumeNamePattern.MatchString(value)
}

func cleanAbsolutePath(value string, field string) (string, error) {
	if value == "" || !path.IsAbs(value) {
		return "", fmt.Errorf("%s must be absolute", field)
	}
	cleaned := path.Clean(value)
	if cleaned != value {
		return "", fmt.Errorf("%s must be canonical", field)
	}
	return cleaned, nil
}
