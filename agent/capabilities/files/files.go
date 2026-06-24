package files

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/vita/agent/internal/jsonsafe"
)

const (
	defaultStateRoot = "/var/lib/vita/files"

	MaxFileBytes        int64 = 8 * 1024 * 1024
	MaxRequestBodyBytes int64 = 12 * 1024 * 1024

	directoryMode os.FileMode = 0o700
	fileMode      os.FileMode = 0o600
)

type Access string

const (
	AccessReadOnly  Access = "read-only"
	AccessReadWrite Access = "read-write"
)

type Operation string

const (
	OperationList  Operation = "list"
	OperationRead  Operation = "read"
	OperationWrite Operation = "write"
	OperationStat  Operation = "stat"
)

type Kind string

const (
	KindFile           Kind = "file"
	KindDir            Kind = "dir"
	KindSymlinkSkipped Kind = "symlink-skipped"
)

type Grant struct {
	Name   string `json:"name"`
	Root   string `json:"root"`
	Access Access `json:"access"`
}

func (g *Grant) UnmarshalJSON(raw []byte) error {
	type grantJSON Grant
	var decoded grantJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	*g = Grant(decoded)
	return nil
}

type Request struct {
	Op    Operation `json:"op"`
	Grant string    `json:"grant"`
	Path  string    `json:"path"`
	Data  *string   `json:"data,omitempty"`
}

func (r *Request) UnmarshalJSON(raw []byte) error {
	type requestJSON Request
	var decoded requestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	*r = Request(decoded)
	return nil
}

type Response struct {
	Entries *[]Entry `json:"entries,omitempty"`
	Data    *string  `json:"data,omitempty"`
	Kind    *Kind    `json:"kind,omitempty"`
	Size    *int64   `json:"size,omitempty"`
	MTime   *string  `json:"mtime,omitempty"`
}

type Entry struct {
	Name  string `json:"name"`
	Kind  Kind   `json:"kind"`
	Size  int64  `json:"size"`
	MTime string `json:"mtime"`
}

type Options struct {
	StateRoot string
	Grants    []Grant
}

type Handler struct {
	stateRoot string
	grants    map[string]resolvedGrant
}

type resolvedGrant struct {
	name   string
	access Access
	rel    string
}

type RequestError struct {
	Status  int
	Code    string
	Message string
}

func (e *RequestError) Error() string {
	return e.Message
}

func DefaultGrants() []Grant {
	return []Grant{
		{Name: "runtime-files", Root: "owner", Access: AccessReadWrite},
		{Name: "runtime-files-ro", Root: "owner-ro", Access: AccessReadOnly},
		{Name: "export", Root: "owner", Access: AccessReadWrite},
	}
}

func NewHandler(options Options) (*Handler, error) {
	stateRoot := options.StateRoot
	if stateRoot == "" {
		stateRoot = defaultStateRoot
	}
	stateRootAbs, err := filepath.Abs(stateRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve files state root: %w", err)
	}

	grants := make(map[string]resolvedGrant, len(options.Grants))
	for i, grant := range options.Grants {
		resolved, err := resolveGrant(stateRootAbs, grant)
		if err != nil {
			return nil, fmt.Errorf("files grant %d: %w", i, err)
		}
		if _, exists := grants[resolved.name]; exists {
			return nil, fmt.Errorf("files grant %d: duplicate grant name %q", i, resolved.name)
		}
		grants[resolved.name] = resolved
	}

	return &Handler{stateRoot: stateRootAbs, grants: grants}, nil
}

func DecodeRequest(raw []byte) (Request, error) {
	var request Request
	if err := jsonsafe.DecodeStrict(raw, &request); err != nil {
		return Request{}, err
	}
	if err := request.Validate(); err != nil {
		return Request{}, err
	}
	return request, nil
}

func (r Request) Validate() error {
	if r.Op == "" {
		return filesError(400, "invalid_request", "op is required")
	}
	switch r.Op {
	case OperationList, OperationRead, OperationWrite, OperationStat:
	default:
		return filesError(400, "unknown_op", "unknown files op")
	}
	if r.Grant == "" {
		return filesError(400, "invalid_request", "grant is required")
	}
	if r.Path == "" {
		return filesError(400, "path_traversal", "path is outside the grant scope")
	}
	if r.Op == OperationWrite {
		if r.Data == nil {
			return filesError(400, "invalid_request", "data is required for write")
		}
		return nil
	}
	if r.Data != nil {
		return filesError(400, "invalid_request", "data is only allowed for write")
	}
	return nil
}

func ValidateGrant(grant Grant) error {
	_, err := resolveGrant(defaultStateRoot, grant)
	return err
}

