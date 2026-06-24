package pdsrepo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

const (
	validRepoDID     = "did:plc:ewvi7nxzyoun6zhxrhs64oiz"
	validWebRepoDID  = "did:web:alice.example.com"
	firstDigest      = "1111111111111111111111111111111111111111111111111111111111111111"
	secondDigest     = "2222222222222222222222222222222222222222222222222222222222222222"
	conflictDigest   = "3333333333333333333333333333333333333333333333333333333333333333"
	thirdDigest      = "4444444444444444444444444444444444444444444444444444444444444444"
	attackerContents = "attacker-controlled"
)

var (
	errSimulatedWrite = errors.New("simulated write failure")
	errSimulatedApply = errors.New("simulated apply failure")
)

func TestApplyPersistsRecordsAdvancesCursorAndReadReturnsCanonicalState(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)
	desired := desiredState(42, []RepoRecord{
		profileRecord(),
		postRecord(),
	})

	undo, err := capability.Apply(ctx, applyState(desired))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	want := RepoState{
		Repo:         validRepoDID,
		Records:      []RepoRecord{profileRecord(), postRecord()},
		CommitCursor: 42,
		Log: []CommitLogEntry{
			logEntry(42, profileRecord()),
			logEntry(42, postRecord()),
		},
	}
	sortRepoState(&want)
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderRepoState(want)) {
		t.Fatalf("live PDS repo state = %q, want canonical %q", got, renderRepoState(want))
	}

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse, ok := response.(ReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ReadResponse", response)
	}
	if !readResponse.Exists {
		t.Fatal("ReadResponse.Exists = false, want true")
	}
	if readResponse.Repo != validRepoDID {
		t.Fatalf("ReadResponse.Repo = %q, want %q", readResponse.Repo, validRepoDID)
	}
	if readResponse.CommitCursor != 42 {
		t.Fatalf("ReadResponse.CommitCursor = %d, want 42", readResponse.CommitCursor)
	}
	if !reflect.DeepEqual(readResponse.Records, want.Records) {
		t.Fatalf("ReadResponse.Records = %#v, want %#v", readResponse.Records, want.Records)
	}
	if !reflect.DeepEqual(readResponse.Log, want.Log) {
		t.Fatalf("ReadResponse.Log = %#v, want %#v", readResponse.Log, want.Log)
	}
}

func TestApplyDeleteRemovesActiveRecordAppendsTombstoneAndReadReturnsCanonicalState(t *testing.T) {
	ctx := context.Background()
	priorRecords := []RepoRecord{profileRecord(), postRecord()}
	prior := renderRepoState(repoState(42, priorRecords))
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)
	desired := deleteDesiredState(43, deleteFromRecord(postRecord()))

	undo, err := capability.Apply(ctx, applyState(desired))
	if err != nil {
		t.Fatalf("Apply delete returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply delete returned nil undo")
	}

	want := RepoState{
		Repo:         validRepoDID,
		Records:      []RepoRecord{profileRecord()},
		CommitCursor: 43,
		Log: append(
			logEntriesForRecords(42, priorRecords),
			deleteLogEntry(43, deleteFromRecord(postRecord())),
		),
	}
	sortRepoState(&want)
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderRepoState(want)) {
		t.Fatalf("live PDS repo state after delete = %q, want canonical %q", got, renderRepoState(want))
	}

	parsed, err := parseRepoState(fs.mustLiveBytes(t))
	if err != nil {
		t.Fatalf("parseRepoState after delete returned error: %v", err)
	}
	if !reflect.DeepEqual(parsed, want) {
		t.Fatalf("parsed canonical state = %#v, want %#v", parsed, want)
	}

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse, ok := response.(ReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ReadResponse", response)
	}
	if readResponse.CommitCursor != 43 {
		t.Fatalf("ReadResponse.CommitCursor = %d, want 43", readResponse.CommitCursor)
	}
	if containsRecord(readResponse.Records, recordKeyFromRecord(postRecord())) {
		t.Fatalf("ReadResponse.Records contains deleted record: %#v", readResponse.Records)
	}
	if !containsLogEntry(readResponse.Log, deleteRecordOp, 43, recordKeyFromRecord(postRecord())) {
		t.Fatalf("ReadResponse.Log missing delete tombstone: %#v", readResponse.Log)
	}
}

