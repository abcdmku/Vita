package sysdeps

import "testing"

// sysdeps wraps irreversible privileged syscalls, so this test intentionally does
// NOT invoke SetRealtimeClock/SetHostname (that would mutate the test host). It pins
// the package contract: the symbols compile against the vendored golang.org/x/sys on
// Linux (the container test lane) and against the stub elsewhere, and ErrUnsupported
// is defined for the stub paths. Behavioral coverage lives in the capability tests,
// which inject mock facades.
func TestPackageContract(t *testing.T) {
	if ErrUnsupported == nil {
		t.Fatal("ErrUnsupported must be defined")
	}
	// Reference the exported funcs so the build proves they exist with the expected
	// signatures on every platform without executing the privileged effect.
	var _ func(int64, int64) error = SetRealtimeClock
	var _ func() (int64, int64, error) = RealtimeClock
	var _ func(string) error = SetHostname
	var _ func(string, string) error = CreateVeth
	var _ func(string) error = DeleteLink
	var _ func(string, int) error = MoveLinkToNetns
	var _ func(string, string) error = AddIPv4Address
	var _ func(string, string) error = AddDefaultIPv4Route
	var _ func([]byte) error = ApplyNftRuleset
	var _ func(string, string) ([]byte, error) = ListNftTable
	var _ func(string, string) error = DeleteNftTable
}
