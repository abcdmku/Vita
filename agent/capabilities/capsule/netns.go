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

	capsuleNetnsPathBase = "/proc/thread-self/ns/net"
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
	Private   bool
	Egress    *capsuleEgressConfig
}

type capsuleNetnsCheck struct {
	Interfaces []string
	Isolation  string
	Status     string
	Egress     *capsuleEgressCheck
}

type capsuleNetnsProof struct {
	ID       string              `json:"id"`
	Loopback string              `json:"loopback"`
	External string              `json:"external"`
	Egress   *capsuleEgressProof `json:"egress,omitempty"`
	Status   string              `json:"status"`
}

type capsuleNetnsManager interface {
	Create(context.Context, capsuleNetns) (capsuleNetns, error)
	Check(context.Context, capsuleNetns) (capsuleNetnsCheck, error)
	Teardown(context.Context, capsuleNetns) error
}

type defaultCapsuleNetnsManager struct {
	root       string
	interfaces func() ([]net.Interface, error)
	egress     capsuleEgressConfigurator
}

func newDefaultCapsuleNetnsManager() capsuleNetnsManager {
	return defaultCapsuleNetnsManager{root: defaultNetnsRoot, egress: defaultCapsuleEgressConfigurator{}}
}

func capsuleNetnsForUnit(unitName string, proofPath string) capsuleNetns {
	name := capsuleNetnsName(unitName)
	return capsuleNetns{
		Name:      name,
		ProofPath: proofPath,
		Private:   true,
	}
}