func TestHandleReadsCanonicalValidatedStateNotOriginalRawOrdering(t *testing.T) {
	ctx := context.Background()
	state := RepoState{
		Repo:         validRepoDID,
		Records:      []RepoRecord{postRecord(), profileRecord()},
		CommitCursor: 42,
		Log: []CommitLogEntry{
			logEntry(42, postRecord()),
			logEntry(42, profileRecord()),
		},
	}
	raw := []byte(`{"log":[{"rkey":"p1-067-post","op":"create-record","cursor":42,"collection":"app.bsky.feed.post"},{"rkey":"self","op":"create-record","cursor":42,"collection":"app.bsky.actor.profile"}],"commitCursor":42,"records":[{"valueDigest":"` + firstDigest + `","rkey":"p1-067-post","collection":"app.bsky.feed.post"},{"valueDigest":"` + secondDigest + `","rkey":"self","collection":"app.bsky.actor.profile"}],"repo":"` + validRepoDID + `"}` + "\n")
	fs := newMemoryFileSystem(raw)
	capability := newCapability(fs)

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ReadResponse)
	sortRepoState(&state)
	if !reflect.DeepEqual(readResponse.Records, state.Records) {
		t.Fatalf("ReadResponse.Records = %#v, want canonical %#v", readResponse.Records, state.Records)
	}
	if bytes.Equal(raw, renderRepoState(state)) {
		t.Fatal("test raw state unexpectedly matched canonical rendering")
	}
}

func TestQueryRecordsByCollectionPagedDeterministicAndExcludesDeletedRecords(t *testing.T) {
	ctx := context.Background()
	feedA := feedRecord("aaa", firstDigest)
	feedB := feedRecord("bbb", conflictDigest)
	feedC := feedRecord("ccc", thirdDigest)
	prior := RepoState{
		Repo:         validRepoDID,
		Records:      []RepoRecord{feedC, profileRecord(), feedA},
		CommitCursor: 50,
		Log: append(
			logEntriesForRecords(42, []RepoRecord{feedA, feedB, feedC, profileRecord()}),
			deleteLogEntry(50, deleteFromRecord(feedB)),
		),
	}
	sortRepoState(&prior)
	fs := newMemoryFileSystem(renderRepoState(prior))
	capability := newCapability(fs)

	response, err := capability.Handle(ctx, ReadRequest{Query: &QueryRequest{
		Collection: "app.bsky.feed.post",
		Limit:      maxPageLimit,
	}})
	if err != nil {
		t.Fatalf("Handle query page 1 returned error: %v", err)
	}
	firstPage, ok := response.(QueryResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want QueryResponse", response)
	}
	if !firstPage.Exists {
		t.Fatal("QueryResponse.Exists = false, want true")
	}
	if firstPage.Collection != "app.bsky.feed.post" {
		t.Fatalf("QueryResponse.Collection = %q", firstPage.Collection)
	}
	if firstPage.Total != 2 {
		t.Fatalf("QueryResponse.Total = %d, want 2", firstPage.Total)
	}
	if firstPage.NextCursor != nil {
		t.Fatalf("QueryResponse.NextCursor = %v, want nil for terminal first page", *firstPage.NextCursor)
	}
	if !reflect.DeepEqual(firstPage.Records, []RepoRecord{feedA, feedC}) {
		t.Fatalf("QueryResponse.Records = %#v, want sorted active feed records", firstPage.Records)
	}

	// Add one more active feed record so the fixed page cap forces a second page.
	feedD := feedRecord("ddd", secondDigest)
	_, err = capability.Apply(ctx, applyState(desiredState(51, []RepoRecord{feedD})))
	if err != nil {
		t.Fatalf("Apply extra feed record returned error: %v", err)
	}

	response, err = capability.Handle(ctx, ReadRequest{Query: &QueryRequest{
		Collection: "app.bsky.feed.post",
		Limit:      maxPageLimit,
	}})
	if err != nil {
		t.Fatalf("Handle query paged page 1 returned error: %v", err)
	}
	firstPage = response.(QueryResponse)
	if firstPage.NextCursor == nil || *firstPage.NextCursor != maxPageLimit {
		t.Fatalf("QueryResponse.NextCursor = %v, want %d", firstPage.NextCursor, maxPageLimit)
	}
	if !reflect.DeepEqual(firstPage.Records, []RepoRecord{feedA, feedC}) {
		t.Fatalf("QueryResponse first page records = %#v", firstPage.Records)
	}

	response, err = capability.Handle(ctx, ReadRequest{Query: &QueryRequest{
		Collection: "app.bsky.feed.post",
		Cursor:     firstPage.NextCursor,
		Limit:      maxPageLimit,
	}})
	if err != nil {
		t.Fatalf("Handle query page 2 returned error: %v", err)
	}
	secondPage := response.(QueryResponse)
	if secondPage.NextCursor != nil {
		t.Fatalf("second page NextCursor = %v, want nil", *secondPage.NextCursor)
	}
	if !reflect.DeepEqual(secondPage.Records, []RepoRecord{feedD}) {
		t.Fatalf("second page Records = %#v, want %#v", secondPage.Records, []RepoRecord{feedD})
	}

	terminalCursor := int64(3)
	response, err = capability.Handle(ctx, ReadRequest{Query: &QueryRequest{
		Collection: "app.bsky.feed.post",
		Cursor:     &terminalCursor,
		Limit:      maxPageLimit,
	}})
	if err != nil {
		t.Fatalf("Handle terminal cursor returned error: %v", err)
	}
	terminalPage := response.(QueryResponse)
	if len(terminalPage.Records) != 0 || terminalPage.NextCursor != nil {
		t.Fatalf("terminal page = %#v, want empty records and no next cursor", terminalPage)
	}
}

func TestApplyWritesAndUndoRestoresExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := []byte(`{"log":[{"rkey":"p1-067-post","op":"create-record","cursor":42,"collection":"app.bsky.feed.post"}],"commitCursor":42,"records":[{"valueDigest":"` + firstDigest + `","rkey":"p1-067-post","collection":"app.bsky.feed.post"}],"repo":"` + validRepoDID + `"}` + "\n")
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyState(desiredState(43, []RepoRecord{profileRecord()})))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS repo state after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorState(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyState(desiredState(42, []RepoRecord{postRecord()})))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live PDS repo state")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live PDS repo state %q, want absent", fs.live)
	}
}

func TestIdenticalReapplyIsIdempotentNoOpConverge(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)
	req := applyState(desiredState(42, []RepoRecord{postRecord(), profileRecord()}))

	if _, err := capability.Apply(ctx, req); err != nil {
		t.Fatalf("first Apply returned error: %v", err)
	}
	afterFirst := fs.mustLiveBytes(t)
	writesAfterFirst := fs.atomicWrites

	undo, err := capability.Apply(ctx, req)
	if err != nil {
		t.Fatalf("second Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("second Apply returned nil undo")
	}
	if fs.atomicWrites != writesAfterFirst {
		t.Fatalf("second Apply performed %d atomic writes, want no-op count %d", fs.atomicWrites, writesAfterFirst)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, afterFirst) {
		t.Fatalf("live PDS repo state after idempotent Apply = %q, want unchanged %q", got, afterFirst)
	}
}

