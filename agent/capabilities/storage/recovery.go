package storage

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/vita/agent/internal/jsonsafe"
)

const (
	maxRecoveryRefLength = 2048
)

type RecoveryKeyRef struct {
	ID          string  `json:"id"`
	Handle      string  `json:"handle"`
	KeyStoreRef *string `json:"keyStoreRef,omitempty"`
}

type RecoveryQuorum struct {
	Threshold int              `json:"threshold"`
	Shares    []RecoveryKeyRef `json:"shares"`
}

type RecoveryAttempt struct {
	Quorum             RecoveryQuorum   `json:"quorum"`
	PresentedShareRefs []RecoveryKeyRef `json:"presentedShareRefs"`
}

func (a *RecoveryAttempt) UnmarshalJSON(raw []byte) error {
	type recoveryAttemptJSON RecoveryAttempt
	var decoded recoveryAttemptJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}

	*a = RecoveryAttempt(decoded)
	return nil
}

type TrustedRecoveryShare struct {
	Ref        RecoveryKeyRef
	Passphrase []byte
}

func ValidateRecoveryAttempt(attempt RecoveryAttempt) error {
	_, err := normalizeRecoveryAttempt(attempt)
	return err
}

func DecodeRecoveryAttempt(raw []byte) (RecoveryAttempt, error) {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return RecoveryAttempt{}, err
	}
	if err := rejectInlineRecoverySecretFields(raw); err != nil {
		return RecoveryAttempt{}, err
	}

	var attempt RecoveryAttempt
	if err := jsonsafe.DecodeStrict(raw, &attempt); err != nil {
		return RecoveryAttempt{}, err
	}
	normalized, err := normalizeRecoveryAttempt(attempt)
	if err != nil {
		return RecoveryAttempt{}, err
	}
	return normalized, nil
}

func CombineRecoveryPassphrase(quorum RecoveryQuorum, presented []TrustedRecoveryShare) ([]byte, error) {
	normalizedQuorum, err := normalizeRecoveryQuorum(quorum, "quorum")
	if err != nil {
		return nil, err
	}
	if len(presented) == 0 {
		return nil, &InvalidRequestError{Reason: "presentedShares must contain at least one recovery share"}
	}

	allowed := make(map[string]RecoveryKeyRef, len(normalizedQuorum.Shares))
	for _, share := range normalizedQuorum.Shares {
		allowed[recoveryKeyRefKey(share)] = share
	}

	seen := make(map[string]int, len(presented))
	var passphrase []byte
	matchingShares := 0
	for i, share := range presented {
		ref, err := normalizeRecoveryKeyRef(share.Ref, fmt.Sprintf("presentedShares[%d].ref", i))
		if err != nil {
			return nil, err
		}
		key := recoveryKeyRefKey(ref)
		if previous, ok := seen[key]; ok {
			return nil, &InvalidRequestError{Reason: fmt.Sprintf("presentedShares[%d] duplicates presentedShares[%d]", i, previous)}
		}
		seen[key] = i
		if _, ok := allowed[key]; !ok {
			return nil, &InvalidRequestError{Reason: fmt.Sprintf("presentedShares[%d] is not part of the recovery quorum", i)}
		}
		if len(share.Passphrase) == 0 {
			return nil, &InvalidRequestError{Reason: fmt.Sprintf("presentedShares[%d] has empty recovery passphrase material", i)}
		}
		if passphrase == nil {
			passphrase = cloneBytes(share.Passphrase)
		} else if !bytes.Equal(passphrase, share.Passphrase) {
			return nil, &InvalidRequestError{Reason: fmt.Sprintf("presentedShares[%d] does not reconstruct the same recovery passphrase", i)}
		}
		matchingShares++
	}

	if matchingShares < normalizedQuorum.Threshold {
		return nil, &InvalidRequestError{Reason: fmt.Sprintf("presentedShares must contain at least %d distinct quorum shares", normalizedQuorum.Threshold)}
	}

	return cloneBytes(passphrase), nil
}

