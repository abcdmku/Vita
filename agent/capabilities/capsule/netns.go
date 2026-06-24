package capsule

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"runtime"
	"strings"

	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/internal/sysdeps"
)

const (
	defaultNetnsRoot = "/run/vita-agent/netns"

	capsuleNetnsPathBase = "/proc/self/ns/net"
	capsuleNetnsFileName = "netns"
	capsuleNetnsDirMode  = 0o700
	capsuleNetnsFileMode = 0o600
	capsuleNetnsProofMax = 4096

	capsuleNetnsLoopbackOK         = "OK"
	capsuleNetnsExternalFail       = "FAIL"
	capsuleNetnsIsolationEnforced  = "enforced"
	capsuleNetnsMeasuredStatusOK   = "OK"
	capsuleNetnsMeasuredStatusFail = "FAIL"
)

type capsuleNetns struct {
	Name      string
	Path      string
	Dir       string
	ProofPath string
}

type capsuleNetnsCheck struct {
	Interfaces []string
	Isolation  string
	Status     string
}

type capsuleNetnsProof struct {
	ID       string `json:"id"`
	Loopback string `json:"loopback"`
	External string `json:"external"`
	Status   string `json:"status"`
}

type capsuleNetnsManager interface {
	Create(context.Context, capsuleNetns) (capsuleNetns, error)
	Check(context.Context, capsuleNetns) (capsuleNetnsCheck, error)
	Teardown(context.Context, capsuleNetns) error
}

type defaultCapsuleNetnsManager struct {
	root string
}

func newDefaultCapsuleNetnsManager() capsuleNetnsManager {
	return defaultCapsuleNetnsManager{root: defaultNetnsRoot}
}

func capsuleNetnsForUnit(unitName string, proofPath string) capsuleNetns {
	name := capsuleNetnsName(unitName)
	dir := path.Join(defaultNetnsRoot, name)
	return capsuleNetns{
		Name:      name,
		Path:      path.Join(dir, capsuleNetnsFileName),
		Dir:       dir,
		ProofPath: proofPath,
	}
}

func capsuleNetnsName(unitName string) string {
	name := strings.TrimSuffix(unitName, ".service")
	name = unsafeRuntimeDirRune.ReplaceAllString(name, "-")
	name = strings.Trim(name, ".-")
	if name == "" {
		return "vita-capsule"
	}
	return name
}

func (m defaultCapsuleNetnsManager) Create(ctx context.Context, netns capsuleNetns) (capsuleNetns, error) {
	if err := ctx.Err(); err != nil {
		return capsuleNetns{}, err
	}
	if err := validateCapsuleNetns(netns); err != nil {
		return capsuleNetns{}, err
	}

	root := m.root
	if root == "" {
		root = defaultNetnsRoot
	}
	dir := path.Join(root, netns.Name)
	netns.Dir = dir
	netns.Path = path.Join(dir, capsuleNetnsFileName)

	if err := os.MkdirAll(root, capsuleNetnsDirMode); err != nil {
		return capsuleNetns{}, fmt.Errorf("create capsule netns root: %w", err)
	}
	if err := os.Chmod(root, capsuleNetnsDirMode); err != nil {
		return capsuleNetns{}, fmt.Errorf("secure capsule netns root: %w", err)
	}
	if err := os.Mkdir(dir, capsuleNetnsDirMode); err != nil {
		return capsuleNetns{}, fmt.Errorf("create capsule netns dir: %w", err)
	}
	createdDir := true
	committed := false
	defer func() {
		if !committed && createdDir {
			_ = os.RemoveAll(dir)
		}
	}()

	file, err := os.OpenFile(netns.Path, os.O_RDWR|os.O_CREATE|os.O_EXCL, capsuleNetnsFileMode)
	if err != nil {
		return capsuleNetns{}, fmt.Errorf("create capsule netns bind target: %w", err)
	}
	if closeErr := file.Close(); closeErr != nil {
		return capsuleNetns{}, fmt.Errorf("close capsule netns bind target: %w", closeErr)
	}
	createdTarget := true
	mounted := false
	defer func() {
		if !committed && createdTarget {
			if mounted {
				_ = sysdeps.UnmountDetach(netns.Path)
			}
			_ = os.Remove(netns.Path)
		}
	}()

	prior, err := os.Open(capsuleNetnsPathBase)
	if err != nil {
		return capsuleNetns{}, fmt.Errorf("open current network namespace: %w", err)
	}
	defer prior.Close()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	restored := false
	restore := func() error {
		if restored {
			return nil
		}
		if err := sysdeps.SetNetworkNamespace(int(prior.Fd())); err != nil {
			return fmt.Errorf("restore agent network namespace: %w", err)
		}
		restored = true
		return nil
	}
	defer func() {
		_ = restore()
	}()

	if err := sysdeps.UnshareNetworkNamespace(); err != nil {
		return capsuleNetns{}, fmt.Errorf("create capsule network namespace: %w", err)
	}
	if err := sysdeps.SetLoopbackUp(); err != nil {
		return capsuleNetns{}, errors.Join(
			fmt.Errorf("bring capsule loopback up: %w", err),
			restore(),
		)
	}
	if err := sysdeps.BindMount(capsuleNetnsPathBase, netns.Path); err != nil {
		return capsuleNetns{}, errors.Join(
			fmt.Errorf("pin capsule network namespace: %w", err),
			restore(),
		)
	}
	mounted = true
	if err := restore(); err != nil {
		_ = sysdeps.UnmountDetach(netns.Path)
		mounted = false
		return capsuleNetns{}, err
	}

	committed = true
	return netns, nil
}