func TestApplyRejectsInvalidRequestsFailClosed(t *testing.T) {
	ctx := context.Background()
	prior := renderRepoState(repoState(100, []RepoRecord{postRecord(), profileRecord()}))

	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: desiredState(101, []RepoRecord{profileRecord()})},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
		{
			name: "malformed DID",
			req:  applyState(withRepo(desiredState(101, []RepoRecord{profileRecord()}), "did:key:z6mnot-supported")),
		},
		{
			name: "cursor above max safe integer",
			req:  applyState(withCommitCursor(desiredState(9007199254740992, []RepoRecord{profileRecord()}), 9007199254740992)),
		},
		{
			name: "regressing cursor",
			req:  applyState(desiredState(99, []RepoRecord{profileRecord()})),
		},
		{
			name: "conflicting record",
			req: applyState(desiredState(101, []RepoRecord{
				withDigest(postRecord(), conflictDigest),
			})),
		},
		{
			name: "duplicate record key in request",
			req: applyState(desiredState(101, []RepoRecord{
				profileRecord(),
				profileRecord(),
			})),
		},
		{
			name: "cursor advance without new records",
			req:  applyState(desiredState(101, []RepoRecord{postRecord()})),
		},
		{
			name: "delete with regressing cursor",
			req:  applyState(deleteDesiredState(99, deleteFromRecord(postRecord()))),
		},
		{
			name: "delete with non advancing cursor",
			req:  applyState(deleteDesiredState(100, deleteFromRecord(postRecord()))),
		},
		{
			name: "delete non-existent record is typed reject",
			req:  applyState(deleteDesiredState(101, DeleteRecord{Collection: "app.bsky.feed.post", RKey: "missing"})),
		},
		{
			name: "create and delete same key conflicts",
			req: applyState(DesiredState{
				Repo:    validRepoDID,
				Commit:  Commit{Cursor: 101},
				Records: []RepoRecord{postRecord()},
				Deletes: []DeleteRecord{deleteFromRecord(postRecord())},
			}),
		},
		{
			name: "duplicate delete keys conflict",
			req: applyState(DesiredState{
				Repo:    validRepoDID,
				Commit:  Commit{Cursor: 101},
				Records: []RepoRecord{},
				Deletes: []DeleteRecord{
					deleteFromRecord(postRecord()),
					deleteFromRecord(postRecord()),
				},
			}),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newMemoryFileSystem(prior)
			capability := newCapability(fs)

			undo, err := capability.Apply(ctx, tt.req)
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if fs.atomicWrites != 0 {
				t.Fatalf("AtomicWrite count = %d, want 0", fs.atomicWrites)
			}
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
				t.Fatalf("live PDS repo state = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestQueryRejectsInvalidRequestsFailClosed(t *testing.T) {
	ctx := context.Background()
	prior := renderRepoState(repoState(100, []RepoRecord{postRecord(), profileRecord()}))
	pastEnd := int64(2)
	negativeCursor := int64(-1)
	tooLargeCursor := int64(9007199254740992)

	tests := []struct {
		name string
		req  ReadRequest
	}{
		{
			name: "zero limit",
			req: ReadRequest{Query: &QueryRequest{
				Collection: "app.bsky.feed.post",
				Limit:      0,
			}},
		},
		{
			name: "negative limit",
			req: ReadRequest{Query: &QueryRequest{
				Collection: "app.bsky.feed.post",
				Limit:      -1,
			}},
		},
		{
			name: "over max limit",
			req: ReadRequest{Query: &QueryRequest{
				Collection: "app.bsky.feed.post",
				Limit:      maxPageLimit + 1,
			}},
		},
		{
			name: "negative cursor",
			req: ReadRequest{Query: &QueryRequest{
				Collection: "app.bsky.feed.post",
				Cursor:     &negativeCursor,
				Limit:      maxPageLimit,
			}},
		},
		{
			name: "out of range cursor",
			req: ReadRequest{Query: &QueryRequest{
				Collection: "app.bsky.feed.post",
				Cursor:     &tooLargeCursor,
				Limit:      maxPageLimit,
			}},
		},
		{
			name: "cursor past end",
			req: ReadRequest{Query: &QueryRequest{
				Collection: "app.bsky.feed.post",
				Cursor:     &pastEnd,
				Limit:      maxPageLimit,
			}},
		},
		{
			name: "malformed collection",
			req: ReadRequest{Query: &QueryRequest{
				Collection: "app..bsky/feed.post",
				Limit:      maxPageLimit,
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newMemoryFileSystem(prior)
			capability := newCapability(fs)

			response, err := capability.Handle(ctx, tt.req)
			if response != nil {
				t.Fatalf("Handle returned response %#v, want nil", response)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Handle error = %T %v, want InvalidRequestError", err, err)
			}
			if fs.atomicWrites != 0 {
				t.Fatalf("AtomicWrite count = %d, want 0", fs.atomicWrites)
			}
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
				t.Fatalf("live PDS repo state = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestRawJSONDecodeRejectsFailClosedRequestShapes(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "duplicate top-level desired",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":42},"records":[` + postRecordJSON() + `]},"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":43},"records":[` + profileRecordJSON() + `]}}`,
			want: "duplicate JSON object key",
		},
		{
			name: "unknown field",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":42},"records":[` + postRecordJSON() + `],"extra":true}}`,
			want: "unknown field",
		},
		{
			name: "inline-secret-named field",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":42},"records":[` + postRecordJSON() + `],"privateKey":"ref-only"}}`,
			want: "inline key material",
		},
		{
			name: "bad DID",
			raw:  `{"desired":{"repo":"did:key:z6mnot-supported","commit":{"cursor":42},"records":[` + postRecordJSON() + `]}}`,
			want: "supported did:plc or did:web",
		},
		{
			name: "float cursor",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":1.0},"records":[` + postRecordJSON() + `]}}`,
			want: "monotonic integer",
		},
		{
			name: "exponent cursor",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":1e3},"records":[` + postRecordJSON() + `]}}`,
			want: "monotonic integer",
		},
		{
			name: "out-of-range cursor",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":9007199254740992},"records":[` + postRecordJSON() + `]}}`,
			want: "monotonic integer",
		},
		{
			name: "delete unknown field",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":43},"records":[],"deletes":[{"collection":"app.bsky.feed.post","rkey":"p1-067-post","extra":true}]}}`,
			want: "unknown field",
		},
		{
			name: "delete inline-secret-named field",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":43},"records":[],"deletes":[{"collection":"app.bsky.feed.post","rkey":"p1-067-post","privateKey":"ref-only"}]}}`,
			want: "inline key material",
		},
		{
			name: "delete duplicate JSON object key",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","commit":{"cursor":43},"records":[],"deletes":[{"collection":"app.bsky.feed.post","rkey":"-----BEGIN PRIVATE KEY-----","rkey":"p1-067-post"}]}}`,
			want: "duplicate JSON object key",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ApplyRequest
			err := json.Unmarshal([]byte(tt.raw), &req)
			if err == nil {
				err = req.Validate()
			}
			if err == nil {
				t.Fatal("decode/Validate returned nil, want fail-closed rejection")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("decode/Validate error = %v, want substring %q", err, tt.want)
			}
		})
	}
}