func (h *Handler) Handle(ctx context.Context, request Request) (Response, error) {
	if h == nil {
		return Response{}, filesError(500, "files_unavailable", "files handler is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	if err := request.Validate(); err != nil {
		return Response{}, err
	}

	grant, ok := h.grants[request.Grant]
	if !ok {
		return Response{}, filesError(404, "unknown_grant", "unknown files grant")
	}
	if request.Op == OperationWrite && grant.access != AccessReadWrite {
		return Response{}, filesError(403, "read_only_grant", "files grant is read-only")
	}

	base, err := h.ensureGrantRoot(grant)
	if err != nil {
		return Response{}, err
	}

	abs, ok := ResolveWithinScope(base, request.Path)
	if !ok {
		return Response{}, filesError(400, "path_traversal", "path is outside the grant scope")
	}

	switch request.Op {
	case OperationList:
		return h.list(ctx, abs)
	case OperationRead:
		return h.read(ctx, abs)
	case OperationWrite:
		data, err := decodeWriteData(*request.Data)
		if err != nil {
			return Response{}, err
		}
		return h.write(ctx, abs, data)
	case OperationStat:
		return h.stat(ctx, abs)
	default:
		return Response{}, filesError(400, "unknown_op", "unknown files op")
	}
}

func (h *Handler) list(ctx context.Context, abs string) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	info, err := os.Lstat(abs)
	if err != nil {
		return Response{}, fileAccessError("stat files path", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return Response{}, filesError(400, "path_traversal", "path is outside the grant scope")
	}
	if !info.IsDir() {
		entries := []Entry{entryFromInfo(filepath.Base(abs), info)}
		return Response{Entries: &entries}, nil
	}

	dir, err := os.Open(abs)
	if err != nil {
		return Response{}, fileAccessError("open files directory", err)
	}
	defer dir.Close()

	infos, err := dir.Readdir(0)
	if err != nil {
		return Response{}, fileAccessError("list files directory", err)
	}
	sort.Slice(infos, func(i, j int) bool {
		return infos[i].Name() < infos[j].Name()
	})

	entries := make([]Entry, 0, len(infos))
	for _, child := range infos {
		entries = append(entries, entryFromInfo(child.Name(), child))
	}
	return Response{Entries: &entries}, nil
}

func (h *Handler) read(ctx context.Context, abs string) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	info, err := os.Lstat(abs)
	if err != nil {
		return Response{}, fileAccessError("stat files path", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return Response{}, filesError(400, "path_traversal", "path is outside the grant scope")
	}
	if !info.Mode().IsRegular() {
		return Response{}, filesError(400, "not_file", "files path is not a regular file")
	}
	if info.Size() > MaxFileBytes {
		return Response{}, filesError(413, "file_too_large", "file exceeds files size cap")
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		return Response{}, fileAccessError("read files path", err)
	}
	if int64(len(data)) > MaxFileBytes {
		return Response{}, filesError(413, "file_too_large", "file exceeds files size cap")
	}
	encoded := base64.StdEncoding.EncodeToString(data)
	size := int64(len(data))
	mtime := formatMTime(info.ModTime())
	return Response{Data: &encoded, Size: &size, MTime: &mtime}, nil
}

func (h *Handler) write(ctx context.Context, abs string, data []byte) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	if int64(len(data)) > MaxFileBytes {
		return Response{}, filesError(413, "file_too_large", "file exceeds files size cap")
	}

	parent := filepath.Dir(abs)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return Response{}, fileAccessError("stat files parent", err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return Response{}, filesError(400, "path_traversal", "path is outside the grant scope")
	}

	if info, err := os.Lstat(abs); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return Response{}, filesError(400, "path_traversal", "path is outside the grant scope")
		}
		if info.IsDir() {
			return Response{}, filesError(400, "not_file", "files path is not a regular file")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return Response{}, fileAccessError("stat files path", err)
	}

	if err := atomicWriteFile(parent, abs, data); err != nil {
		return Response{}, err
	}
	kind := KindFile
	size := int64(len(data))
	return Response{Kind: &kind, Size: &size}, nil
}

func (h *Handler) stat(ctx context.Context, abs string) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	info, err := os.Lstat(abs)
	if err != nil {
		return Response{}, fileAccessError("stat files path", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return Response{}, filesError(400, "path_traversal", "path is outside the grant scope")
	}
	entry := entryFromInfo(filepath.Base(abs), info)
	return Response{
		Kind:  &entry.Kind,
		Size:  &entry.Size,
		MTime: &entry.MTime,
	}, nil
}

func (h *Handler) ensureGrantRoot(grant resolvedGrant) (string, error) {
	if err := ensureDirectory(h.stateRoot); err != nil {
		return "", fmt.Errorf("create files state root: %w", err)
	}

	current := h.stateRoot
	segments := strings.Split(grant.rel, "/")
	for _, segment := range segments {
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return "", fileAccessError("stat files grant root", err)
			}
			if err := os.Mkdir(current, directoryMode); err != nil {
				return "", fileAccessError("create files grant root", err)
			}
			if err := os.Chmod(current, directoryMode); err != nil {
				return "", fileAccessError("secure files grant root", err)
			}
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", filesError(400, "path_traversal", "files grant root is outside the state root")
		}
		if err := os.Chmod(current, directoryMode); err != nil {
			return "", fileAccessError("secure files grant root", err)
		}
	}

	abs, ok := ResolveWithinScope(h.stateRoot, grant.rel)
	if !ok {
		return "", filesError(400, "path_traversal", "files grant root is outside the state root")
	}
	return abs, nil
}