func capsuleNetnsForNetwork(unitName string, proofPath string, policy *ExecutionNetwork) (capsuleNetns, error) {
	netns := capsuleNetnsForUnit(unitName, proofPath)
	egress, err := capsuleEgressConfigForUnit(unitName, policy)
	if err != nil {
		return capsuleNetns{}, err
	}
	if egress != nil {
		netns.Private = false
		netns.Egress = egress
		setCapsuleNetnsPaths(defaultNetnsRoot, &netns)
	}
	return netns, nil
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
	if netns.Private {
		if err := validateCapsuleNetns(netns); err != nil {
			return capsuleNetns{}, err
		}
		return netns, nil
	}
	if netns.Name == "" || netns.Name != capsuleNetnsName(netns.Name) {
		return capsuleNetns{}, &ExecuteInvalidRequestError{Reason: "capsule netns name is unsafe"}
	}

	root := m.root
	if root == "" {
		root = defaultNetnsRoot
	}
	if netns.Dir != "" || netns.Path != "" {
		if err := validateCapsuleNetns(netns); err != nil {
			return capsuleNetns{}, err
		}
	}
	setCapsuleNetnsPaths(root, &netns)
	if err := validateCapsuleNetns(netns); err != nil {
		return capsuleNetns{}, err
	}

	if err := os.MkdirAll(root, capsuleNetnsDirMode); err != nil {
		return capsuleNetns{}, capsuleNetnsStepError("mkdir_root", err)
	}
	if err := os.Chmod(root, capsuleNetnsDirMode); err != nil {
		return capsuleNetns{}, capsuleNetnsStepError("chmod_root", err)
	}
	if err := sysdeps.EnsureSharedBindMount(root); err != nil {
		return capsuleNetns{}, capsuleNetnsStepError("root_shared", err)
	}
	if err := os.Mkdir(netns.Dir, capsuleNetnsDirMode); err != nil {
		return capsuleNetns{}, capsuleNetnsStepError("mkdir_netns", err)
	}
	createdDir := true
	committed := false
	defer func() {
		if !committed && createdDir {
			_ = os.RemoveAll(netns.Dir)
		}
	}()

	file, err := os.OpenFile(netns.Path, os.O_RDWR|os.O_CREATE|os.O_EXCL, capsuleNetnsFileMode)
	if err != nil {
		return capsuleNetns{}, capsuleNetnsStepError("target_create", err)
	}
	if closeErr := file.Close(); closeErr != nil {
		return capsuleNetns{}, capsuleNetnsStepError("target_close", closeErr)
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
		return capsuleNetns{}, capsuleNetnsStepError("open_current", err)
	}
	defer prior.Close()

	runtime.LockOSThread()
	unlockThread := true
	defer func() {
		if unlockThread {
			runtime.UnlockOSThread()
		}
	}()

	restored := false
	restore := func() error {
		if restored {
			return nil
		}
		if err := sysdeps.SetNetworkNamespace(int(prior.Fd())); err != nil {
			return capsuleNetnsStepError("restore", err)
		}
		restored = true
		unlockThread = true
		return nil
	}
	defer func() {
		_ = restore()
	}()

	if err := sysdeps.UnshareNetworkNamespace(); err != nil {
		return capsuleNetns{}, capsuleNetnsStepError("unshare", err)
	}
	restored = false
	unlockThread = false
	if err := sysdeps.SetLoopbackUp(); err != nil {
		return capsuleNetns{}, errors.Join(
			capsuleNetnsStepError("check_lo", err),
			restore(),
		)
	}
	if err := sysdeps.BindMount(capsuleNetnsPathBase, netns.Path); err != nil {
		return capsuleNetns{}, errors.Join(
			capsuleNetnsStepError("bindmount", err),
			restore(),
		)
	}
	mounted = true
	if err := restore(); err != nil {
		_ = sysdeps.UnmountDetach(netns.Path)
		mounted = false
		return capsuleNetns{}, err
	}
	if netns.Egress != nil {
		egress := m.egress
		if egress == nil {
			egress = defaultCapsuleEgressConfigurator{}
		}
		if err := egress.Setup(ctx, &netns); err != nil {
			_ = sysdeps.UnmountDetach(netns.Path)
			mounted = false
			return capsuleNetns{}, err
		}
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
	if netns.Private && netns.Path == "" {
		return capsuleNetnsCheck{}, capsuleNetnsStepError("join_unit", errors.New("missing systemd unit network namespace path"))
	}

	var interfaces []net.Interface
	var err error
	if m.interfaces != nil {
		interfaces, err = m.interfaces()
	} else {
		err = withCapsuleNetns(netns.Path, func() error {
			var listErr error
			interfaces, listErr = net.Interfaces()
			return listErr
		})
	}
	if err != nil {
		var stepErr *capsuleNetnsStepFailure
		if errors.As(err, &stepErr) {
			return capsuleNetnsCheck{}, err
		}
		return capsuleNetnsCheck{}, capsuleNetnsStepError("check_lo", err)
	}

	names := make([]string, 0, len(interfaces))
	onlyLoopback := len(interfaces) == 1
	for _, iface := range interfaces {
		names = append(names, iface.Name)
		if iface.Name != "lo" || iface.Flags&net.FlagLoopback == 0 || iface.Flags&net.FlagUp == 0 {
			onlyLoopback = false
		}
	}
	if netns.Egress != nil {
		egress := m.egress
		if egress == nil {
			egress = defaultCapsuleEgressConfigurator{}
		}
		egressCheck, err := egress.Check(ctx, netns, interfaces)
		if err != nil {
			return capsuleNetnsCheck{
				Interfaces: names,
				Isolation:  "not_enforced",
				Status:     capsuleNetnsMeasuredStatusFail,
			}, err
		}
		return capsuleNetnsCheck{
			Interfaces: names,
			Isolation:  capsuleNetnsIsolationEnforced,
			Status:     capsuleNetnsMeasuredStatusOK,
			Egress:     &egressCheck,
		}, nil
	}
	if !onlyLoopback {
		return capsuleNetnsCheck{
			Interfaces: names,
			Isolation:  "not_enforced",
			Status:     capsuleNetnsMeasuredStatusFail,
		}, capsuleNetnsStepError("check_lo", fmt.Errorf("capsule network namespace exposes non-loopback interfaces: %s", strings.Join(names, ",")))
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
	if netns.Private {
		return nil
	}

	var teardownErr error
	if netns.Egress != nil {
		egress := m.egress
		if egress == nil {
			egress = defaultCapsuleEgressConfigurator{}
		}
		if err := egress.Teardown(ctx, netns); err != nil {
			teardownErr = errors.Join(teardownErr, err)
		}
	}
	if err := sysdeps.UnmountDetach(netns.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		teardownErr = errors.Join(teardownErr, capsuleNetnsStepError("unmount", err))
	}
	if err := os.Remove(netns.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		teardownErr = errors.Join(teardownErr, capsuleNetnsStepError("target_remove", err))
	}
	if err := os.Remove(netns.Dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		teardownErr = errors.Join(teardownErr, capsuleNetnsStepError("dir_remove", err))
	}
	return teardownErr
}

func withCapsuleNetns(netnsPath string, fn func() error) (err error) {
	prior, err := os.Open(capsuleNetnsPathBase)
	if err != nil {
		return capsuleNetnsStepError("open_current", err)
	}
	defer prior.Close()

	target, err := os.Open(netnsPath)
	if err != nil {
		return capsuleNetnsStepError("join_unit", err)
	}
	defer target.Close()

	runtime.LockOSThread()
	unlockThread := true
	defer func() {
		if unlockThread {
			runtime.UnlockOSThread()
		}
	}()

	if err := sysdeps.SetNetworkNamespace(int(target.Fd())); err != nil {
		return capsuleNetnsStepError("join_unit", err)
	}
	unlockThread = false
	defer func() {
		if restoreErr := sysdeps.SetNetworkNamespace(int(prior.Fd())); restoreErr != nil {
			err = errors.Join(err, capsuleNetnsStepError("restore", restoreErr))
			return
		}
		unlockThread = true
	}()

	return fn()
}

func validateCapsuleNetns(netns capsuleNetns) error {
	if netns.Name == "" || netns.Name != capsuleNetnsName(netns.Name) {
		return &ExecuteInvalidRequestError{Reason: "capsule netns name is unsafe"}
	}
	if netns.Private {
		if netns.Egress != nil {
			return &ExecuteInvalidRequestError{Reason: "capsule private netns cannot carry egress"}
		}
		if netns.Dir != "" {
			return &ExecuteInvalidRequestError{Reason: "capsule private netns dir must be empty"}
		}
		if netns.Path != "" && !validProcNetnsPath(netns.Path) {
			return &ExecuteInvalidRequestError{Reason: "capsule private netns path is unsafe"}
		}
		return nil
	}
	if netns.Dir != path.Join(defaultNetnsRoot, netns.Name) {
		return &ExecuteInvalidRequestError{Reason: "capsule netns dir is unsafe"}
	}
	if netns.Path != path.Join(netns.Dir, capsuleNetnsFileName) {
		return &ExecuteInvalidRequestError{Reason: "capsule netns path is unsafe"}
	}
	if netns.Egress != nil {
		if err := validateCapsuleEgressConfig(*netns.Egress); err != nil {
			return err
		}
	}
	return nil
}

func setCapsuleNetnsPaths(root string, netns *capsuleNetns) {
	if root == "" {
		root = defaultNetnsRoot
	}
	dir := path.Join(root, netns.Name)
	netns.Dir = dir
	netns.Path = path.Join(dir, capsuleNetnsFileName)
}

func validProcNetnsPath(value string) bool {
	const prefix = "/proc/"
	const suffix = "/ns/net"
	if value == "" || path.Clean(value) != value || !strings.HasPrefix(value, prefix) || !strings.HasSuffix(value, suffix) {
		return false
	}
	pid := strings.TrimSuffix(strings.TrimPrefix(value, prefix), suffix)
	if pid == "" {
		return false
	}
	for _, r := range pid {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

type capsuleNetnsStepFailure struct {
	Step string
	Err  error
}

func (e *capsuleNetnsStepFailure) Error() string {
	if e == nil {
		return "capsule netns step failed"
	}
	if e.Err == nil {
		return e.Step
	}
	return e.Step + ": " + e.Err.Error()
}

func (e *capsuleNetnsStepFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func capsuleNetnsStepError(step string, err error) error {
	if err == nil {
		return nil
	}
	return &capsuleNetnsStepFailure{Step: step, Err: err}
}

func capsuleNetnsFailureReason(err error) string {
	var stepErr *capsuleNetnsStepFailure
	if errors.As(err, &stepErr) && stepErr != nil {
		reason := stepErr.Step
		if errno := sysdeps.ErrnoCode(stepErr.Err); errno != "" {
			reason += "_" + errno
		}
		return "capsule_netns_failed:" + reason
	}
	return "capsule_netns_failed:unknown"
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