func TestRawJSONDecodeRejectsFailClosedReadQueryShapes(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "unknown read field",
			raw:  `{"query":{"collection":"app.bsky.feed.post","limit":2},"extra":true}`,
			want: "unknown field",
		},
		{
			name: "inline secret read field",
			raw:  `{"query":{"collection":"app.bsky.feed.post","limit":2},"privateKey":"ref-only"}`,
			want: "inline key material",
		},
		{
			name: "duplicate top-level query",
			raw:  `{"query":{"collection":"app.bsky.feed.post","limit":2},"query":{"collection":"app.bsky.feed.like","limit":2}}`,
			want: "duplicate JSON object key",
		},
		{
			name: "malformed collection",
			raw:  `{"query":{"collection":"app..bsky/feed.post","limit":2}}`,
			want: "NSID-shaped",
		},
		{
			name: "zero limit",
			raw:  `{"query":{"collection":"app.bsky.feed.post","limit":0}}`,
			want: "integer from 1",
		},
		{
			name: "over max limit",
			raw:  `{"query":{"collection":"app.bsky.feed.post","limit":3}}`,
			want: "integer from 1",
		},
		{
			name: "float cursor",
			raw:  `{"query":{"collection":"app.bsky.feed.post","cursor":1.0,"limit":2}}`,
			want: "monotonic integer",
		},
		{
			name: "exponent cursor",
			raw:  `{"query":{"collection":"app.bsky.feed.post","cursor":1e3,"limit":2}}`,
			want: "monotonic integer",
		},
		{
			name: "float limit",
			raw:  `{"query":{"collection":"app.bsky.feed.post","limit":2.0}}`,
			want: "monotonic integer",
		},
		{
			name: "out-of-range cursor",
			raw:  `{"query":{"collection":"app.bsky.feed.post","cursor":9007199254740992,"limit":2}}`,
			want: "monotonic integer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ReadRequest
			err := json.Unmarshal([]byte(tt.raw), &req)
			if err == nil {
				err = req.Validate()
			}
			if err == nil {
				t.Fatal("decode/Validate returned nil, want fail-closed rejection")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("decode/Validate error = %v, want substring %q", err, tt.want)
			}
		})
	}
}

func TestValidateCommitLogEntryAcceptsCreateAndDeleteOnly(t *testing.T) {
	create := logEntry(42, postRecord())
	if err := validateCommitLogEntry(create); err != nil {
		t.Fatalf("validateCommitLogEntry(create) returned error: %v", err)
	}

	delete := deleteLogEntry(43, deleteFromRecord(postRecord()))
	if err := validateCommitLogEntry(delete); err != nil {
		t.Fatalf("validateCommitLogEntry(delete) returned error: %v", err)
	}

	unknown := delete
	unknown.Op = "update-record"
	var invalid *InvalidRequestError
	if err := validateCommitLogEntry(unknown); !errors.As(err, &invalid) {
		t.Fatalf("validateCommitLogEntry(unknown) = %T %v, want InvalidRequestError", err, err)
	}
}

func TestDuplicateRepoPEMCannotBePersistedOrReturned(t *testing.T) {
	ctx := context.Background()
	raw := []byte(`{"desired":{"repo":"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----","repo":"` + validRepoDID + `","commit":{"cursor":42},"records":[` + postRecordJSON() + `]}}`)
	var req ApplyRequest
	if err := json.Unmarshal(raw, &req); err == nil {
		t.Fatal("Unmarshal accepted duplicate repo PEM smuggling request")
	}

	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)
	if _, err := capability.Apply(ctx, applyState(desiredState(42, []RepoRecord{postRecord()}))); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if bytes.Contains(fs.mustLiveBytes(t), []byte("PRIVATE KEY")) {
		t.Fatalf("live PDS repo state contains smuggled PEM: %q", fs.mustLiveBytes(t))
	}

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("Marshal ReadResponse returned error: %v", err)
	}
	if bytes.Contains(encoded, []byte("PRIVATE KEY")) {
		t.Fatalf("ReadResponse contains smuggled PEM: %q", encoded)
	}
}

