package storage

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestCombineRecoveryPassphraseAcceptsThresholdDistinctShares(t *testing.T) {
	passphrase := []byte("vita test recovery passphrase")
	shares := testRecoveryTrustedShares(t, testRecoveryQuorum(2), passphrase)
	got, err := CombineRecoveryPassphrase(testRecoveryQuorum(2), []TrustedRecoveryShare{
		shares[0],
		shares[2],
	})
	if err != nil {
		t.Fatalf("CombineRecoveryPassphrase returned error: %v", err)
	}
	if !bytes.Equal(got, passphrase) {
		t.Fatalf("CombineRecoveryPassphrase = %q, want %q", got, passphrase)
	}

	got[0] = 'X'
	if bytes.Equal(got, passphrase) {
		t.Fatal("CombineRecoveryPassphrase returned caller-mutable passphrase storage")
	}
}

func TestCombineRecoveryPassphraseRejectsBelowThreshold(t *testing.T) {
	shares := testRecoveryTrustedShares(t, testRecoveryQuorum(3), []byte("same passphrase"))
	_, err := CombineRecoveryPassphrase(testRecoveryQuorum(3), []TrustedRecoveryShare{
		shares[0],
		shares[1],
	})
	assertInvalidRecovery(t, err, "at least 3")
}

func TestCombineRecoveryPassphraseRejectsDuplicatePresentedShare(t *testing.T) {
	shares := testRecoveryTrustedShares(t, testRecoveryQuorum(2), []byte("same passphrase"))
	_, err := CombineRecoveryPassphrase(testRecoveryQuorum(2), []TrustedRecoveryShare{
		shares[0],
		shares[0],
	})
	assertInvalidRecovery(t, err, "duplicates")
}

func TestCombineRecoveryPassphraseRejectsForeignShare(t *testing.T) {
	shares := testRecoveryTrustedShares(t, testRecoveryQuorum(2), []byte("same passphrase"))
	foreign := shares[1]
	foreign.Ref = RecoveryKeyRef{ID: "rk:test-foreign", Handle: "rk_test_foreign", KeyStoreRef: stringPtr("keystore:vita-test-recovery")}
	_, err := CombineRecoveryPassphrase(testRecoveryQuorum(2), []TrustedRecoveryShare{
		shares[0],
		foreign,
	})
	assertInvalidRecovery(t, err, "not part of the recovery quorum")
}

func TestCombineRecoveryPassphraseRejectsMismatchedFragmentLength(t *testing.T) {
	shares := testRecoveryTrustedShares(t, testRecoveryQuorum(2), []byte("same passphrase"))
	shares[1].Fragment = shares[1].Fragment[:len(shares[1].Fragment)-1]
	_, err := CombineRecoveryPassphrase(testRecoveryQuorum(2), []TrustedRecoveryShare{
		shares[0],
		shares[1],
	})
	assertInvalidRecovery(t, err, "fragment length")
}

func TestValidateRecoveryAttemptMirrorsQuorumSemantics(t *testing.T) {
	attempt := RecoveryAttempt{
		Quorum:             testRecoveryQuorum(2),
		PresentedShareRefs: []RecoveryKeyRef{testRecoveryRef(2), testRecoveryRef(3)},
	}
	if err := ValidateRecoveryAttempt(attempt); err != nil {
		t.Fatalf("ValidateRecoveryAttempt returned error: %v", err)
	}

	tests := []struct {
		name    string
		attempt RecoveryAttempt
		want    string
	}{
		{
			name: "below threshold",
			attempt: RecoveryAttempt{
				Quorum:             testRecoveryQuorum(2),
				PresentedShareRefs: []RecoveryKeyRef{testRecoveryRef(1)},
			},
			want: "at least 2",
		},
		{
			name: "duplicate presented ref",
			attempt: RecoveryAttempt{
				Quorum:             testRecoveryQuorum(2),
				PresentedShareRefs: []RecoveryKeyRef{testRecoveryRef(1), testRecoveryRef(1)},
			},
			want: "duplicates",
		},
		{
			name: "foreign presented ref",
			attempt: RecoveryAttempt{
				Quorum: testRecoveryQuorum(2),
				PresentedShareRefs: []RecoveryKeyRef{
					testRecoveryRef(1),
					{ID: "rk:test-foreign", Handle: "rk_test_foreign", KeyStoreRef: stringPtr("keystore:vita-test-recovery")},
				},
			},
			want: "not part of the recovery quorum",
		},
		{
			name: "threshold above share count",
			attempt: RecoveryAttempt{
				Quorum: RecoveryQuorum{
					Threshold: 4,
					Shares:    []RecoveryKeyRef{testRecoveryRef(1), testRecoveryRef(2), testRecoveryRef(3)},
				},
				PresentedShareRefs: []RecoveryKeyRef{testRecoveryRef(1), testRecoveryRef(2), testRecoveryRef(3)},
			},
			want: "less than or equal to shares",
		},
		{
			name: "duplicate quorum id",
			attempt: RecoveryAttempt{
				Quorum: RecoveryQuorum{
					Threshold: 2,
					Shares: []RecoveryKeyRef{
						testRecoveryRef(1),
						{ID: testRecoveryRef(1).ID, Handle: "rk_test_share_2", KeyStoreRef: stringPtr("keystore:vita-test-recovery")},
					},
				},
				PresentedShareRefs: []RecoveryKeyRef{testRecoveryRef(1), testRecoveryRef(2)},
			},
			want: "duplicates",
		},
		{
			name: "duplicate quorum handle",
			attempt: RecoveryAttempt{
				Quorum: RecoveryQuorum{
					Threshold: 2,
					Shares: []RecoveryKeyRef{
						testRecoveryRef(1),
						{ID: "rk:test-share-2", Handle: testRecoveryRef(1).Handle, KeyStoreRef: stringPtr("keystore:vita-test-recovery")},
					},
				},
				PresentedShareRefs: []RecoveryKeyRef{testRecoveryRef(1), testRecoveryRef(2)},
			},
			want: "duplicates",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertInvalidRecovery(t, ValidateRecoveryAttempt(tt.attempt), tt.want)
		})
	}
}

