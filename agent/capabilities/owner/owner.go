package owner

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/identity"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "owner.identity"

	defaultStateRoot               = "/var/lib/vita-agent"
	defaultOwnerCredentialFilename = "owner-credential.json"
	ownerCredentialFileMode        = 0o600
	stateRootMode                  = 0o700

	defaultChallengeTTL = 5 * time.Minute

	ownerChallengeBytes = 32

	maxCredentialIDBytes      = 1024
	maxPublicKeyCOSEBytes     = 4096
	maxUserHandleBytes        = 64
	maxAAGUIDLength           = 64
	maxTransportLength        = 64
	maxTransports             = 16
	maxActionLength           = 128
	maxAuthenticatorDataBytes = 4096
	maxClientDataJSONBytes    = 8192
	maxSignatureBytes         = 512
)

var (
	base64URLPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	uuidPattern        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	transportPattern   = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
	actionPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	applyRequestFields = []string{"desired"}
	verifyFields       = []string{"assertion"}
)

type OwnerCredential struct {
	CredentialID  string   `json:"credentialId"`
	PublicKeyCOSE string   `json:"publicKeyCose"`
	SignCount     uint32   `json:"signCount"`
	AAGUID        string   `json:"aaguid,omitempty"`
	Transports    []string `json:"transports,omitempty"`
	RPID          string   `json:"rpId"`
	UserHandle    string   `json:"userHandle"`
}

type ownerCredentialJSON struct {
	CredentialID  *string   `json:"credentialId"`
	PublicKeyCOSE *string   `json:"publicKeyCose"`
	SignCount     *uint32   `json:"signCount"`
	AAGUID        *string   `json:"aaguid,omitempty"`
	Transports    *[]string `json:"transports,omitempty"`
	RPID          *string   `json:"rpId"`
	UserHandle    *string   `json:"userHandle"`
}

func (c *OwnerCredential) UnmarshalJSON(raw []byte) error {
	var decoded ownerCredentialJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}

	if decoded.CredentialID == nil {
		return &InvalidRequestError{Reason: "credentialId is required"}
	}
	if decoded.PublicKeyCOSE == nil {
		return &InvalidRequestError{Reason: "publicKeyCose is required"}
	}
	if decoded.SignCount == nil {
		return &InvalidRequestError{Reason: "signCount is required"}
	}
	if decoded.RPID == nil {
		return &InvalidRequestError{Reason: "rpId is required"}
	}
	if decoded.UserHandle == nil {
		return &InvalidRequestError{Reason: "userHandle is required"}
	}

	credential := OwnerCredential{
		CredentialID:  *decoded.CredentialID,
		PublicKeyCOSE: *decoded.PublicKeyCOSE,
		SignCount:     *decoded.SignCount,
		RPID:          *decoded.RPID,
		UserHandle:    *decoded.UserHandle,
	}
	if decoded.AAGUID != nil {
		credential.AAGUID = *decoded.AAGUID
	}
	if decoded.Transports != nil {
		credential.Transports = cloneStrings(*decoded.Transports)
	}
	if err := validateOwnerCredential(credential); err != nil {
		return err
	}

	*c = credential
	return nil
}

type OwnerAssertion struct {
	CredentialID      string `json:"credentialId"`
	AuthenticatorData string `json:"authenticatorData"`
	ClientDataJSON    string `json:"clientDataJSON"`
	Signature         string `json:"signature"`
	Action            string `json:"action"`
}

type ownerAssertionJSON struct {
	CredentialID      *string `json:"credentialId"`
	AuthenticatorData *string `json:"authenticatorData"`
	ClientDataJSON    *string `json:"clientDataJSON"`
	Signature         *string `json:"signature"`
	Action            *string `json:"action"`
}

