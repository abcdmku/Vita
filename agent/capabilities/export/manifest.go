package export

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	filecap "github.com/vita/agent/capabilities/files"
	"github.com/vita/agent/internal/jsonsafe"
)

const (
	ManifestFormatVersion = 1
	ManifestFilename      = "export-manifest.json"

	MaxManifestBytes = filecap.MaxRequestBodyBytes
	MaxEntryBytes    = filecap.MaxFileBytes
	MaxBundleBytes   = 64 * 1024 * 1024
	MaxEntries       = 8192
)

type EntryKind string

const (
	EntryKindFile   EntryKind = "file"
	EntryKindConfig EntryKind = "config"
	EntryKindPDS    EntryKind = "pds"
)

type Manifest struct {
	FormatVersion int     `json:"formatVersion"`
	CreatedMarker *string `json:"createdMarker,omitempty"`
	Entries       []Entry `json:"entries"`
	RootDigest    string  `json:"rootDigest"`
}

type Entry struct {
	Path      string    `json:"path"`
	Kind      EntryKind `json:"kind"`
	Bytes     int64     `json:"bytes"`
	Integrity string    `json:"integrity"`
}

type BundleError struct {
	Code    string
	Message string
}

func (e *BundleError) Error() string {
	return e.Message
}

func (e *BundleError) HTTPStatus() int {
	if e == nil {
		return 500
	}
	switch e.Code {
	case "size_limit":
		return 413
	default:
		return 400
	}
}

func ParseManifest(raw []byte) (Manifest, error) {
	if len(raw) > int(MaxManifestBytes) {
		return Manifest{}, bundleError("size_limit", "export manifest exceeds size cap")
	}
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return Manifest{}, bundleError("invalid_manifest", err.Error())
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return Manifest{}, bundleError("invalid_manifest", err.Error())
	}
	if err := rejectUnknownFields(fields, manifestFields); err != nil {
		return Manifest{}, err
	}

	formatVersion, err := requiredIntField(fields, "formatVersion")
	if err != nil {
		return Manifest{}, bundleError("invalid_manifest", err.Error())
	}
	createdMarker, err := optionalStringField(fields, "createdMarker")
	if err != nil {
		return Manifest{}, err
	}
	entries, err := requiredEntriesField(fields, "entries")
	if err != nil {
		return Manifest{}, err
	}
	rootDigest, err := requiredStringField(fields, "rootDigest")
	if err != nil {
		return Manifest{}, bundleError("invalid_manifest", err.Error())
	}

	manifest := Manifest{
		FormatVersion: formatVersion,
		CreatedMarker: createdMarker,
		Entries:       entries,
		RootDigest:    rootDigest,
	}
	if err := ValidateManifest(manifest); err != nil {
		return Manifest{}, err
	}
	return cloneManifest(manifest), nil
}

func ValidateManifest(manifest Manifest) error {
	if manifest.FormatVersion != ManifestFormatVersion {
		return bundleError("invalid_manifest", "unsupported export manifest formatVersion")
	}
	if manifest.CreatedMarker != nil {
		if *manifest.CreatedMarker == "" {
			return bundleError("invalid_manifest", "createdMarker must be non-empty when present")
		}
		if containsInlineSecretMaterial(*manifest.CreatedMarker) {
			return bundleError("inline_secret_metadata", "export metadata contains inline secret material")
		}
	}
	if manifest.Entries == nil {
		return bundleError("invalid_manifest", "entries is required")
	}
	if len(manifest.Entries) > MaxEntries {
		return bundleError("size_limit", "export manifest exceeds entry cap")
	}
	if !isValidSHA256SRI(manifest.RootDigest) {
		return bundleError("invalid_manifest", "rootDigest must be sha256 SRI")
	}

	var total int64
	for i, entry := range manifest.Entries {
		if err := validateEntry(entry); err != nil {
			return err
		}
		if total > MaxBundleBytes-entry.Bytes {
			return bundleError("size_limit", "export bundle exceeds total size cap")
		}
		total += entry.Bytes
		if i > 0 {
			prev := manifest.Entries[i-1]
			// Path uniqueness is the manifest invariant: the bundle content lookup is
			// keyed by path ALONE (see export.go VerifyBundle), so two entries sharing a
			// path — even with different kinds — would let one output path be claimed
			// twice. Reject duplicate paths regardless of kind (fail-closed); a non-zero
			// compareEntries with an equal path means same path/different kind, which the
			// kind-aware sort order would otherwise wave through.
			if prev.Path == entry.Path {
				return bundleError("duplicate_path", "export manifest contains duplicate entry path")
			}
			if compareEntries(prev, entry) == 1 {
				return bundleError("invalid_manifest", "export manifest entries must be sorted")
			}
		}
	}
	return nil
}