func TestDecodeRecoveryAttemptRejectsInlineSecretMaterial(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "secret field name",
			raw:  `{"quorum":{"threshold":1,"shares":[{"id":"rk:test-share-1","handle":"rk_test_share_1"}]},"presentedShareRefs":[{"id":"rk:test-share-1","handle":"rk_test_share_1"}],"passphrase":"do-not-inline"}`,
			want: "inline key material",
		},
		{
			name: "pem in ref",
			raw:  `{"quorum":{"threshold":1,"shares":[{"id":"-----BEGIN PRIVATE KEY-----","handle":"rk_test_share_1"}]},"presentedShareRefs":[{"id":"-----BEGIN PRIVATE KEY-----","handle":"rk_test_share_1"}]}`,
			want: "inline key material",
		},
		{
			name: "long base64 in ref",
			raw:  `{"quorum":{"threshold":1,"shares":[{"id":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","handle":"rk_test_share_1"}]},"presentedShareRefs":[{"id":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","handle":"rk_test_share_1"}]}`,
			want: "inline key material",
		},
		{
			name: "duplicate object key",
			raw:  `{"quorum":{"threshold":1,"shares":[{"id":"rk:test-share-1","id":"rk:test-share-2","handle":"rk_test_share_1"}]},"presentedShareRefs":[{"id":"rk:test-share-1","handle":"rk_test_share_1"}]}`,
			want: "duplicate JSON object key",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := DecodeRecoveryAttempt([]byte(tt.raw))
			if err == nil {
				t.Fatal("DecodeRecoveryAttempt returned nil, want rejection")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("DecodeRecoveryAttempt error = %v, want containing %q", err, tt.want)
			}
		})
	}
}

func testRecoveryQuorum(threshold int) RecoveryQuorum {
	return RecoveryQuorum{
		Threshold: threshold,
		Shares: []RecoveryKeyRef{
			testRecoveryRef(1),
			testRecoveryRef(2),
			testRecoveryRef(3),
		},
	}
}

func testRecoveryTrustedShares(t *testing.T, quorum RecoveryQuorum, passphrase []byte) []TrustedRecoveryShare {
	t.Helper()
	shares := make([]TrustedRecoveryShare, len(quorum.Shares))
	for i, ref := range quorum.Shares {
		x := byte(i + 1)
		fragment := make([]byte, len(passphrase))
		for j, secretByte := range passphrase {
			y := secretByte
			power := x
			for degree := 1; degree < quorum.Threshold; degree++ {
				coefficient := byte((j + 1 + degree*17) % 255)
				if coefficient == 0 {
					coefficient = 1
				}
				y ^= recoveryGFMul(coefficient, power)
				power = recoveryGFMul(power, x)
			}
			fragment[j] = y
		}
		shares[i] = TrustedRecoveryShare{
			Ref:      ref,
			Index:    x,
			Fragment: fragment,
		}
	}
	return shares
}

func testRecoveryRef(index int) RecoveryKeyRef {
	return RecoveryKeyRef{
		ID:          fmt.Sprintf("rk:test-share-%d", index),
		Handle:      fmt.Sprintf("rk_test_share_%d", index),
		KeyStoreRef: stringPtr("keystore:vita-test-recovery"),
	}
}

func assertInvalidRecovery(t *testing.T, err error, want string) {
	t.Helper()
	var invalid *InvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("error = %T %v, want InvalidRequestError", err, err)
	}
	if !strings.Contains(invalid.Reason, want) {
		t.Fatalf("InvalidRequestError reason = %q, want containing %q", invalid.Reason, want)
	}
}