func normalizeRecoveryAttempt(attempt RecoveryAttempt) (RecoveryAttempt, error) {
	quorum, err := normalizeRecoveryQuorum(attempt.Quorum, "quorum")
	if err != nil {
		return RecoveryAttempt{}, err
	}
	if len(attempt.PresentedShareRefs) == 0 {
		return RecoveryAttempt{}, &InvalidRequestError{Reason: "presentedShareRefs must contain at least one recovery share reference"}
	}

	allowed := make(map[string]RecoveryKeyRef, len(quorum.Shares))
	for _, share := range quorum.Shares {
		allowed[recoveryKeyRefKey(share)] = share
	}

	refs := make([]RecoveryKeyRef, len(attempt.PresentedShareRefs))
	seen := make(map[string]int, len(attempt.PresentedShareRefs))
	matchingShares := 0
	for i, ref := range attempt.PresentedShareRefs {
		normalizedRef, err := normalizeRecoveryKeyRef(ref, fmt.Sprintf("presentedShareRefs[%d]", i))
		if err != nil {
			return RecoveryAttempt{}, err
		}
		refs[i] = normalizedRef

		key := recoveryKeyRefKey(normalizedRef)
		if previous, ok := seen[key]; ok {
			return RecoveryAttempt{}, &InvalidRequestError{Reason: fmt.Sprintf("presentedShareRefs[%d] duplicates presentedShareRefs[%d]", i, previous)}
		}
		seen[key] = i
		if _, ok := allowed[key]; !ok {
			return RecoveryAttempt{}, &InvalidRequestError{Reason: fmt.Sprintf("presentedShareRefs[%d] is not part of the recovery quorum", i)}
		}
		matchingShares++
	}

	if matchingShares < quorum.Threshold {
		return RecoveryAttempt{}, &InvalidRequestError{Reason: fmt.Sprintf("presentedShareRefs must contain at least %d distinct quorum share references", quorum.Threshold)}
	}

	return RecoveryAttempt{
		Quorum:             quorum,
		PresentedShareRefs: refs,
	}, nil
}

func normalizeRecoveryQuorum(quorum RecoveryQuorum, field string) (RecoveryQuorum, error) {
	if quorum.Threshold < 1 {
		return RecoveryQuorum{}, &InvalidRequestError{Reason: fmt.Sprintf("%s.threshold must be positive", field)}
	}
	if len(quorum.Shares) == 0 {
		return RecoveryQuorum{}, &InvalidRequestError{Reason: fmt.Sprintf("%s.shares must contain at least one recovery share reference", field)}
	}
	if quorum.Threshold > len(quorum.Shares) {
		return RecoveryQuorum{}, &InvalidRequestError{Reason: fmt.Sprintf("%s.threshold must be less than or equal to shares", field)}
	}

	shares := make([]RecoveryKeyRef, len(quorum.Shares))
	seenIDs := make(map[string]int, len(quorum.Shares))
	seenHandles := make(map[string]int, len(quorum.Shares))
	for i, share := range quorum.Shares {
		normalizedShare, err := normalizeRecoveryKeyRef(share, fmt.Sprintf("%s.shares[%d]", field, i))
		if err != nil {
			return RecoveryQuorum{}, err
		}
		if previous, ok := seenIDs[normalizedShare.ID]; ok {
			return RecoveryQuorum{}, &InvalidRequestError{Reason: fmt.Sprintf("%s.shares[%d].id duplicates %s.shares[%d].id", field, i, field, previous)}
		}
		seenIDs[normalizedShare.ID] = i
		if previous, ok := seenHandles[normalizedShare.Handle]; ok {
			return RecoveryQuorum{}, &InvalidRequestError{Reason: fmt.Sprintf("%s.shares[%d].handle duplicates %s.shares[%d].handle", field, i, field, previous)}
		}
		seenHandles[normalizedShare.Handle] = i
		shares[i] = normalizedShare
	}

	return RecoveryQuorum{
		Threshold: quorum.Threshold,
		Shares:    shares,
	}, nil
}

func normalizeRecoveryKeyRef(ref RecoveryKeyRef, field string) (RecoveryKeyRef, error) {
	if err := validateRecoveryRef(ref.ID, field+".id"); err != nil {
		return RecoveryKeyRef{}, err
	}
	if err := validateRecoveryRef(ref.Handle, field+".handle"); err != nil {
		return RecoveryKeyRef{}, err
	}
	if ref.KeyStoreRef != nil {
		if err := validateRecoveryRef(*ref.KeyStoreRef, field+".keyStoreRef"); err != nil {
			return RecoveryKeyRef{}, err
		}
	}

	return RecoveryKeyRef{
		ID:          ref.ID,
		Handle:      ref.Handle,
		KeyStoreRef: cloneStringPtr(ref.KeyStoreRef),
	}, nil
}