func TestAtomicWriteFailureLeavesLiveStateUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := renderRepoState(repoState(42, []RepoRecord{postRecord()}))
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyState(desiredState(43, []RepoRecord{profileRecord()})))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS repo state after failed atomic write = %q, want unchanged %q", got, prior)
	}
	if fs.temp == nil {
		t.Fatal("simulated atomic write did not stage a temp file")
	}
	if reflect.DeepEqual(fs.temp, fs.live) {
		t.Fatal("test did not simulate a partial temp distinct from the live file")
	}
}

func TestAtomicWriteFailureDuringDeleteLeavesLiveStateUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := renderRepoState(repoState(42, []RepoRecord{postRecord(), profileRecord()}))
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyState(deleteDesiredState(43, deleteFromRecord(postRecord()))))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS repo state after failed delete write = %q, want unchanged %q", got, prior)
	}
	if fs.temp == nil {
		t.Fatal("simulated atomic write did not stage a temp file")
	}
	if reflect.DeepEqual(fs.temp, fs.live) {
		t.Fatal("test did not simulate a partial temp distinct from the live file")
	}
}

func TestDefaultAtomicWriteDoesNotFollowPreplantedPredictableSymlink(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Log("running as root in container; symlink semantics are still checked by target contents")
	}

	ctx := context.Background()
	dir := t.TempDir()
	fs := defaultFileSystem{
		stateRoot: dir,
		path:      filepath.Join(dir, defaultRepoStateFilename),
	}
	prior := renderRepoState(repoState(42, []RepoRecord{postRecord()}))
	if err := os.WriteFile(fs.path, prior, repoStateFileMode); err != nil {
		t.Fatalf("write prior state: %v", err)
	}

	attackTarget := filepath.Join(dir, "attacker-target")
	if err := os.WriteFile(attackTarget, []byte(attackerContents), repoStateFileMode); err != nil {
		t.Fatalf("write attacker target: %v", err)
	}
	predictableTemp := filepath.Join(dir, defaultRepoStateFilename+".tmp")
	if err := os.Symlink(attackTarget, predictableTemp); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("windows host cannot create symlink in this sandbox: %v", err)
		}
		t.Fatalf("preplant predictable symlink: %v", err)
	}

	capability := newCapability(fs)
	if _, err := capability.Apply(ctx, applyState(desiredState(43, []RepoRecord{profileRecord()}))); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	attackerBytes, err := os.ReadFile(attackTarget)
	if err != nil {
		t.Fatalf("read attacker target: %v", err)
	}
	if string(attackerBytes) != attackerContents {
		t.Fatalf("attacker target = %q, want unchanged %q", attackerBytes, attackerContents)
	}
	info, err := os.Lstat(predictableTemp)
	if err != nil {
		t.Fatalf("lstat predictable symlink: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("predictable temp mode = %v, want symlink untouched", info.Mode())
	}
	if got := mustReadFile(t, fs.path); reflect.DeepEqual(got, prior) {
		t.Fatalf("live state was not replaced by fresh temp write")
	}
}

func TestDefaultAtomicWriteDeleteDoesNotFollowPreplantedPredictableSymlink(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Log("running as root in container; symlink semantics are still checked by target contents")
	}

	ctx := context.Background()
	dir := t.TempDir()
	fs := defaultFileSystem{
		stateRoot: dir,
		path:      filepath.Join(dir, defaultRepoStateFilename),
	}
	prior := renderRepoState(repoState(42, []RepoRecord{postRecord(), profileRecord()}))
	if err := os.WriteFile(fs.path, prior, repoStateFileMode); err != nil {
		t.Fatalf("write prior state: %v", err)
	}

	attackTarget := filepath.Join(dir, "attacker-target")
	if err := os.WriteFile(attackTarget, []byte(attackerContents), repoStateFileMode); err != nil {
		t.Fatalf("write attacker target: %v", err)
	}
	predictableTemp := filepath.Join(dir, defaultRepoStateFilename+".tmp")
	if err := os.Symlink(attackTarget, predictableTemp); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("windows host cannot create symlink in this sandbox: %v", err)
		}
		t.Fatalf("preplant predictable symlink: %v", err)
	}

	capability := newCapability(fs)
	if _, err := capability.Apply(ctx, applyState(deleteDesiredState(43, deleteFromRecord(postRecord())))); err != nil {
		t.Fatalf("Apply delete returned error: %v", err)
	}

	attackerBytes, err := os.ReadFile(attackTarget)
	if err != nil {
		t.Fatalf("read attacker target: %v", err)
	}
	if string(attackerBytes) != attackerContents {
		t.Fatalf("attacker target = %q, want unchanged %q", attackerBytes, attackerContents)
	}
	info, err := os.Lstat(predictableTemp)
	if err != nil {
		t.Fatalf("lstat predictable symlink: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("predictable temp mode = %v, want symlink untouched", info.Mode())
	}
	if got := mustReadFile(t, fs.path); reflect.DeepEqual(got, prior) {
		t.Fatalf("live state was not replaced by fresh temp write")
	}
}

func TestTransactionApplyRollsBackRepoWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := renderRepoState(repoState(42, []RepoRecord{postRecord()}))
	fs := newMemoryFileSystem(prior)
	repoCapability := newCapability(fs)
	registry := mustRegistry(t, repoCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyState(desiredState(43, []RepoRecord{profileRecord()}))},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack", result.Outcome)
	}
	var applyErr *transaction.ApplyError
	if !errors.As(result.Err, &applyErr) {
		t.Fatalf("Err = %T %v, want ApplyError", result.Err, result.Err)
	}
	if !errors.Is(result.Err, errSimulatedApply) {
		t.Fatalf("Err = %v, want simulated apply failure", result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS repo state after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestTransactionApplyRollsBackRepoDeleteWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := renderRepoState(repoState(42, []RepoRecord{postRecord(), profileRecord()}))
	fs := newMemoryFileSystem(prior)
	repoCapability := newCapability(fs)
	registry := mustRegistry(t, repoCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyState(deleteDesiredState(43, deleteFromRecord(postRecord())))},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack", result.Outcome)
	}
	var applyErr *transaction.ApplyError
	if !errors.As(result.Err, &applyErr) {
		t.Fatalf("Err = %T %v, want ApplyError", result.Err, result.Err)
	}
	if !errors.Is(result.Err, errSimulatedApply) {
		t.Fatalf("Err = %v, want simulated apply failure", result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS repo state after delete rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestCommitPointMutationIsTrackedWithUndo(t *testing.T) {
	ctx := context.Background()
	prior := renderRepoState(repoState(42, []RepoRecord{postRecord()}))
	fs := newMemoryFileSystem(prior)
	fs.observeNextAtomicCommit = true
	repoCapability := newCapability(fs)
	registry := mustRegistry(t, repoCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyState(desiredState(43, []RepoRecord{profileRecord()}))},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !fs.observedCommitPointMutation {
		t.Fatal("test did not observe the atomic commit point mutation")
	}
	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack; err=%v", result.Outcome, result.Err)
	}
	wantApplied := []transaction.AppliedOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS repo state after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestDeleteCommitPointMutationIsTrackedWithUndo(t *testing.T) {
	ctx := context.Background()
	prior := renderRepoState(repoState(42, []RepoRecord{postRecord(), profileRecord()}))
	fs := newMemoryFileSystem(prior)
	fs.observeNextAtomicCommit = true
	repoCapability := newCapability(fs)
	registry := mustRegistry(t, repoCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyState(deleteDesiredState(43, deleteFromRecord(postRecord())))},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !fs.observedCommitPointMutation {
		t.Fatal("test did not observe the atomic commit point mutation")
	}
	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack; err=%v", result.Outcome, result.Err)
	}
	wantApplied := []transaction.AppliedOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS repo state after delete rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

type memoryFileSystem struct {
	exists                          bool
	live                            []byte
	temp                            []byte
	atomicWrites                    int
	failNextAtomicWriteBeforeCommit bool
	observeNextAtomicCommit         bool
	observedCommitPointMutation     bool
}

func newMemoryFileSystem(initial []byte) *memoryFileSystem {
	if initial == nil {
		return &memoryFileSystem{}
	}
	return &memoryFileSystem{exists: true, live: cloneBytes(initial)}
}

func (fs *memoryFileSystem) Read(ctx context.Context) (repoSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return repoSnapshot{}, err
	}
	return repoSnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
}

func (fs *memoryFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	fs.atomicWrites++
	fs.temp = cloneBytes(content)
	if len(fs.temp) > 1 {
		fs.temp = cloneBytes(fs.temp[:len(fs.temp)/2])
	}
	if fs.failNextAtomicWriteBeforeCommit {
		fs.failNextAtomicWriteBeforeCommit = false
		return errSimulatedWrite
	}

	fs.live = cloneBytes(content)
	fs.exists = true
	fs.temp = nil
	if fs.observeNextAtomicCommit {
		fs.observeNextAtomicCommit = false
		fs.observedCommitPointMutation = true
	}
	return nil
}

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot repoSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !snapshot.exists {
		fs.exists = false
		fs.live = nil
		return nil
	}
	return fs.AtomicWrite(ctx, snapshot.bytes)
}

func (fs *memoryFileSystem) mustLiveBytes(t *testing.T) []byte {
	t.Helper()
	if !fs.exists {
		t.Fatal("live PDS repo state does not exist")
	}
	return cloneBytes(fs.live)
}

type testRequest struct{}

func (testRequest) CapabilityRequest() {}

type testResponse struct{}

func (testResponse) CapabilityResponse() {}

type failingTxCapability struct {
	name string
}

func (c failingTxCapability) Name() string {
	return c.name
}

func (c failingTxCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return testResponse{}, nil
}

func (c failingTxCapability) Apply(context.Context, capabilities.TypedRequest) (transaction.Undo, error) {
	return nil, errSimulatedApply
}

type pathSmugglingRequest struct {
	Path    string
	Desired DesiredState
}

func (pathSmugglingRequest) CapabilityRequest() {}

func repoState(cursor int64, records []RepoRecord) RepoState {
	return RepoState{
		Repo:         validRepoDID,
		Records:      cloneRecords(records),
		CommitCursor: cursor,
		Log:          logEntriesForRecords(cursor, records),
	}
}

func desiredState(cursor int64, records []RepoRecord) DesiredState {
	return DesiredState{
		Repo:    validRepoDID,
		Commit:  Commit{Cursor: cursor},
		Records: cloneRecords(records),
	}
}

func deleteDesiredState(cursor int64, deletes ...DeleteRecord) DesiredState {
	return DesiredState{
		Repo:    validRepoDID,
		Commit:  Commit{Cursor: cursor},
		Records: []RepoRecord{},
		Deletes: cloneDeletes(deletes),
	}
}

func withRepo(state DesiredState, repo string) DesiredState {
	state.Repo = repo
	return state
}

func withCommitCursor(state DesiredState, cursor int64) DesiredState {
	state.Commit.Cursor = cursor
	return state
}

func applyState(state DesiredState) ApplyRequest {
	desired := cloneDesiredState(state)
	return ApplyRequest{Desired: &desired}
}

func postRecord() RepoRecord {
	return RepoRecord{
		Collection:  "app.bsky.feed.post",
		RKey:        "p1-067-post",
		ValueDigest: firstDigest,
	}
}

func profileRecord() RepoRecord {
	return RepoRecord{
		Collection:  "app.bsky.actor.profile",
		RKey:        "self",
		ValueDigest: secondDigest,
	}
}

func feedRecord(rkey string, digest string) RepoRecord {
	return RepoRecord{
		Collection:  "app.bsky.feed.post",
		RKey:        rkey,
		ValueDigest: digest,
	}
}

func withDigest(record RepoRecord, digest string) RepoRecord {
	record.ValueDigest = digest
	return record
}

func deleteFromRecord(record RepoRecord) DeleteRecord {
	return DeleteRecord{
		Collection: record.Collection,
		RKey:       record.RKey,
	}
}

func logEntry(cursor int64, record RepoRecord) CommitLogEntry {
	return CommitLogEntry{
		Cursor:     cursor,
		Op:         createRecordOp,
		Collection: record.Collection,
		RKey:       record.RKey,
	}
}

func deleteLogEntry(cursor int64, record DeleteRecord) CommitLogEntry {
	return CommitLogEntry{
		Cursor:     cursor,
		Op:         deleteRecordOp,
		Collection: record.Collection,
		RKey:       record.RKey,
	}
}

func containsRecord(records []RepoRecord, key recordKey) bool {
	for _, record := range records {
		if recordKeyFromRecord(record) == key {
			return true
		}
	}
	return false
}

func containsLogEntry(log []CommitLogEntry, op string, cursor int64, key recordKey) bool {
	for _, entry := range log {
		if entry.Op == op && entry.Cursor == cursor && recordKeyFromLog(entry) == key {
			return true
		}
	}
	return false
}

func postRecordJSON() string {
	return `{"collection":"app.bsky.feed.post","rkey":"p1-067-post","valueDigest":"` + firstDigest + `"}`
}

func profileRecordJSON() string {
	return `{"collection":"app.bsky.actor.profile","rkey":"self","valueDigest":"` + secondDigest + `"}`
}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) returned error: %v", path, err)
	}
	return content
}
