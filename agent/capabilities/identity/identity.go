package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/atomicfile"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "identity.attestation"

	defaultStateRoot           = "/var/lib/vita-agent"
	defaultAttestationFilename = "identity-attestation.json"
	attestationFileMode        = 0o600
	stateRootMode              = 0o700

	didPlcPrefix = "did:plc:"
	didWebPrefix = "did:web:"

	maxHandleLength = 253
	maxDIDLength    = 2048
	maxKeyRefLength = 2048
)

var (
	didPlcIdentifierPattern  = regexp.MustCompile(`^[a-z2-7]{24}$`)
	didWebPathSegmentPattern = regexp.MustCompile(`^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$`)
	handleLabelPattern       = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	opaqueRefPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	schemePattern            = regexp.MustCompile(`^[a-z][a-z0-9+.-]*$`)

	pemBlockPattern         = regexp.MustCompile(`(?i)-----BEGIN\b`)
	privateKeyPattern       = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b`)
	secretAssignmentPattern = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:)`)
	seedWordsPattern        = regexp.MustCompile(`(?i)\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b`)
	longHexPattern          = regexp.MustCompile(`(?:0x)?[A-Fa-f0-9]{32,}`)
	longBase64Pattern       = regexp.MustCompile(`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`)

	attestationFields = map[string]struct{}{
		"did":           {},
		"handle":        {},
		"signingKeyRef": {},
	}
	keyRefFields = map[string]struct{}{
		"handle": {},
		"id":     {},
	}
	secretFieldNameTokens = map[string]struct{}{
		"apikey":      {},
		"key":         {},
		"keymaterial": {},
		"mnemonic":    {},
		"passphrase":  {},
		"pem":         {},
		"privatekey":  {},
		"recoverykey": {},
		"rotationkey": {},
		"seed":        {},
		"seedphrase":  {},
		"secret":      {},
		"signingkey":  {},
	}
	inlineReferenceSchemes = map[string]struct{}{
		"data":    {},
		"inline":  {},
		"literal": {},
	}
)

type SigningKeyRef struct {
	ID     string `json:"id"`
	Handle string `json:"handle"`
}

type Attestation struct {
	DID           string        `json:"did"`
	Handle        string        `json:"handle"`
	SigningKeyRef SigningKeyRef `json:"signingKeyRef"`
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired Attestation `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r *ApplyRequest) UnmarshalJSON(raw []byte) error {
	type applyRequestJSON ApplyRequest
	var decoded applyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}

	*r = ApplyRequest(decoded)
	return nil
}

func (r ApplyRequest) Validate() error {
	return validateAttestation(r.Desired)
}

type ReadResponse struct {
	Exists      bool        `json:"exists"`
	Attestation Attestation `json:"attestation"`
	Raw         []byte      `json:"raw"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs attestationFileSystem
}

type attestationSnapshot struct {
	exists bool
	bytes  []byte
}

type attestationFileSystem interface {
	Read(context.Context) (attestationSnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, attestationSnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid identity attestation request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse identity attestation: %s", e.Reason)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs attestationFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected identity.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing attestation filesystem"}
	}

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false}, nil
	}

	parsed, err := parseAttestation(snapshot.bytes)
	if err != nil {
		return nil, err
	}

	return ReadResponse{
		Exists:      true,
		Attestation: parsed,
		Raw:         cloneBytes(snapshot.bytes),
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected identity.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing attestation filesystem"}
	}
	if err := applyReq.Validate(); err != nil {
		return nil, err
	}

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}

	desiredBytes := renderAttestation(applyReq.Desired)
	if err := c.fs.AtomicWrite(ctx, desiredBytes); err != nil {
		return nil, err
	}

	return undoAttestation{
		fs:    c.fs,
		prior: cloneSnapshot(prior),
	}, nil
}

type undoAttestation struct {
	fs    attestationFileSystem
	prior attestationSnapshot
}

func (u undoAttestation) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing attestation filesystem"}
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

type defaultFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() attestationFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultAttestationFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (attestationSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return attestationSnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return attestationSnapshot{exists: false}, nil
		}
		return attestationSnapshot{}, fmt.Errorf("read identity attestation: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return attestationSnapshot{}, err
	}

	return attestationSnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create identity state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure identity state root: %w", err)
	}

	if err := atomicfile.WriteWithPatternAndBeforeCommit(
		atomicfile.OSFileSystem{},
		fs.path,
		content,
		attestationFileMode,
		".identity-attestation-*.tmp",
		ctx.Err,
	); err != nil {
		return fmt.Errorf("write identity attestation: %w", err)
	}
	return nil
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot attestationSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove identity attestation: %w", err)
	}
	return nil
}

func validateAttestation(attestation Attestation) error {
	if !isSupportedDID(attestation.DID) {
		return &InvalidRequestError{Reason: "did must be a supported did:plc or did:web identifier"}
	}
	if !isDomainHandle(attestation.Handle) {
		return &InvalidRequestError{Reason: "handle must be a domain-style handle"}
	}
	if err := validateSigningKeyRef(attestation.SigningKeyRef); err != nil {
		return err
	}
	return nil
}

func validateSigningKeyRef(ref SigningKeyRef) error {
	if err := validateKeyReference(ref.ID, "signingKeyRef.id"); err != nil {
		return err
	}
	if err := validateKeyReference(ref.Handle, "signingKeyRef.handle"); err != nil {
		return err
	}
	return nil
}

func validateKeyReference(value, field string) error {
	if value == "" {
		return &InvalidRequestError{Reason: field + " must be a key reference string"}
	}
	if containsInlineSecretMaterial(value) {
		return &InvalidRequestError{Reason: field + " must not contain inline key material"}
	}
	if len(value) > maxKeyRefLength || !isReferenceSyntax(value) {
		return &InvalidRequestError{Reason: field + " must use key reference syntax"}
	}
	return nil
}

func renderAttestation(attestation Attestation) []byte {
	encoded, err := json.Marshal(attestation)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}

func parseAttestation(raw []byte) (Attestation, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Attestation{}, &ParseError{Reason: "empty attestation"}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return Attestation{}, &ParseError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, attestationFields); err != nil {
		return Attestation{}, err
	}

	did, err := requiredStringField(fields, "did")
	if err != nil {
		return Attestation{}, err
	}
	handle, err := requiredStringField(fields, "handle")
	if err != nil {
		return Attestation{}, err
	}
	keyRef, err := requiredSigningKeyRef(fields, "signingKeyRef")
	if err != nil {
		return Attestation{}, err
	}

	attestation := Attestation{
		DID:           did,
		Handle:        handle,
		SigningKeyRef: keyRef,
	}
	if err := validateAttestation(attestation); err != nil {
		return Attestation{}, err
	}
	return attestation, nil
}

func requiredSigningKeyRef(fields map[string]json.RawMessage, key string) (SigningKeyRef, error) {
	raw, ok := fields[key]
	if !ok {
		return SigningKeyRef{}, &ParseError{Reason: "missing " + key}
	}

	keyFields, err := decodeObject(raw)
	if err != nil {
		return SigningKeyRef{}, &ParseError{Reason: key + ": " + err.Error()}
	}
	if err := rejectUnknownFields(keyFields, keyRefFields); err != nil {
		return SigningKeyRef{}, err
	}

	id, err := requiredStringField(keyFields, "id")
	if err != nil {
		return SigningKeyRef{}, err
	}
	handle, err := requiredStringField(keyFields, "handle")
	if err != nil {
		return SigningKeyRef{}, err
	}
	return SigningKeyRef{ID: id, Handle: handle}, nil
}

func requiredStringField(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", &ParseError{Reason: "missing " + key}
	}

	var value string
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return "", &ParseError{Reason: key + " must be a string"}
	}
	return value, nil
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
			return nil, fmt.Errorf("duplicate field %q", key)
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

func rejectUnknownFields(fields map[string]json.RawMessage, allowed map[string]struct{}) error {
	names := make([]string, 0, len(fields))
	for key := range fields {
		names = append(names, key)
	}
	sort.Strings(names)

	for _, key := range names {
		if isSecretFieldName(key) {
			return &ParseError{Reason: fmt.Sprintf("%s contains inline key material", key)}
		}
		if _, ok := allowed[key]; !ok {
			return &ParseError{Reason: fmt.Sprintf("unknown field %q", key)}
		}
	}
	return nil
}