func RenderManifest(manifest Manifest) ([]byte, error) {
	if err := ValidateManifest(manifest); err != nil {
		return nil, err
	}

	var builder strings.Builder
	builder.WriteByte('{')
	if manifest.CreatedMarker != nil {
		quoted, err := quoteJSONString(*manifest.CreatedMarker)
		if err != nil {
			return nil, err
		}
		builder.WriteString(`"createdMarker":`)
		builder.WriteString(quoted)
		builder.WriteByte(',')
	}
	builder.WriteString(`"entries":`)
	entries, err := CanonicalEntriesJSON(manifest.Entries)
	if err != nil {
		return nil, err
	}
	builder.Write(entries)
	builder.WriteString(`,"formatVersion":`)
	builder.WriteString(fmt.Sprintf("%d", manifest.FormatVersion))
	root, err := quoteJSONString(manifest.RootDigest)
	if err != nil {
		return nil, err
	}
	builder.WriteString(`,"rootDigest":`)
	builder.WriteString(root)
	builder.WriteString("}\n")
	return []byte(builder.String()), nil
}

func CanonicalEntriesJSON(entries []Entry) ([]byte, error) {
	sorted := cloneEntries(entries)
	sort.Slice(sorted, func(i, j int) bool {
		return compareEntries(sorted[i], sorted[j]) < 0
	})

	var builder strings.Builder
	builder.WriteByte('[')
	for i, entry := range sorted {
		if i > 0 {
			builder.WriteByte(',')
		}
		integrity, err := quoteJSONString(entry.Integrity)
		if err != nil {
			return nil, err
		}
		kind, err := quoteJSONString(string(entry.Kind))
		if err != nil {
			return nil, err
		}
		path, err := quoteJSONString(entry.Path)
		if err != nil {
			return nil, err
		}
		builder.WriteString(`{"bytes":`)
		builder.WriteString(fmt.Sprintf("%d", entry.Bytes))
		builder.WriteString(`,"integrity":`)
		builder.WriteString(integrity)
		builder.WriteString(`,"kind":`)
		builder.WriteString(kind)
		builder.WriteString(`,"path":`)
		builder.WriteString(path)
		builder.WriteByte('}')
	}
	builder.WriteByte(']')
	return []byte(builder.String()), nil
}

func validateEntry(entry Entry) error {
	if err := validateBundlePath(entry.Path); err != nil {
		return err
	}
	if containsInlineSecretMaterial(entry.Path) || containsInlineSecretMaterial(string(entry.Kind)) {
		return bundleError("inline_secret_metadata", "export metadata contains inline secret material")
	}
	switch entry.Kind {
	case EntryKindFile, EntryKindConfig, EntryKindPDS:
	default:
		return bundleError("invalid_manifest", "entry kind is unsupported")
	}
	if entry.Bytes < 0 || entry.Bytes > MaxEntryBytes {
		return bundleError("size_limit", "export entry exceeds size cap")
	}
	if !isValidSHA256SRI(entry.Integrity) {
		return bundleError("invalid_manifest", "entry integrity must be sha256 SRI")
	}
	return nil
}

func validateBundlePath(value string) error {
	if value == "" || value == "." || value == ".." {
		return bundleError("path_traversal", "path is outside the export scope")
	}
	if filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		return bundleError("path_traversal", "path is outside the export scope")
	}
	if strings.ContainsRune(value, '\x00') || strings.Contains(value, "\\") {
		return bundleError("path_traversal", "path is outside the export scope")
	}
	segments := strings.Split(value, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || strings.ContainsRune(segment, '\x00') {
			return bundleError("path_traversal", "path is outside the export scope")
		}
	}
	return nil
}

func isValidSHA256SRI(value string) bool {
	const prefix = "sha256-"
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	token := strings.TrimPrefix(value, prefix)
	if token == "" {
		return false
	}
	digest, err := base64.StdEncoding.Strict().DecodeString(token)
	return err == nil && len(digest) == 32
}

func decodeSRI(value string) ([]byte, error) {
	if !isValidSHA256SRI(value) {
		return nil, bundleError("invalid_manifest", "integrity must be sha256 SRI")
	}
	digest, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(value, "sha256-"))
	if err != nil {
		return nil, bundleError("invalid_manifest", "integrity must be sha256 SRI")
	}
	return digest, nil
}

func sriFromDigest(digest []byte) string {
	return "sha256-" + base64.StdEncoding.EncodeToString(digest)
}

func compareEntries(left Entry, right Entry) int {
	if left.Path < right.Path {
		return -1
	}
	if left.Path > right.Path {
		return 1
	}
	if left.Kind < right.Kind {
		return -1
	}
	if left.Kind > right.Kind {
		return 1
	}
	return 0
}