func (a *OwnerAssertion) UnmarshalJSON(raw []byte) error {
	var decoded ownerAssertionJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	if decoded.CredentialID == nil {
		return &InvalidRequestError{Reason: "credentialId is required"}
	}
	if decoded.AuthenticatorData == nil {
		return &InvalidRequestError{Reason: "authenticatorData is required"}
	}
	if decoded.ClientDataJSON == nil {
		return &InvalidRequestError{Reason: "clientDataJSON is required"}
	}
	if decoded.Signature == nil {
		return &InvalidRequestError{Reason: "signature is required"}
	}
	if decoded.Action == nil {
		return &InvalidRequestError{Reason: "action is required"}
	}

	assertion := OwnerAssertion{
		CredentialID:      *decoded.CredentialID,
		AuthenticatorData: *decoded.AuthenticatorData,
		ClientDataJSON:    *decoded.ClientDataJSON,
		Signature:         *decoded.Signature,
		Action:            *decoded.Action,
	}
	if err := validateOwnerAssertion(assertion); err != nil {
		return err
	}

	*a = assertion
	return nil
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired OwnerCredential `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r *ApplyRequest) UnmarshalJSON(raw []byte) error {
	type applyRequestJSON struct {
		Desired *OwnerCredential `json:"desired"`
	}

	var decoded applyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	if decoded.Desired == nil {
		return &InvalidRequestError{Reason: "desired is required"}
	}

	r.Desired = *decoded.Desired
	return nil
}

func (r ApplyRequest) Validate() error {
	return validateOwnerCredential(r.Desired)
}

type VerifyRequest struct {
	Assertion OwnerAssertion `json:"assertion"`
}

func (VerifyRequest) CapabilityRequest() {}

func (r *VerifyRequest) UnmarshalJSON(raw []byte) error {
	type verifyRequestJSON struct {
		Assertion *OwnerAssertion `json:"assertion"`
	}

	var decoded verifyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	if decoded.Assertion == nil {
		return &InvalidRequestError{Reason: "assertion is required"}
	}

	r.Assertion = *decoded.Assertion
	return nil
}

func (r VerifyRequest) Validate() error {
	return validateOwnerAssertion(r.Assertion)
}

type ReadResponse struct {
	Exists     bool            `json:"exists"`
	Enrolled   bool            `json:"enrolled"`
	Credential OwnerCredential `json:"credential"`
}

func (ReadResponse) CapabilityResponse() {}

type VerifyResponse struct {
	Verified bool   `json:"verified"`
	Action   string `json:"action,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

func (VerifyResponse) CapabilityResponse() {}

type ChallengeTicket struct {
	Challenge string    `json:"challenge"`
	Action    string    `json:"action"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type Capability struct {
	fs           ownerFileSystem
	now          func() time.Time
	challengeTTL time.Duration

	mu         sync.Mutex
	challenges map[string]challengeRecord
}

type ownerSnapshot struct {
	exists bool
	bytes  []byte
}

type ownerFileSystem interface {
	Read(context.Context) (ownerSnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, ownerSnapshot) error
}

type challengeRecord struct {
	action    string
	expiresAt time.Time
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid owner identity request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse owner credential: %s", e.Reason)
}

type DenyError struct {
	Reason string
}

func (e *DenyError) Error() string {
	return fmt.Sprintf("owner assertion denied: %s", sanitizeReason(e.Reason))
}

func (e *DenyError) ApplyErrorCode() string {
	return "owner_denied"
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs ownerFileSystem) *Capability {
	return &Capability{
		fs:           fs,
		now:          time.Now,
		challengeTTL: defaultChallengeTTL,
		challenges:   make(map[string]challengeRecord),
	}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	switch typed := req.(type) {
	case ReadRequest:
		return c.read(ctx)
	case VerifyRequest:
		response, _, _, err := c.verifyAssertion(ctx, typed.Assertion)
		return response, err
	default:
		return nil, &InvalidRequestError{Reason: "expected owner.ReadRequest or owner.VerifyRequest"}
	}
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	switch typed := req.(type) {
	case ApplyRequest:
		return c.enroll(ctx, typed)
	case VerifyRequest:
		response, prior, _, err := c.verifyAssertion(ctx, typed.Assertion)
		if err != nil {
			return nil, err
		}
		if !response.Verified {
			return nil, &DenyError{Reason: response.Reason}
		}
		return undoOwnerCredential{fs: c.fs, prior: cloneSnapshot(prior)}, nil
	default:
		return nil, &InvalidRequestError{Reason: "expected owner.ApplyRequest or owner.VerifyRequest"}
	}
}

func (c *Capability) Challenge(action string) (ChallengeTicket, error) {
	if err := validateAction(action); err != nil {
		return ChallengeTicket{}, err
	}
	if c == nil {
		return ChallengeTicket{}, &InvalidRequestError{Reason: "missing owner capability"}
	}

	challengeBytes := make([]byte, ownerChallengeBytes)
	if _, err := rand.Read(challengeBytes); err != nil {
		return ChallengeTicket{}, fmt.Errorf("mint owner challenge: %w", err)
	}
	challenge := base64.RawURLEncoding.EncodeToString(challengeBytes)

	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.nowUTC()
	c.pruneExpiredChallengesLocked(now)
	if c.challenges == nil {
		c.challenges = make(map[string]challengeRecord)
	}
	expiresAt := now.Add(c.challengeTTL)
	c.challenges[challenge] = challengeRecord{
		action:    action,
		expiresAt: expiresAt,
	}

	return ChallengeTicket{
		Challenge: challenge,
		Action:    action,
		ExpiresAt: expiresAt,
	}, nil
}

func (c *Capability) Consume(challenge, action string) error {
	if c == nil {
		return &InvalidRequestError{Reason: "missing owner capability"}
	}
	if !isBase64URL(challenge) {
		return &DenyError{Reason: denyInvalidChallenge}
	}
	if err := validateAction(action); err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	return c.consumeChallengeLocked(challenge, action, c.nowUTC())
}

func DecodeRequest(raw json.RawMessage) (capabilities.TypedRequest, error) {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return nil, err
	}

	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if _, ok := envelope["desired"]; ok {
		if err := rejectUnexpectedEnvelopeFields(envelope, applyRequestFields); err != nil {
			return nil, err
		}
		var request ApplyRequest
		if err := jsonsafe.DecodeStrict(raw, &request); err != nil {
			return nil, err
		}
		return request, nil
	}
	if _, ok := envelope["assertion"]; ok {
		if err := rejectUnexpectedEnvelopeFields(envelope, verifyFields); err != nil {
			return nil, err
		}
		var request VerifyRequest
		if err := jsonsafe.DecodeStrict(raw, &request); err != nil {
			return nil, err
		}
		return request, nil
	}

	return nil, &InvalidRequestError{Reason: "request must contain desired or assertion"}
}

func (c *Capability) read(ctx context.Context) (ReadResponse, error) {
	if c == nil || c.fs == nil {
		return ReadResponse{}, &InvalidRequestError{Reason: "missing owner filesystem"}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return ReadResponse{}, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false, Enrolled: false}, nil
	}

	credential, err := parseCredential(snapshot.bytes)
	if err != nil {
		return ReadResponse{}, err
	}

	return ReadResponse{
		Exists:     true,
		Enrolled:   true,
		Credential: credential,
	}, nil
}

func (c *Capability) enroll(ctx context.Context, req ApplyRequest) (transaction.Undo, error) {
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing owner filesystem"}
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}

	desiredBytes := renderCredential(req.Desired)
	if err := c.atomicWriteOrRestore(ctx, desiredBytes, prior); err != nil {
		return nil, err
	}

	return undoOwnerCredential{
		fs:    c.fs,
		prior: cloneSnapshot(prior),
	}, nil
}

func (c *Capability) verifyAssertion(ctx context.Context, assertion OwnerAssertion) (VerifyResponse, ownerSnapshot, bool, error) {
	if c == nil || c.fs == nil {
		return deny(denyStateUnavailable), ownerSnapshot{}, false, nil
	}
	if err := validateOwnerAssertion(assertion); err != nil {
		return deny(denyInvalidRequest), ownerSnapshot{}, false, nil
	}

	authenticatorData, err := decodeBase64URLField(assertion.AuthenticatorData, "authenticatorData", 37, maxAuthenticatorDataBytes)
	if err != nil {
		return deny(denyInvalidRequest), ownerSnapshot{}, false, nil
	}
	clientDataJSON, err := decodeBase64URLField(assertion.ClientDataJSON, "clientDataJSON", 1, maxClientDataJSONBytes)
	if err != nil {
		return deny(denyInvalidRequest), ownerSnapshot{}, false, nil
	}
	signature, err := decodeBase64URLField(assertion.Signature, "signature", 1, maxSignatureBytes)
	if err != nil {
		return deny(denyInvalidRequest), ownerSnapshot{}, false, nil
	}

	clientData, err := parseClientData(clientDataJSON)
	if err != nil {
		return deny(denyInvalidClientData), ownerSnapshot{}, false, nil
	}
	if !isBase64URL(clientData.Challenge) {
		return deny(denyInvalidChallenge), ownerSnapshot{}, false, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return deny(denyStateUnavailable), ownerSnapshot{}, false, nil
	}
	if !prior.exists {
		return deny(denyNotEnrolled), prior, false, nil
	}

	credential, err := parseCredential(prior.bytes)
	if err != nil {
		return deny(denyCredentialUnreadable), prior, false, nil
	}
	if assertion.CredentialID != credential.CredentialID {
		return deny(denyUnknownCredential), prior, false, nil
	}

	if err := c.consumeChallengeLocked(clientData.Challenge, assertion.Action, c.nowUTC()); err != nil {
		var denied *DenyError
		if errors.As(err, &denied) {
			return deny(denied.Reason), prior, false, nil
		}
		return deny(denyInvalidRequest), prior, false, nil
	}

	if clientData.Type != webauthnGetType {
		return deny(denyInvalidType), prior, false, nil
	}
	if !originMatchesRPID(clientData.Origin, credential.RPID) {
		return deny(denyOriginMismatch), prior, false, nil
	}

	assertedSignCount, reason, ok := verifyWebAuthnAssertion(credential, authenticatorData, clientDataJSON, signature)
	if !ok {
		return deny(reason), prior, false, nil
	}
	if assertedSignCount <= credential.SignCount && assertedSignCount != 0 && credential.SignCount != 0 {
		return deny(denySignCountRegression), prior, false, nil
	}

	updated := credential
	mutated := false
	if assertedSignCount > credential.SignCount {
		updated.SignCount = assertedSignCount
		mutated = true
		if err := c.atomicWriteOrRestore(ctx, renderCredential(updated), prior); err != nil {
			return deny(denyStateUpdateFailed), prior, false, nil
		}
	}

	return VerifyResponse{
		Verified: true,
		Action:   assertion.Action,
	}, prior, mutated, nil
}

func (c *Capability) atomicWriteOrRestore(ctx context.Context, content []byte, prior ownerSnapshot) error {
	err := c.fs.AtomicWrite(ctx, content)
	if err == nil {
		return nil
	}

	current, readErr := c.fs.Read(ctx)
	if readErr != nil || snapshotsEqual(current, prior) {
		return err
	}
	if restoreErr := c.fs.Replace(ctx, cloneSnapshot(prior)); restoreErr != nil {
		return errors.Join(err, fmt.Errorf("restore owner credential after failed write: %w", restoreErr))
	}
	return err
}

func (c *Capability) consumeChallengeLocked(challenge, action string, now time.Time) error {
	if c.challenges == nil {
		return &DenyError{Reason: denyChallengeReplayed}
	}

	record, ok := c.challenges[challenge]
	if ok {
		delete(c.challenges, challenge)
	}
	if !ok {
		return &DenyError{Reason: denyChallengeReplayed}
	}
	if now.After(record.expiresAt) {
		return &DenyError{Reason: denyChallengeExpired}
	}
	if record.action != action {
		return &DenyError{Reason: denyActionMismatch}
	}
	return nil
}

func (c *Capability) pruneExpiredChallengesLocked(now time.Time) {
	for challenge, record := range c.challenges {
		if now.After(record.expiresAt) {
			delete(c.challenges, challenge)
		}
	}
}

func (c *Capability) nowUTC() time.Time {
	if c == nil || c.now == nil {
		return time.Now().UTC()
	}
	return c.now().UTC()
}

type undoOwnerCredential struct {
	fs    ownerFileSystem
	prior ownerSnapshot
}

func (u undoOwnerCredential) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing owner filesystem"}
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

type defaultFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() ownerFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultOwnerCredentialFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (ownerSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return ownerSnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ownerSnapshot{exists: false}, nil
		}
		return ownerSnapshot{}, fmt.Errorf("read owner credential: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return ownerSnapshot{}, err
	}

	return ownerSnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create owner state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure owner state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".owner-credential-*.tmp")
	if err != nil {
		return fmt.Errorf("create owner credential temp file: %w", err)
	}
	tmpName := tmp.Name()
	closed := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
		_ = os.Remove(tmpName)
	}()

	if err := tmp.Chmod(ownerCredentialFileMode); err != nil {
		return fmt.Errorf("secure owner credential temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write owner credential temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write owner credential temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync owner credential temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close owner credential temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename is the single commit point: callers only receive an undo after nil error.
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace owner credential: %w", err)
	}

	return nil
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot ownerSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove owner credential: %w", err)
	}
	return nil
}

func validateOwnerCredential(credential OwnerCredential) error {
	if err := validateBase64URLField(credential.CredentialID, "credentialId", 1, maxCredentialIDBytes); err != nil {
		return err
	}
	if identity.ContainsInlineSecretMaterial(credential.CredentialID) {
		return &InvalidRequestError{Reason: "credentialId must not contain inline key material"}
	}

	publicKeyCOSE, err := decodeBase64URLField(credential.PublicKeyCOSE, "publicKeyCose", 1, maxPublicKeyCOSEBytes)
	if err != nil {
		return err
	}
	if _, err := parseCOSEPublicKey(publicKeyCOSE); err != nil {
		return &InvalidRequestError{Reason: "publicKeyCose must be a supported public COSE key"}
	}

	if !identity.IsDomainHandle(credential.RPID) {
		return &InvalidRequestError{Reason: "rpId must be a domain-style host"}
	}
	if identity.ContainsInlineSecretMaterial(credential.RPID) {
		return &InvalidRequestError{Reason: "rpId must not contain inline key material"}
	}

	if err := validateBase64URLField(credential.UserHandle, "userHandle", 1, maxUserHandleBytes); err != nil {
		return err
	}
	if identity.ContainsInlineSecretMaterial(credential.UserHandle) {
		return &InvalidRequestError{Reason: "userHandle must not contain inline key material"}
	}

	if credential.AAGUID != "" {
		if err := validateAAGUID(credential.AAGUID); err != nil {
			return err
		}
	}
	if credential.Transports != nil {
		if err := validateTransports(credential.Transports); err != nil {
			return err
		}
	}
	return nil
}

func validateOwnerAssertion(assertion OwnerAssertion) error {
	if err := validateBase64URLField(assertion.CredentialID, "credentialId", 1, maxCredentialIDBytes); err != nil {
		return err
	}
	if err := validateBase64URLField(assertion.AuthenticatorData, "authenticatorData", 37, maxAuthenticatorDataBytes); err != nil {
		return err
	}
	if err := validateBase64URLField(assertion.ClientDataJSON, "clientDataJSON", 1, maxClientDataJSONBytes); err != nil {
		return err
	}
	if err := validateBase64URLField(assertion.Signature, "signature", 1, maxSignatureBytes); err != nil {
		return err
	}
	return validateAction(assertion.Action)
}

func validateBase64URLField(value, field string, minBytes, maxBytes int) error {
	if !isBase64URL(value) {
		return &InvalidRequestError{Reason: field + " must be base64url without padding"}
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return &InvalidRequestError{Reason: field + " must be base64url without padding"}
	}
	if len(decoded) < minBytes || len(decoded) > maxBytes {
		return &InvalidRequestError{Reason: fmt.Sprintf("%s must decode to %d..%d bytes", field, minBytes, maxBytes)}
	}
	return nil
}

func decodeBase64URLField(value, field string, minBytes, maxBytes int) ([]byte, error) {
	if err := validateBase64URLField(value, field, minBytes, maxBytes); err != nil {
		return nil, err
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, &InvalidRequestError{Reason: field + " must be base64url without padding"}
	}
	return decoded, nil
}

func isBase64URL(value string) bool {
	return value != "" &&
		!strings.Contains(value, "=") &&
		value == strings.TrimSpace(value) &&
		base64URLPattern.MatchString(value)
}

func validateAAGUID(value string) error {
	if len(value) > maxAAGUIDLength ||
		value != strings.TrimSpace(value) ||
		identity.ContainsInlineSecretMaterial(value) {
		return &InvalidRequestError{Reason: "aaguid must be a public identifier"}
	}
	if uuidPattern.MatchString(value) {
		return nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 16 || strings.Contains(value, "=") || !base64URLPattern.MatchString(value) {
		return &InvalidRequestError{Reason: "aaguid must be a UUID or 16-byte base64url value"}
	}
	return nil
}

func validateTransports(transports []string) error {
	if len(transports) == 0 || len(transports) > maxTransports {
		return &InvalidRequestError{Reason: "transports must be a non-empty bounded list when present"}
	}
	seen := make(map[string]struct{}, len(transports))
	for _, transport := range transports {
		if transport == "" ||
			len(transport) > maxTransportLength ||
			transport != strings.TrimSpace(transport) ||
			!transportPattern.MatchString(transport) ||
			identity.ContainsInlineSecretMaterial(transport) {
			return &InvalidRequestError{Reason: "transports must contain public transport tokens"}
		}
		if _, exists := seen[transport]; exists {
			return &InvalidRequestError{Reason: "transports must not contain duplicates"}
		}
		seen[transport] = struct{}{}
	}
	return nil
}

func validateAction(action string) error {
	if action == "" ||
		len(action) > maxActionLength ||
		action != strings.TrimSpace(action) ||
		!actionPattern.MatchString(action) ||
		identity.ContainsInlineSecretMaterial(action) {
		return &InvalidRequestError{Reason: "action must be a bounded public action token"}
	}
	return nil
}

func renderCredential(credential OwnerCredential) []byte {
	encoded, err := json.Marshal(credential)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}

func parseCredential(raw []byte) (OwnerCredential, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return OwnerCredential{}, &ParseError{Reason: "empty credential"}
	}
	var credential OwnerCredential
	if err := jsonsafe.DecodeStrict(raw, &credential); err != nil {
		return OwnerCredential{}, &ParseError{Reason: err.Error()}
	}
	if err := validateOwnerCredential(credential); err != nil {
		return OwnerCredential{}, err
	}
	return credential, nil
}

func rejectUnexpectedEnvelopeFields(envelope map[string]json.RawMessage, allowed []string) error {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, field := range allowed {
		allowedSet[field] = struct{}{}
	}

	fields := make([]string, 0, len(envelope))
	for field := range envelope {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	for _, field := range fields {
		if _, ok := allowedSet[field]; !ok {
			return &InvalidRequestError{Reason: fmt.Sprintf("unknown field %q", field)}
		}
	}
	return nil
}

func deny(reason string) VerifyResponse {
	return VerifyResponse{
		Verified: false,
		Reason:   sanitizeReason(reason),
	}
}

func sanitizeReason(reason string) string {
	switch reason {
	case denyActionMismatch,
		denyChallengeExpired,
		denyChallengeReplayed,
		denyCredentialUnreadable,
		denyInvalidChallenge,
		denyInvalidClientData,
		denyInvalidRequest,
		denyInvalidSignature,
		denyInvalidType,
		denyNotEnrolled,
		denyOriginMismatch,
		denyRPIDHashMismatch,
		denySignCountRegression,
		denyStateUnavailable,
		denyStateUpdateFailed,
		denyUnknownCredential,
		denyUnparseablePublicKey,
		denyUserPresenceRequired:
		return reason
	default:
		return denyInvalidRequest
	}
}

const (
	denyActionMismatch       = "action_mismatch"
	denyChallengeExpired     = "challenge_expired"
	denyChallengeReplayed    = "challenge_replayed"
	denyCredentialUnreadable = "credential_unreadable"
	denyInvalidChallenge     = "invalid_challenge"
	denyInvalidClientData    = "invalid_client_data"
	denyInvalidRequest       = "invalid_request"
	denyInvalidSignature     = "signature_invalid"
	denyInvalidType          = "invalid_type"
	denyNotEnrolled          = "not_enrolled"
	denyOriginMismatch       = "origin_mismatch"
	denyRPIDHashMismatch     = "rp_id_hash_mismatch"
	denySignCountRegression  = "sign_count_regression"
	denyStateUnavailable     = "state_unavailable"
	denyStateUpdateFailed    = "state_update_failed"
	denyUnknownCredential    = "unknown_credential"
	denyUnparseablePublicKey = "public_key_unparseable"
	denyUserPresenceRequired = "user_presence_required"
)

func cloneSnapshot(snapshot ownerSnapshot) ownerSnapshot {
	return ownerSnapshot{
		exists: snapshot.exists,
		bytes:  cloneBytes(snapshot.bytes),
	}
}

func snapshotsEqual(a, b ownerSnapshot) bool {
	return a.exists == b.exists && bytes.Equal(a.bytes, b.bytes)
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}

func cloneStrings(in []string) []string {
	if in == nil {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}