func isSupportedDID(value string) bool {
	if len(value) > maxDIDLength || value != strings.TrimSpace(value) {
		return false
	}
	return isDIDPlc(value) || isDIDWeb(value)
}

func isDIDPlc(value string) bool {
	if !strings.HasPrefix(value, didPlcPrefix) {
		return false
	}
	return didPlcIdentifierPattern.MatchString(value[len(didPlcPrefix):])
}

func isDIDWeb(value string) bool {
	if !strings.HasPrefix(value, didWebPrefix) {
		return false
	}

	identifier := value[len(didWebPrefix):]
	if identifier == "" ||
		strings.Contains(identifier, "/") ||
		strings.Contains(identifier, "?") ||
		strings.Contains(identifier, "#") ||
		hasControlCharacter(identifier) {
		return false
	}

	segments := strings.Split(identifier, ":")
	if len(segments) == 0 || !isDomainHandle(segments[0]) {
		return false
	}

	for i := 1; i < len(segments); i++ {
		segment := segments[i]
		if segment == "" ||
			segment == "." ||
			segment == ".." ||
			!didWebPathSegmentPattern.MatchString(segment) {
			return false
		}
	}
	return true
}

func isDomainHandle(value string) bool {
	if len(value) < 3 ||
		len(value) > maxHandleLength ||
		value != strings.TrimSpace(value) ||
		value != strings.ToLower(value) ||
		strings.Contains(value, "://") ||
		strings.Contains(value, "/") ||
		strings.Contains(value, ":") ||
		strings.HasSuffix(value, ".") {
		return false
	}

	labels := strings.Split(value, ".")
	if len(labels) < 2 {
		return false
	}

	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || !handleLabelPattern.MatchString(label) {
			return false
		}
	}

	topLevelLabel := labels[len(labels)-1]
	return len(topLevelLabel) >= 2 && !allDigits(topLevelLabel)
}

func isReferenceSyntax(value string) bool {
	if value != strings.TrimSpace(value) || hasControlCharacter(value) {
		return false
	}
	for _, r := range value {
		switch r {
		case '<', '>', '{', '}', '`', '"', '\'':
			return false
		}
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' {
			return false
		}
	}

	separator := strings.Index(value, "://")
	if separator == -1 {
		return opaqueRefPattern.MatchString(value)
	}
	if separator <= 0 || separator == len(value)-3 {
		return false
	}

	scheme := strings.ToLower(value[:separator])
	if !schemePattern.MatchString(scheme) {
		return false
	}
	if _, forbidden := inlineReferenceSchemes[scheme]; forbidden {
		return false
	}
	return value[separator+3:] != ""
}

func containsInlineSecretMaterial(value string) bool {
	if hasControlCharacter(value) ||
		pemBlockPattern.MatchString(value) ||
		privateKeyPattern.MatchString(value) ||
		containsSecretAssignment(value) ||
		seedWordsPattern.MatchString(value) {
		return true
	}
	return longHexPattern.MatchString(value) || longBase64Pattern.MatchString(value)
}

func containsSecretAssignment(value string) bool {
	matches := secretAssignmentPattern.FindAllStringIndex(value, -1)
	for _, match := range matches {
		if len(match) != 2 {
			continue
		}
		assignment := value[match[0]:match[1]]
		if strings.HasSuffix(assignment, ":") && strings.HasPrefix(value[match[1]:], "//") {
			continue
		}
		return true
	}
	return false
}

func isSecretFieldName(value string) bool {
	normalized := strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(value))
	_, ok := secretFieldNameTokens[normalized]
	return ok
}

func hasControlCharacter(value string) bool {
	for _, r := range value {
		if (r >= 0 && r <= 0x1f) || r == 0x7f {
			return true
		}
	}
	return false
}

func allDigits(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != ""
}

func cloneSnapshot(snapshot attestationSnapshot) attestationSnapshot {
	return attestationSnapshot{
		exists: snapshot.exists,
		bytes:  cloneBytes(snapshot.bytes),
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