func decodeObject(raw []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != '{' {
		return nil, errors.New("expected object")
	}

	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("expected object key")
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
		return nil, errors.New("expected object end")
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

func rejectUnknownFields(fields map[string]json.RawMessage, allowed map[string]struct{}) error {
	names := make([]string, 0, len(fields))
	for key := range fields {
		names = append(names, key)
	}
	sort.Strings(names)

	for _, key := range names {
		if _, ok := allowed[key]; !ok {
			if containsInlineSecretMaterial(key) {
				return bundleError("inline_secret_metadata", "export metadata contains inline secret material")
			}
			return bundleError("invalid_manifest", fmt.Sprintf("unknown field %q", key))
		}
	}
	return nil
}

func requiredStringField(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := requiredStringFieldAllowEmpty(fields, key)
	if err != nil {
		return "", err
	}
	if value == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return value, nil
}

func requiredStringFieldAllowEmpty(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", fmt.Errorf("%s must be a string", key)
	}
	var value string
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func optionalStringField(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, bundleError("invalid_manifest", key+" must be a string")
	}
	value, err := requiredStringField(fields, key)
	if err != nil {
		return nil, bundleError("invalid_manifest", err.Error())
	}
	if containsInlineSecretMaterial(value) {
		return nil, bundleError("inline_secret_metadata", "export metadata contains inline secret material")
	}
	return &value, nil
}

func requiredIntField(fields map[string]json.RawMessage, key string) (int, error) {
	raw, ok := fields[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", key)
	}
	var value int
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return value, nil
}

func requiredInt64Field(fields map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := fields[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", key)
	}
	var value int64
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return value, nil
}

func requiredEntriesField(fields map[string]json.RawMessage, key string) ([]Entry, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, bundleError("invalid_manifest", "entries is required")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, bundleError("invalid_manifest", "entries is required")
	}
	var rawEntries []json.RawMessage
	if err := decodeSingleJSONValue(raw, &rawEntries); err != nil {
		return nil, bundleError("invalid_manifest", "entries must be an array")
	}
	if len(rawEntries) > MaxEntries {
		return nil, bundleError("size_limit", "export manifest exceeds entry cap")
	}
	entries := make([]Entry, 0, len(rawEntries))
	for _, rawEntry := range rawEntries {
		entry, err := parseEntry(rawEntry)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func parseEntry(raw []byte) (Entry, error) {
	fields, err := decodeObject(raw)
	if err != nil {
		return Entry{}, bundleError("invalid_manifest", err.Error())
	}
	if err := rejectUnknownFields(fields, entryFields); err != nil {
		return Entry{}, err
	}

	path, err := requiredStringFieldAllowEmpty(fields, "path")
	if err != nil {
		return Entry{}, bundleError("invalid_manifest", err.Error())
	}
	kind, err := requiredStringField(fields, "kind")
	if err != nil {
		return Entry{}, bundleError("invalid_manifest", err.Error())
	}
	bytes, err := requiredInt64Field(fields, "bytes")
	if err != nil {
		return Entry{}, bundleError("invalid_manifest", err.Error())
	}
	integrity, err := requiredStringField(fields, "integrity")
	if err != nil {
		return Entry{}, bundleError("invalid_manifest", err.Error())
	}

	entry := Entry{
		Path:      path,
		Kind:      EntryKind(kind),
		Bytes:     bytes,
		Integrity: integrity,
	}
	if err := validateEntry(entry); err != nil {
		return Entry{}, err
	}
	return entry, nil
}

func decodeSingleJSONValue(raw []byte, target interface{}) error {
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

func quoteJSONString(value string) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}

var (
	manifestFields = map[string]struct{}{
		"createdMarker": {},
		"entries":       {},
		"formatVersion": {},
		"rootDigest":    {},
	}
	entryFields = map[string]struct{}{
		"bytes":     {},
		"integrity": {},
		"kind":      {},
		"path":      {},
	}

	controlCharacterPattern = regexp.MustCompile(`[\x00-\x1f\x7f]`)
	privateKeyPattern       = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b`)
	secretAssignmentPattern = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*[:=]`)
	seedWordsPattern        = regexp.MustCompile(`(?i)\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b`)
	longHexPattern          = regexp.MustCompile(`(?:0x)?[A-Fa-f0-9]{32,}`)
	longBase64Pattern       = regexp.MustCompile(`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`)
)

func containsInlineSecretMaterial(value string) bool {
	if controlCharacterPattern.MatchString(value) ||
		strings.Contains(strings.ToUpper(value), "-----BEGIN") ||
		privateKeyPattern.MatchString(value) ||
		secretAssignmentPattern.MatchString(value) ||
		seedWordsPattern.MatchString(value) {
		return true
	}
	return longHexPattern.MatchString(value) || longBase64Pattern.MatchString(value)
}

func bundleError(code string, message string) *BundleError {
	return &BundleError{Code: code, Message: message}
}

func cloneManifest(manifest Manifest) Manifest {
	return Manifest{
		FormatVersion: manifest.FormatVersion,
		CreatedMarker: cloneStringPtr(manifest.CreatedMarker),
		Entries:       cloneEntries(manifest.Entries),
		RootDigest:    manifest.RootDigest,
	}
}

func cloneEntries(entries []Entry) []Entry {
	out := make([]Entry, len(entries))
	copy(out, entries)
	return out
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}

func cloneStringPtr(in *string) *string {
	if in == nil {
		return nil
	}
	out := *in
	return &out
}
