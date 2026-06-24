package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/vita/agent/capabilities/storage"
)

type recoveryShareFile struct {
	path      string
	ref       storage.RecoveryKeyRef
	threshold int
	total     int
	index     byte
	fragment  []byte
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "recovery-combine: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 || args[0] != "combine" {
		return errors.New("usage: recovery-combine combine --share-dir <dir> [--auto | -- <share>...]")
	}

	shareDir := ""
	auto := false
	var presentedPaths []string
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "--share-dir":
			i++
			if i >= len(args) || args[i] == "" {
				return errors.New("--share-dir requires a value")
			}
			shareDir = args[i]
		case "--auto":
			auto = true
		case "--":
			presentedPaths = append(presentedPaths, args[i+1:]...)
			i = len(args)
		default:
			return fmt.Errorf("unknown argument %q", args[i])
		}
	}
	if shareDir == "" {
		return errors.New("--share-dir is required")
	}

	enrolled, quorum, err := loadRecoveryShareDir(shareDir)
	if err != nil {
		return err
	}

	var presented []storage.TrustedRecoveryShare
	if auto {
		if len(presentedPaths) != 0 {
			return errors.New("--auto cannot be combined with explicit presented shares")
		}
		if len(enrolled) < quorum.Threshold {
			return fmt.Errorf("enrolled recovery shares are below threshold %d", quorum.Threshold)
		}
		for _, share := range enrolled[:quorum.Threshold] {
			presented = append(presented, share.trustedShare())
		}
	} else {
		if len(presentedPaths) == 0 {
			return errors.New("no recovery shares presented")
		}
		for _, path := range presentedPaths {
			share, err := loadRecoveryShareFile(path)
			if err != nil {
				return err
			}
			presented = append(presented, share.trustedShare())
		}
	}

	passphrase, err := storage.CombineRecoveryPassphrase(quorum, presented)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(passphrase)
	return err
}

func loadRecoveryShareDir(dir string) ([]recoveryShareFile, storage.RecoveryQuorum, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "share-*.env"))
	if err != nil {
		return nil, storage.RecoveryQuorum{}, err
	}
	sort.Strings(matches)
	if len(matches) == 0 {
		return nil, storage.RecoveryQuorum{}, fmt.Errorf("no enrolled recovery shares in %s", dir)
	}

	shares := make([]recoveryShareFile, 0, len(matches))
	var threshold int
	var total int
	for _, path := range matches {
		share, err := loadRecoveryShareFile(path)
		if err != nil {
			return nil, storage.RecoveryQuorum{}, err
		}
		if threshold == 0 {
			threshold = share.threshold
			total = share.total
		} else if share.threshold != threshold || share.total != total {
			return nil, storage.RecoveryQuorum{}, fmt.Errorf("mixed recovery quorum metadata in %s", path)
		}
		shares = append(shares, share)
	}
	if threshold < 1 || total < threshold {
		return nil, storage.RecoveryQuorum{}, errors.New("invalid recovery quorum threshold/total")
	}
	if len(shares) < threshold {
		return nil, storage.RecoveryQuorum{}, fmt.Errorf("enrolled recovery shares are below threshold %d", threshold)
	}
	if len(shares) > total {
		return nil, storage.RecoveryQuorum{}, fmt.Errorf("enrolled recovery shares exceed declared total %d", total)
	}

	refs := make([]storage.RecoveryKeyRef, len(shares))
	for i, share := range shares {
		refs[i] = share.ref
	}
	quorum := storage.RecoveryQuorum{
		Threshold: threshold,
		Shares:    refs,
	}
	if err := storage.ValidateRecoveryAttempt(storage.RecoveryAttempt{
		Quorum:             quorum,
		PresentedShareRefs: refs[:threshold],
	}); err != nil {
		return nil, storage.RecoveryQuorum{}, err
	}
	return shares, quorum, nil
}

func loadRecoveryShareFile(path string) (recoveryShareFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return recoveryShareFile{}, err
	}
	fields, err := parseRecoveryShareEnv(raw)
	if err != nil {
		return recoveryShareFile{}, fmt.Errorf("%s: %w", path, err)
	}

	if fields["VITA_RECOVERY_SHARE_VERSION"] != "1" {
		return recoveryShareFile{}, fmt.Errorf("%s: unsupported recovery share version", path)
	}
	if fields["VITA_RECOVERY_TEST_MATERIAL"] != "1" {
		return recoveryShareFile{}, fmt.Errorf("%s: recovery share is not marked as TEST material", path)
	}

	threshold, err := parsePositiveInt(fields, "threshold")
	if err != nil {
		return recoveryShareFile{}, fmt.Errorf("%s: %w", path, err)
	}
	total, err := parsePositiveInt(fields, "total")
	if err != nil {
		return recoveryShareFile{}, fmt.Errorf("%s: %w", path, err)
	}
	index, err := parseShareIndex(fields, "x")
	if err != nil {
		return recoveryShareFile{}, fmt.Errorf("%s: %w", path, err)
	}
	fragment, err := base64.StdEncoding.DecodeString(fields["fragmentBase64"])
	if err != nil || len(fragment) == 0 {
		return recoveryShareFile{}, fmt.Errorf("%s: invalid fragmentBase64", path)
	}

	return recoveryShareFile{
		path: path,
		ref: storage.RecoveryKeyRef{
			ID:          fields["id"],
			Handle:      fields["handle"],
			KeyStoreRef: stringPtr(fields["keyStoreRef"]),
		},
		threshold: threshold,
		total:     total,
		index:     index,
		fragment:  fragment,
	}, nil
}

func parseRecoveryShareEnv(raw []byte) (map[string]string, error) {
	fields := make(map[string]string)
	allowed := map[string]struct{}{
		"VITA_RECOVERY_SHARE_VERSION": {},
		"VITA_RECOVERY_TEST_MATERIAL": {},
		"id":                          {},
		"handle":                      {},
		"keyStoreRef":                 {},
		"threshold":                   {},
		"total":                       {},
		"x":                           {},
		"fragmentBase64":              {},
	}

	for lineNo, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d is malformed", lineNo+1)
		}
		if _, ok := allowed[key]; !ok {
			return nil, fmt.Errorf("line %d has unknown field %q", lineNo+1, key)
		}
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("line %d duplicates field %q", lineNo+1, key)
		}
		fields[key] = value
	}

	for key := range allowed {
		if fields[key] == "" {
			return nil, fmt.Errorf("missing required field %q", key)
		}
	}
	return fields, nil
}

func parsePositiveInt(fields map[string]string, key string) (int, error) {
	value, err := strconv.Atoi(fields[key])
	if err != nil || value < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
}

func parseShareIndex(fields map[string]string, key string) (byte, error) {
	value, err := parsePositiveInt(fields, key)
	if err != nil {
		return 0, err
	}
	if value > 255 {
		return 0, fmt.Errorf("%s must be <= 255", key)
	}
	return byte(value), nil
}

func (s recoveryShareFile) trustedShare() storage.TrustedRecoveryShare {
	return storage.TrustedRecoveryShare{
		Ref:      s.ref,
		Index:    s.index,
		Fragment: cloneBytes(s.fragment),
	}
}

func stringPtr(value string) *string {
	out := value
	return &out
}

func cloneBytes(in []byte) []byte {
	out := make([]byte, len(in))
	copy(out, in)
	return out
}
