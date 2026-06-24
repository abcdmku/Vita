package export

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"

	"github.com/vita/agent/internal/jsonsafe"
)

type Operation string

const OperationVerify Operation = "verify"

type VerifyRequest struct {
	Op           Operation `json:"op"`
	Grant        string    `json:"grant"`
	ManifestPath string    `json:"manifestPath"`
}

func (r *VerifyRequest) UnmarshalJSON(raw []byte) error {
	type verifyRequestJSON VerifyRequest
	var decoded verifyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	*r = VerifyRequest(decoded)
	return nil
}

func (r VerifyRequest) Validate() error {
	if r.Op == "" {
		return bundleError("invalid_request", "op is required")
	}
	if r.Op != OperationVerify {
		return bundleError("unknown_op", "unknown export op")
	}
	if r.Grant == "" {
		return bundleError("invalid_request", "grant is required")
	}
	if err := validateBundlePath(r.ManifestPath); err != nil {
		return err
	}
	if containsInlineSecretMaterial(r.Grant) || containsInlineSecretMaterial(r.ManifestPath) {
		return bundleError("inline_secret_metadata", "export request metadata contains inline secret material")
	}
	return nil
}

type VerifyResult struct {
	Entries    int    `json:"entries"`
	Bytes      int64  `json:"bytes"`
	RootDigest string `json:"rootDigest"`
	Verified   bool   `json:"verified"`
}

type LookupFunc func(path string) ([]byte, error)

func VerifyBundle(manifestBytes []byte, lookup LookupFunc) (VerifyResult, error) {
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		return VerifyResult{}, err
	}
	if lookup == nil {
		return VerifyResult{}, bundleError("integrity_mismatch", "export content lookup is unavailable")
	}

	rootDigest, err := RootDigest(manifest.Entries)
	if err != nil {
		return VerifyResult{}, err
	}
	if rootDigest != manifest.RootDigest {
		return VerifyResult{}, bundleError("integrity_mismatch", "export rootDigest does not match entries")
	}

	var total int64
	for _, entry := range manifest.Entries {
		content, err := lookup(entry.Path)
		if err != nil {
			return VerifyResult{}, bundleError("integrity_mismatch", "export entry content is unavailable")
		}
		if int64(len(content)) != entry.Bytes {
			return VerifyResult{}, bundleError("integrity_mismatch", "export entry size does not match content")
		}
		if int64(len(content)) > MaxEntryBytes {
			return VerifyResult{}, bundleError("size_limit", "export entry exceeds size cap")
		}
		if total > MaxBundleBytes-int64(len(content)) {
			return VerifyResult{}, bundleError("size_limit", "export bundle exceeds total size cap")
		}
		total += int64(len(content))

		claimed, err := decodeSRI(entry.Integrity)
		if err != nil {
			return VerifyResult{}, err
		}
		computed := sha256.Sum256(content)
		if subtle.ConstantTimeCompare(claimed, computed[:]) != 1 {
			return VerifyResult{}, bundleError("integrity_mismatch", "export entry integrity does not match content")
		}
	}

	return VerifyResult{
		Entries:    len(manifest.Entries),
		Bytes:      total,
		RootDigest: manifest.RootDigest,
		Verified:   true,
	}, nil
}

func RootDigest(entries []Entry) (string, error) {
	canonicalEntries, err := CanonicalEntriesJSON(entries)
	if err != nil {
		return "", fmt.Errorf("canonicalize export entries: %w", err)
	}
	sum := sha256.Sum256(canonicalEntries)
	return sriFromDigest(sum[:]), nil
}

func SHA256Integrity(content []byte) string {
	sum := sha256.Sum256(content)
	return sriFromDigest(sum[:])
}

func DecodeVerifyRequest(raw []byte) (VerifyRequest, error) {
	var request VerifyRequest
	if err := jsonsafe.DecodeStrict(raw, &request); err != nil {
		return VerifyRequest{}, err
	}
	if err := request.Validate(); err != nil {
		return VerifyRequest{}, err
	}
	return request, nil
}

func MarshalVerifyRequest(request VerifyRequest) ([]byte, error) {
	return json.Marshal(request)
}
