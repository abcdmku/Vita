package transport

import (
	"context"
	"net/http"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/pdsrepo"
)

// capturingPDSRepo is a stand-in pds.repo capability for the transport routing
// tests. It records the typed request the transport decodes and routes to it so
// the test can prove the PRODUCTION read path (typed ReadRequest on the body)
// reaches the capability, not a divergent URL-query shape.
type capturingPDSRepo struct {
	got capabilities.TypedRequest
}

func (c *capturingPDSRepo) Name() string { return pdsrepo.Name }

func (c *capturingPDSRepo) Handle(_ context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	c.got = req
	return pdsrepo.QueryResponse{
		Exists:     true,
		Collection: "app.bsky.feed.post",
		Records:    []pdsrepo.RepoRecord{},
		Total:      0,
		NextCursor: nil,
	}, nil
}

func newPDSRepoReadHandler(t *testing.T, capability capabilities.Capability) http.Handler {
	t.Helper()

	registry, err := capabilities.NewRegistry(capability)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	handler, err := NewHandler(Config{
		Version:   "test-version",
		StartedAt: transportStartedAt,
		Registry:  registry,
		ReadRequests: map[string]ReadRequestFactory{
			pdsrepo.Name: func() capabilities.TypedRequest { return pdsrepo.ReadRequest{} },
		},
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}
	return handler
}

// TestHandleReadPDSRepoTypedQueryBody proves the PRODUCTION query path: a
// GET /read/pds.repo carrying the typed ReadRequest on the BODY is decoded
// through the same strict typed-JSON path /apply uses and routed to the
// capability as a pdsrepo.ReadRequest with the query populated.
func TestHandleReadPDSRepoTypedQueryBody(t *testing.T) {
	capability := &capturingPDSRepo{}
	handler := newPDSRepoReadHandler(t, capability)

	body := `{"query":{"collection":"app.bsky.feed.post","limit":2,"cursor":0}}`
	response := perform(handler, http.MethodGet, "/read/"+pdsrepo.Name, body)
	if response.Code != http.StatusOK {
		t.Fatalf("read status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}

	readReq, ok := capability.got.(pdsrepo.ReadRequest)
	if !ok {
		t.Fatalf("capability received %T, want pdsrepo.ReadRequest", capability.got)
	}
	if readReq.Query == nil {
		t.Fatal("capability received a whole-repo read; want a typed query")
	}
	if readReq.Query.Collection != "app.bsky.feed.post" {
		t.Fatalf("query collection = %q, want app.bsky.feed.post", readReq.Query.Collection)
	}
	if readReq.Query.Limit != 2 {
		t.Fatalf("query limit = %d, want 2", readReq.Query.Limit)
	}
	if readReq.Query.Cursor == nil || *readReq.Query.Cursor != 0 {
		t.Fatalf("query cursor = %v, want 0", readReq.Query.Cursor)
	}
}

// TestHandleReadPDSRepoWholeRepoNoBody proves the whole-repo read still works:
// an empty body yields the zero-value ReadRequest (no query), so the P1-067
// create/read marker path is preserved.
func TestHandleReadPDSRepoWholeRepoNoBody(t *testing.T) {
	capability := &capturingPDSRepo{}
	handler := newPDSRepoReadHandler(t, capability)

	response := perform(handler, http.MethodGet, "/read/"+pdsrepo.Name, "")
	if response.Code != http.StatusOK {
		t.Fatalf("read status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}

	readReq, ok := capability.got.(pdsrepo.ReadRequest)
	if !ok {
		t.Fatalf("capability received %T, want pdsrepo.ReadRequest", capability.got)
	}
	if readReq.Query != nil {
		t.Fatalf("whole-repo read carried a query: %#v", readReq.Query)
	}
}

// TestHandleReadRejectsURLQueryParameters proves the FAIL-CLOSED surface: any
// URL query parameter on /read/<cap> — including an untrusted/secret-named field
// — is REFUSED, never silently ignored, so it can never bypass validation and
// leak the whole repo state.
func TestHandleReadRejectsURLQueryParameters(t *testing.T) {
	cases := []struct {
		name string
		path string
	}{
		{name: "secret named field", path: "/read/" + pdsrepo.Name + "?privateKey=ref-only"},
		{name: "unexpected field", path: "/read/" + pdsrepo.Name + "?unexpected=1"},
		{name: "known-looking field on URL", path: "/read/" + pdsrepo.Name + "?collection=app.bsky.feed.post&limit=2"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			capability := &capturingPDSRepo{}
			handler := newPDSRepoReadHandler(t, capability)

			response := perform(handler, http.MethodGet, tc.path, "")
			if response.Code != http.StatusBadRequest {
				t.Fatalf("read status = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
			}
			if capability.got != nil {
				t.Fatalf("capability was reached despite URL query parameters: %#v", capability.got)
			}

			var errResponse ErrorResponse
			decodeResponse(t, response, &errResponse)
			if errResponse.Error.Code != "unknown_field" {
				t.Fatalf("error code = %q, want unknown_field", errResponse.Error.Code)
			}
		})
	}
}

// TestHandleReadPDSRepoInvalidQueryBodyRejected proves a malformed typed query
// body fails closed with a 400 (e.g. an over-cap limit), and never reaches the
// capability.
func TestHandleReadPDSRepoInvalidQueryBodyRejected(t *testing.T) {
	capability := &capturingPDSRepo{}
	handler := newPDSRepoReadHandler(t, capability)

	body := `{"query":{"collection":"app.bsky.feed.post","limit":9001}}`
	response := perform(handler, http.MethodGet, "/read/"+pdsrepo.Name, body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("read status = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if capability.got != nil {
		t.Fatalf("capability was reached despite an invalid query body: %#v", capability.got)
	}
}

// TestHandleReadPDSRepoSecretFieldInBodyRejected proves an inline secret-named
// field smuggled into the typed read body is rejected by the same fail-closed
// UnmarshalJSON discipline, never reaching the capability.
func TestHandleReadPDSRepoSecretFieldInBodyRejected(t *testing.T) {
	capability := &capturingPDSRepo{}
	handler := newPDSRepoReadHandler(t, capability)

	body := `{"query":{"collection":"app.bsky.feed.post","limit":2,"privateKey":"ref-only"}}`
	response := perform(handler, http.MethodGet, "/read/"+pdsrepo.Name, body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("read status = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if capability.got != nil {
		t.Fatalf("capability was reached despite a secret-named field: %#v", capability.got)
	}
}
