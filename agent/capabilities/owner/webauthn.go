package owner

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"net/url"

	"github.com/vita/agent/internal/jsonsafe"
)

const (
	webauthnGetType = "webauthn.get"

	authenticatorDataMinLength = 37
	authenticatorFlagUP        = 0x01

	coseKeyTypeOKP = 1
	coseKeyTypeEC2 = 2
	coseAlgES256   = -7
	coseAlgEdDSA   = -8
	coseCrvP256    = 1
	coseCrvEd25519 = 6
)

type clientData struct {
	Type      string
	Challenge string
	Origin    string
}

type clientDataJSON struct {
	Type      *string `json:"type"`
	Challenge *string `json:"challenge"`
	Origin    *string `json:"origin"`
}

type parsedPublicKey struct {
	alg        int64
	ecdsaKey   *ecdsa.PublicKey
	ed25519Key ed25519.PublicKey
}

type coseKeyFields struct {
	kty int64
	alg int64
	crv int64
	x   []byte
	y   []byte

	hasKTY bool
	hasAlg bool
	hasCrv bool
	hasX   bool
	hasY   bool
}

func parseClientData(raw []byte) (clientData, error) {
	var decoded clientDataJSON
	if err := jsonsafeDecodeClientData(raw, &decoded); err != nil {
		return clientData{}, err
	}
	if decoded.Type == nil || decoded.Challenge == nil || decoded.Origin == nil {
		return clientData{}, errors.New("missing client data field")
	}
	return clientData{
		Type:      *decoded.Type,
		Challenge: *decoded.Challenge,
		Origin:    *decoded.Origin,
	}, nil
}

func jsonsafeDecodeClientData(raw []byte, target interface{}) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return errors.New("empty client data")
	}
	if len(raw) > maxClientDataJSONBytes {
		return errors.New("client data too large")
	}
	return jsonsafe.DecodeStrict(raw, target)
}

func originMatchesRPID(origin, rpID string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsed.Scheme == "https" &&
		parsed.User == nil &&
		parsed.Hostname() == rpID &&
		(parsed.Path == "" || parsed.Path == "/") &&
		parsed.RawQuery == "" &&
		parsed.Fragment == ""
}

func verifyWebAuthnAssertion(credential OwnerCredential, authenticatorData, clientDataJSONBytes, signature []byte) (uint32, string, bool) {
	if len(authenticatorData) < authenticatorDataMinLength {
		return 0, denyInvalidRequest, false
	}

	rpIDHash := sha256.Sum256([]byte(credential.RPID))
	if !bytes.Equal(authenticatorData[:32], rpIDHash[:]) {
		return 0, denyRPIDHashMismatch, false
	}
	if authenticatorData[32]&authenticatorFlagUP == 0 {
		return 0, denyUserPresenceRequired, false
	}

	signCount := binary.BigEndian.Uint32(authenticatorData[33:37])
	publicKeyCOSE, err := base64.RawURLEncoding.DecodeString(credential.PublicKeyCOSE)
	if err != nil {
		return 0, denyUnparseablePublicKey, false
	}
	publicKey, err := parseCOSEPublicKey(publicKeyCOSE)
	if err != nil {
		return 0, denyUnparseablePublicKey, false
	}

	clientHash := sha256.Sum256(clientDataJSONBytes)
	signed := make([]byte, 0, len(authenticatorData)+len(clientHash))
	signed = append(signed, authenticatorData...)
	signed = append(signed, clientHash[:]...)

	switch publicKey.alg {
	case coseAlgES256:
		digest := sha256.Sum256(signed)
		if publicKey.ecdsaKey == nil || !ecdsa.VerifyASN1(publicKey.ecdsaKey, digest[:], signature) {
			return 0, denyInvalidSignature, false
		}
	case coseAlgEdDSA:
		if publicKey.ed25519Key == nil || !ed25519.Verify(publicKey.ed25519Key, signed, signature) {
			return 0, denyInvalidSignature, false
		}
	default:
		return 0, denyUnparseablePublicKey, false
	}

	return signCount, "", true
}

func parseCOSEPublicKey(raw []byte) (parsedPublicKey, error) {
	reader := cborReader{data: raw}
	fields, err := reader.readCOSEKey()
	if err != nil {
		return parsedPublicKey{}, err
	}
	if !reader.done() {
		return parsedPublicKey{}, errors.New("trailing COSE bytes")
	}

	if fields.kty == coseKeyTypeEC2 {
		return parseCOSEEC2(fields)
	}
	if fields.kty == coseKeyTypeOKP {
		return parseCOSEOKP(fields)
	}
	return parsedPublicKey{}, errors.New("unsupported COSE key type")
}

func parseCOSEEC2(fields coseKeyFields) (parsedPublicKey, error) {
	if !fields.hasKTY ||
		!fields.hasAlg ||
		!fields.hasCrv ||
		!fields.hasX ||
		!fields.hasY ||
		fields.alg != coseAlgES256 ||
		fields.crv != coseCrvP256 ||
		len(fields.x) != 32 ||
		len(fields.y) != 32 {
		return parsedPublicKey{}, errors.New("unsupported EC2 COSE key")
	}

	x := new(big.Int).SetBytes(fields.x)
	y := new(big.Int).SetBytes(fields.y)
	curve := elliptic.P256()
	if !curve.IsOnCurve(x, y) {
		return parsedPublicKey{}, errors.New("EC2 point is not on P-256")
	}

	return parsedPublicKey{
		alg: coseAlgES256,
		ecdsaKey: &ecdsa.PublicKey{
			Curve: curve,
			X:     x,
			Y:     y,
		},
	}, nil
}