func ensureDirectory(path string) error {
	if err := os.MkdirAll(path, directoryMode); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	return os.Chmod(path, directoryMode)
}

func atomicWriteFile(parent string, target string, data []byte) error {
	prefix := ".file-"
	if base := filepath.Base(target); base != "." && base != string(filepath.Separator) {
		prefix = "." + sanitizeTempPrefix(base) + "-"
	}

	tmp, err := os.CreateTemp(parent, prefix+"*.tmp")
	if err != nil {
		return fileAccessError("create files temp file", err)
	}
	tmpName := tmp.Name()
	closed := false
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			if !closed {
				_ = tmp.Close()
			}
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(fileMode); err != nil {
		return fileAccessError("secure files temp file", err)
	}
	written, err := tmp.Write(data)
	if err != nil {
		return fileAccessError("write files temp file", err)
	}
	if written != len(data) {
		return fileAccessError("write files temp file", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fileAccessError("sync files temp file", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fileAccessError("close files temp file", err)
	}
	closed = true

	// Rename is the single commit point. No fallible operation runs after it.
	if err := os.Rename(tmpName, target); err != nil {
		return fileAccessError("replace files path", err)
	}
	cleanupTemp = false
	return nil
}

func decodeWriteData(encoded string) ([]byte, error) {
	if len(encoded) > base64.StdEncoding.EncodedLen(int(MaxFileBytes)) {
		return nil, filesError(413, "file_too_large", "file exceeds files size cap")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return nil, filesError(400, "invalid_data", "write data must be base64")
	}
	if int64(len(data)) > MaxFileBytes {
		return nil, filesError(413, "file_too_large", "file exceeds files size cap")
	}
	return data, nil
}

func resolveGrant(stateRoot string, grant Grant) (resolvedGrant, error) {
	if !validGrantKey(grant.Name) {
		return resolvedGrant{}, errors.New("name must be a non-empty grant key")
	}
	if !validGrantKey(grant.Root) {
		return resolvedGrant{}, errors.New("root must be a non-empty agent-resolved key")
	}
	switch grant.Access {
	case AccessReadOnly, AccessReadWrite:
	default:
		return resolvedGrant{}, errors.New("access must be read-only or read-write")
	}

	rel := grant.Root + "/" + grant.Name
	return resolvedGrant{
		name:   grant.Name,
		access: grant.Access,
		rel:    rel,
	}, nil
}

func validGrantKey(value string) bool {
	if value == "" || value == "." || value == ".." || strings.ContainsRune(value, '\x00') {
		return false
	}
	for i := 0; i < len(value); i++ {
		ch := value[i]
		switch {
		case ch >= 'a' && ch <= 'z':
		case ch >= 'A' && ch <= 'Z':
		case ch >= '0' && ch <= '9':
		case ch == '.', ch == '_', ch == '-':
		default:
			return false
		}
	}
	return true
}

func entryFromInfo(name string, info os.FileInfo) Entry {
	kind := KindFile
	if info.Mode()&os.ModeSymlink != 0 {
		kind = KindSymlinkSkipped
	} else if info.IsDir() {
		kind = KindDir
	}

	size := info.Size()
	if kind == KindDir || kind == KindSymlinkSkipped {
		size = 0
	}

	return Entry{
		Name:  name,
		Kind:  kind,
		Size:  size,
		MTime: formatMTime(info.ModTime()),
	}
}

func formatMTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func fileAccessError(action string, err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return filesError(404, "not_found", action+" failed")
	}
	if errors.Is(err, os.ErrPermission) {
		return filesError(403, "permission_denied", action+" failed")
	}
	return filesError(500, "io_error", action+" failed")
}

func filesError(status int, code string, message string) *RequestError {
	return &RequestError{Status: status, Code: code, Message: message}
}

func sanitizeTempPrefix(name string) string {
	var builder strings.Builder
	for i := 0; i < len(name); i++ {
		ch := name[i]
		switch {
		case ch >= 'a' && ch <= 'z':
			builder.WriteByte(ch)
		case ch >= 'A' && ch <= 'Z':
			builder.WriteByte(ch)
		case ch >= '0' && ch <= '9':
			builder.WriteByte(ch)
		case ch == '.', ch == '_', ch == '-':
			builder.WriteByte(ch)
		default:
			builder.WriteByte('_')
		}
	}
	if builder.Len() == 0 {
		return "file"
	}
	return builder.String()
}