func (m defaultCapsuleNetnsManager) Check(ctx context.Context, netns capsuleNetns) (capsuleNetnsCheck, error) {
	if err := ctx.Err(); err != nil {
		return capsuleNetnsCheck{}, err
	}
	if err := validateCapsuleNetns(netns); err != nil {
		return capsuleNetnsCheck{}, err
	}

	var interfaces []net.Interface
	err := withCapsuleNetns(netns.Path, func() error {
		var err error
		interfaces, err = net.Interfaces()
		return err
	})
	if err != nil {
		return capsuleNetnsCheck{}, fmt.Errorf("inspect capsule network namespace: %w", err)
	}

	names := make([]string, 0, len(interfaces))
	onlyLoopback := len(interfaces) == 1
	for _, iface := range interfaces {
		names = append(names, iface.Name)
		if iface.Name != "lo" || iface.Flags&net.FlagLoopback == 0 || iface.Flags&net.FlagUp == 0 {
			onlyLoopback = false
		}
	}
	if !onlyLoopback {
		return capsuleNetnsCheck{
			Interfaces: names,
			Isolation:  "not_enforced",
			Status:     capsuleNetnsMeasuredStatusFail,
		}, fmt.Errorf("capsule network namespace exposes non-loopback interfaces: %s", strings.Join(names, ","))
	}
	return capsuleNetnsCheck{
		Interfaces: names,
		Isolation:  capsuleNetnsIsolationEnforced,
		Status:     capsuleNetnsMeasuredStatusOK,
	}, nil
}

func (m defaultCapsuleNetnsManager) Teardown(ctx context.Context, netns capsuleNetns) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateCapsuleNetns(netns); err != nil {
		return err
	}

	var teardownErr error
	if err := sysdeps.UnmountDetach(netns.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		teardownErr = errors.Join(teardownErr, fmt.Errorf("unmount capsule netns: %w", err))
	}
	if err := os.Remove(netns.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		teardownErr = errors.Join(teardownErr, fmt.Errorf("remove capsule netns bind target: %w", err))
	}
	if err := os.Remove(netns.Dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		teardownErr = errors.Join(teardownErr, fmt.Errorf("remove capsule netns dir: %w", err))
	}
	return teardownErr
}

func withCapsuleNetns(netnsPath string, fn func() error) (err error) {
	prior, err := os.Open(capsuleNetnsPathBase)
	if err != nil {
		return fmt.Errorf("open current network namespace: %w", err)
	}
	defer prior.Close()

	target, err := os.Open(netnsPath)
	if err != nil {
		return fmt.Errorf("open capsule network namespace: %w", err)
	}
	defer target.Close()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := sysdeps.SetNetworkNamespace(int(target.Fd())); err != nil {
		return fmt.Errorf("enter capsule network namespace: %w", err)
	}
	defer func() {
		if restoreErr := sysdeps.SetNetworkNamespace(int(prior.Fd())); restoreErr != nil {
			err = errors.Join(err, fmt.Errorf("restore agent network namespace: %w", restoreErr))
		}
	}()

	return fn()
}

func validateCapsuleNetns(netns capsuleNetns) error {
	if netns.Name == "" || netns.Name != capsuleNetnsName(netns.Name) {
		return &ExecuteInvalidRequestError{Reason: "capsule netns name is unsafe"}
	}
	if netns.Path == "" || !strings.HasPrefix(netns.Path, defaultNetnsRoot+"/") || path.Base(netns.Path) != capsuleNetnsFileName {
		return &ExecuteInvalidRequestError{Reason: "capsule netns path is unsafe"}
	}
	if netns.Dir == "" || !strings.HasPrefix(netns.Dir, defaultNetnsRoot+"/") || path.Clean(netns.Dir) == defaultNetnsRoot {
		return &ExecuteInvalidRequestError{Reason: "capsule netns dir is unsafe"}
	}
	return nil
}

func readCapsuleNetnsProof(ctx context.Context, proofPath string) (capsuleNetnsProof, bool) {
	if proofPath == "" {
		return capsuleNetnsProof{}, false
	}
	if err := ctx.Err(); err != nil {
		return capsuleNetnsProof{}, false
	}

	file, err := os.Open(proofPath)
	if err != nil {
		return capsuleNetnsProof{}, false
	}
	defer file.Close()

	limited := io.LimitReader(file, capsuleNetnsProofMax+1)
	raw, err := io.ReadAll(limited)
	if err != nil || len(raw) > capsuleNetnsProofMax || len(bytes.TrimSpace(raw)) == 0 {
		return capsuleNetnsProof{}, false
	}
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return capsuleNetnsProof{}, false
	}

	var proof capsuleNetnsProof
	if err := json.Unmarshal(raw, &proof); err != nil {
		return capsuleNetnsProof{}, false
	}
	return proof, true
}

func measuredCapsuleNetnsProof(proof capsuleNetnsProof, id string) bool {
	return proof.ID == id &&
		proof.Loopback == capsuleNetnsLoopbackOK &&
		proof.External == capsuleNetnsExternalFail &&
		proof.Status == capsuleNetnsMeasuredStatusOK
}