func parseCOSEOKP(fields coseKeyFields) (parsedPublicKey, error) {
	if !fields.hasKTY ||
		!fields.hasAlg ||
		!fields.hasCrv ||
		!fields.hasX ||
		fields.hasY ||
		fields.alg != coseAlgEdDSA ||
		fields.crv != coseCrvEd25519 ||
		len(fields.x) != ed25519.PublicKeySize {
		return parsedPublicKey{}, errors.New("unsupported OKP COSE key")
	}

	return parsedPublicKey{
		alg:        coseAlgEdDSA,
		ed25519Key: ed25519.PublicKey(cloneBytes(fields.x)),
	}, nil
}

type cborReader struct {
	data []byte
	off  int
}

func (r *cborReader) readCOSEKey() (coseKeyFields, error) {
	major, count, err := r.readHeader()
	if err != nil {
		return coseKeyFields{}, err
	}
	if major != 5 {
		return coseKeyFields{}, errors.New("COSE key must be a CBOR map")
	}
	if count > 16 {
		return coseKeyFields{}, errors.New("COSE key map too large")
	}

	fields := coseKeyFields{}
	seen := make(map[int64]struct{}, count)
	for i := uint64(0); i < count; i++ {
		label, err := r.readInt()
		if err != nil {
			return coseKeyFields{}, err
		}
		if _, exists := seen[label]; exists {
			return coseKeyFields{}, fmt.Errorf("duplicate COSE label %d", label)
		}
		seen[label] = struct{}{}

		switch label {
		case 1:
			value, err := r.readInt()
			if err != nil {
				return coseKeyFields{}, err
			}
			fields.kty = value
			fields.hasKTY = true
		case 3:
			value, err := r.readInt()
			if err != nil {
				return coseKeyFields{}, err
			}
			fields.alg = value
			fields.hasAlg = true
		case -1:
			value, err := r.readInt()
			if err != nil {
				return coseKeyFields{}, err
			}
			fields.crv = value
			fields.hasCrv = true
		case -2:
			value, err := r.readBytes()
			if err != nil {
				return coseKeyFields{}, err
			}
			fields.x = value
			fields.hasX = true
		case -3:
			value, err := r.readBytes()
			if err != nil {
				return coseKeyFields{}, err
			}
			fields.y = value
			fields.hasY = true
		default:
			return coseKeyFields{}, fmt.Errorf("unsupported COSE label %d", label)
		}
	}

	return fields, nil
}

func (r *cborReader) readInt() (int64, error) {
	major, value, err := r.readHeader()
	if err != nil {
		return 0, err
	}
	switch major {
	case 0:
		if value > uint64(^uint64(0)>>1) {
			return 0, errors.New("CBOR unsigned integer too large")
		}
		return int64(value), nil
	case 1:
		if value > uint64(^uint64(0)>>1) {
			return 0, errors.New("CBOR negative integer too small")
		}
		return -1 - int64(value), nil
	default:
		return 0, errors.New("CBOR value must be an integer")
	}
}

func (r *cborReader) readBytes() ([]byte, error) {
	major, length, err := r.readHeader()
	if err != nil {
		return nil, err
	}
	if major != 2 {
		return nil, errors.New("CBOR value must be bytes")
	}
	if length > uint64(len(r.data)-r.off) {
		return nil, errors.New("truncated CBOR bytes")
	}
	start := r.off
	r.off += int(length)
	return cloneBytes(r.data[start:r.off]), nil
}

func (r *cborReader) readHeader() (byte, uint64, error) {
	if r.off >= len(r.data) {
		return 0, 0, errors.New("truncated CBOR value")
	}
	initial := r.data[r.off]
	r.off++
	major := initial >> 5
	additional := initial & 0x1f

	switch {
	case additional < 24:
		return major, uint64(additional), nil
	case additional == 24:
		if r.off >= len(r.data) {
			return 0, 0, errors.New("truncated CBOR uint8")
		}
		value := r.data[r.off]
		r.off++
		return major, uint64(value), nil
	case additional == 25:
		if len(r.data)-r.off < 2 {
			return 0, 0, errors.New("truncated CBOR uint16")
		}
		value := binary.BigEndian.Uint16(r.data[r.off : r.off+2])
		r.off += 2
		return major, uint64(value), nil
	case additional == 26:
		if len(r.data)-r.off < 4 {
			return 0, 0, errors.New("truncated CBOR uint32")
		}
		value := binary.BigEndian.Uint32(r.data[r.off : r.off+4])
		r.off += 4
		return major, uint64(value), nil
	case additional == 27:
		if len(r.data)-r.off < 8 {
			return 0, 0, errors.New("truncated CBOR uint64")
		}
		value := binary.BigEndian.Uint64(r.data[r.off : r.off+8])
		r.off += 8
		return major, value, nil
	default:
		return 0, 0, errors.New("indefinite CBOR values are not accepted")
	}
}

func (r *cborReader) done() bool {
	return r.off == len(r.data)
}