var (
	recoveryOpaqueRefPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{2,159}$`)
	recoverySchemePattern           = regexp.MustCompile(`^[a-z][a-z0-9+.-]*$`)
	recoveryControlCharacterPattern = regexp.MustCompile(`[\x00-\x1f\x7f]`)
	recoveryPrivateKeyPattern       = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b`)
	recoverySecretAssignmentPattern = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*[:=]`)
	recoverySeedWordsPattern        = regexp.MustCompile(`(?i)\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b`)
	recoveryLongHexPattern          = regexp.MustCompile(`(?:0x)?[A-Fa-f0-9]{32,}`)
	recoveryLongBase64Pattern       = regexp.MustCompile(`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`)
	recoveryInlineRefSchemes        = map[string]struct{}{
		"data":    {},
		"inline":  {},
		"literal": {},
	}
	recoverySecretFieldNameTokens = map[string]struct{}{
		"apikey":      {},
		"key":         {},
		"keymaterial": {},
		"mnemonic":    {},
		"passphrase":  {},
		"pem":         {},
		"privatekey":  {},
		"recoverykey": {},
		"seed":        {},
		"seedphrase":  {},
		"secret":      {},
	}
)

func validateRecoveryRef(value string, field string) error {
	if value == "" {
		return &InvalidRequestError{Reason: fmt.Sprintf("%s is required", field)}
	}
	if containsInlineRecoverySecretMaterial(value) {
		return &InvalidRequestError{Reason: fmt.Sprintf("%s must not contain inline key material", field)}
	}
	if len(value) > maxRecoveryRefLength || !validRecoveryReferenceSyntax(value) {
		return &InvalidRequestError{Reason: fmt.Sprintf("%s must be an opaque reference", field)}
	}
	return nil
}

func validRecoveryReferenceSyntax(value string) bool {
	if value != strings.TrimSpace(value) || strings.ContainsAny(value, " \t\r\n<>{}`\"'") {
		return false
	}
	if hasInlineRecoveryReferenceScheme(value) {
		return false
	}

	separator := strings.Index(value, "://")
	if separator == -1 {
		return recoveryOpaqueRefPattern.MatchString(value)
	}
	if separator <= 0 || separator == len(value)-3 {
		return false
	}

	scheme := strings.ToLower(value[:separator])
	body := value[separator+3:]
	if _, forbidden := recoveryInlineRefSchemes[scheme]; forbidden {
		return false
	}
	return recoverySchemePattern.MatchString(scheme) && body != ""
}

func hasInlineRecoveryReferenceScheme(value string) bool {
	colon := strings.IndexByte(value, ':')
	if colon <= 0 {
		return false
	}
	scheme := strings.ToLower(value[:colon])
	_, forbidden := recoveryInlineRefSchemes[scheme]
	return forbidden
}

func containsInlineRecoverySecretMaterial(value string) bool {
	if recoveryControlCharacterPattern.MatchString(value) ||
		strings.Contains(strings.ToUpper(value), "-----BEGIN") ||
		recoveryPrivateKeyPattern.MatchString(value) ||
		recoverySecretAssignmentPattern.MatchString(value) ||
		recoverySeedWordsPattern.MatchString(value) {
		return true
	}
	return recoveryLongHexPattern.MatchString(value) || recoveryLongBase64Pattern.MatchString(value)
}

func rejectInlineRecoverySecretFields(raw []byte) error {
	var value interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	return rejectInlineRecoverySecretFieldsValue(value, "")
}

func rejectInlineRecoverySecretFieldsValue(value interface{}, path string) error {
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, child := range typed {
			if isRecoverySecretFieldName(key) {
				return &InvalidRequestError{Reason: fmt.Sprintf("%s must not contain inline key material", joinRecoveryJSONPath(path, key))}
			}
			if err := rejectInlineRecoverySecretFieldsValue(child, joinRecoveryJSONPath(path, key)); err != nil {
				return err
			}
		}
	case []interface{}:
		for i, child := range typed {
			if err := rejectInlineRecoverySecretFieldsValue(child, fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	}
	return nil
}

func isRecoverySecretFieldName(value string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(value, "-", ""), "_", ""))
	_, ok := recoverySecretFieldNameTokens[normalized]
	return ok
}

func joinRecoveryJSONPath(left string, key string) string {
	if left == "" {
		return key
	}
	return left + "." + key
}

func recoveryKeyRefKey(ref RecoveryKeyRef) string {
	keyStoreRef := ""
	if ref.KeyStoreRef != nil {
		keyStoreRef = *ref.KeyStoreRef
	}
	return ref.ID + "\x00" + ref.Handle + "\x00" + keyStoreRef
}
