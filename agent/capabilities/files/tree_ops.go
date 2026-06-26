package files

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
)

type treeBudget struct {
	entries int
	bytes   int64
}

func (b *treeBudget) addInfo(info os.FileInfo) error {
	b.entries++
	if b.entries > MaxTreeEntries {
		return treeTooLargeError()
	}
	if info.Mode().IsRegular() {
		size := info.Size()
		if size > MaxFileBytes {
			return fileTooLargeError()
		}
		return b.addBytes(size)
	}
	return nil
}

func (b *treeBudget) addBytes(size int64) error {
	if size <= 0 {
		return nil
	}
	b.bytes += size
	if b.bytes > MaxRequestBodyBytes {
		return treeTooLargeError()
	}
	return nil
}

func (h *Handler) copy(ctx context.Context, src string, dst string) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	info, err := mutableSourceInfo(src)
	if err != nil {
		return Response{}, err
	}
	if sameOrWithin(src, dst) {
		return Response{}, filesError(400, "invalid_request", "cannot copy files path onto or under itself")
	}
	if err := ensureDestinationAvailable(dst); err != nil {
		return Response{}, err
	}

	budget := &treeBudget{}
	if err := budget.addInfo(info); err != nil {
		return Response{}, err
	}
	if info.IsDir() {
		return h.copyDirectory(ctx, src, dst, budget)
	}

	size, err := atomicCopyFile(ctx, src, dst)
	if err != nil {
		return Response{}, err
	}
	kind := KindFile
	return Response{Kind: &kind, Size: &size}, nil
}

func (h *Handler) move(ctx context.Context, src string, dst string) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	info, err := mutableSourceInfo(src)
	if err != nil {
		return Response{}, err
	}
	if sameOrWithin(src, dst) {
		return Response{}, filesError(400, "invalid_request", "cannot move files path onto or under itself")
	}
	if err := ensureDestinationAvailable(dst); err != nil {
		return Response{}, err
	}

	// Rename is the single commit point. No fallible operation runs after it.
	if err := os.Rename(src, dst); err != nil {
		return Response{}, fileAccessError("move files path", err)
	}
	entry := entryFromInfo(filepath.Base(dst), info)
	return Response{Kind: &entry.Kind, Size: &entry.Size}, nil
}

func (h *Handler) mkdir(ctx context.Context, abs string) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	if err := ensureDestinationAvailable(abs); err != nil {
		return Response{}, err
	}
	if err := os.Mkdir(abs, directoryMode); err != nil {
		if errors.Is(err, os.ErrExist) {
			return Response{}, alreadyExistsError()
		}
		return Response{}, fileAccessError("create files directory", err)
	}
	if err := os.Chmod(abs, directoryMode); err != nil {
		_ = os.Remove(abs)
		return Response{}, fileAccessError("secure files directory", err)
	}
	kind := KindDir
	return Response{Kind: &kind}, nil
}

func (h *Handler) delete(ctx context.Context, abs string) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	var paths []string
	budget := &treeBudget{}
	if err := collectDeletableTree(ctx, abs, budget, &paths); err != nil {
		return Response{}, err
	}
	for i := len(paths) - 1; i >= 0; i-- {
		if err := ctx.Err(); err != nil {
			return Response{}, err
		}
		if err := os.Remove(paths[i]); err != nil {
			return Response{}, fileAccessError("delete files path", err)
		}
	}
	return Response{}, nil
}

func (h *Handler) listRecursive(ctx context.Context, abs string, maxDepth int) (Response, error) {
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

	entries := []Entry{}
	budget := &treeBudget{}
	if !info.IsDir() {
		if err := budget.addInfo(info); err != nil {
			return Response{}, err
		}
		entries = append(entries, entryFromInfo(filepath.Base(abs), info))
		return Response{Entries: &entries}, nil
	}
	if maxDepth == 0 {
		return Response{Entries: &entries}, nil
	}
	if err := h.listRecursiveDir(ctx, abs, "", 1, maxDepth, budget, &entries); err != nil {
		return Response{}, err
	}
	return Response{Entries: &entries}, nil
}

func (h *Handler) copyDirectory(ctx context.Context, src string, dst string, budget *treeBudget) (Response, error) {
	parent := filepath.Dir(dst)
	prefix := "." + sanitizeTempPrefix(filepath.Base(dst)) + "-"
	tmp, err := os.MkdirTemp(parent, prefix+"*.tmp")
	if err != nil {
		return Response{}, fileAccessError("create files temp directory", err)
	}
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			_ = os.RemoveAll(tmp)
		}
	}()

	if err := os.Chmod(tmp, directoryMode); err != nil {
		return Response{}, fileAccessError("secure files temp directory", err)
	}
	if err := h.copyDirectoryContents(ctx, src, tmp, budget); err != nil {
		return Response{}, err
	}
	if err := ensureDestinationAvailable(dst); err != nil {
		return Response{}, err
	}

	// Rename is the single commit point. No fallible operation runs after it.
	if err := os.Rename(tmp, dst); err != nil {
		return Response{}, fileAccessError("create files directory", err)
	}
	cleanupTemp = false
	kind := KindDir
	return Response{Kind: &kind}, nil
}

func (h *Handler) copyDirectoryContents(ctx context.Context, src string, dst string, budget *treeBudget) error {
	entries, err := readDirSortedCapped(ctx, src, budget)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return fileAccessError("stat files path", err)
		}
		if err := budget.addInfo(info); err != nil {
			return err
		}

		srcChild := filepath.Join(src, entry.Name())
		dstChild := filepath.Join(dst, entry.Name())
		if info.Mode()&os.ModeSymlink != 0 {
			return filesError(400, "path_traversal", "path is outside the grant scope")
		}
		switch {
		case info.IsDir():
			if err := os.Mkdir(dstChild, directoryMode); err != nil {
				return fileAccessError("create files directory", err)
			}
			if err := os.Chmod(dstChild, directoryMode); err != nil {
				return fileAccessError("secure files directory", err)
			}
			if err := h.copyDirectoryContents(ctx, srcChild, dstChild, budget); err != nil {
				return err
			}
		case info.Mode().IsRegular():
			size, err := copyFileToExclusivePath(ctx, srcChild, dstChild)
			if err != nil {
				return err
			}
			if size > info.Size() {
				if err := budget.addBytes(size - info.Size()); err != nil {
					return err
				}
			}
		default:
			return unsupportedFileTypeError()
		}
	}
	return nil
}

func (h *Handler) listRecursiveDir(ctx context.Context, abs string, prefix string, depth int, maxDepth int, budget *treeBudget, entries *[]Entry) error {
	children, err := readDirSortedCapped(ctx, abs, budget)
	if err != nil {
		return err
	}
	for _, child := range children {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := child.Info()
		if err != nil {
			return fileAccessError("stat files path", err)
		}
		if err := budget.addInfo(info); err != nil {
			return err
		}

		name := child.Name()
		if prefix != "" {
			name = prefix + "/" + name
		}
		*entries = append(*entries, entryFromInfo(name, info))
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if info.IsDir() && depth < maxDepth {
			if err := h.listRecursiveDir(ctx, filepath.Join(abs, child.Name()), name, depth+1, maxDepth, budget, entries); err != nil {
				return err
			}
		}
	}
	return nil
}

func collectDeletableTree(ctx context.Context, abs string, budget *treeBudget, paths *[]string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	info, err := mutableSourceInfo(abs)
	if err != nil {
		return err
	}
	if err := budget.addInfo(info); err != nil {
		return err
	}
	*paths = append(*paths, abs)
	if !info.IsDir() {
		return nil
	}

	entries, err := readDirSortedCapped(ctx, abs, budget)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := collectDeletableTree(ctx, filepath.Join(abs, entry.Name()), budget, paths); err != nil {
			return err
		}
	}
	return nil
}

func readDirSortedCapped(ctx context.Context, abs string, budget *treeBudget) ([]os.DirEntry, error) {
	dir, err := os.Open(abs)
	if err != nil {
		return nil, fileAccessError("open files directory", err)
	}
	defer dir.Close()

	entries := []os.DirEntry{}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		remaining := MaxTreeEntries - budget.entries - len(entries)
		if remaining < 0 {
			return nil, treeTooLargeError()
		}
		chunkLimit := remaining + 1
		if chunkLimit > 128 {
			chunkLimit = 128
		}
		chunk, err := dir.ReadDir(chunkLimit)
		if len(chunk) > 0 {
			entries = append(entries, chunk...)
			if budget.entries+len(entries) > MaxTreeEntries {
				return nil, treeTooLargeError()
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fileAccessError("list files directory", err)
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})
	return entries, nil
}

func mutableSourceInfo(abs string) (os.FileInfo, error) {
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, fileAccessError("stat files path", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, filesError(400, "path_traversal", "path is outside the grant scope")
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return nil, unsupportedFileTypeError()
	}
	return info, nil
}

func ensureDestinationAvailable(abs string) error {
	parent := filepath.Dir(abs)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return fileAccessError("stat files parent", err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return filesError(400, "path_traversal", "path is outside the grant scope")
	}
	if _, err := os.Lstat(abs); err == nil {
		return alreadyExistsError()
	} else if !errors.Is(err, os.ErrNotExist) {
		return fileAccessError("stat files destination", err)
	}
	return nil
}

func atomicCopyFile(ctx context.Context, src string, dst string) (int64, error) {
	parent := filepath.Dir(dst)
	prefix := ".file-"
	if base := filepath.Base(dst); base != "." && base != string(filepath.Separator) {
		prefix = "." + sanitizeTempPrefix(base) + "-"
	}

	tmp, err := os.CreateTemp(parent, prefix+"*.tmp")
	if err != nil {
		return 0, fileAccessError("create files temp file", err)
	}
	tmpName := tmp.Name()
	closed := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
		_ = os.Remove(tmpName)
	}()

	if err := tmp.Chmod(fileMode); err != nil {
		return 0, fileAccessError("secure files temp file", err)
	}
	size, err := copyRegularFileData(ctx, src, tmp)
	if err != nil {
		return 0, err
	}
	if err := tmp.Sync(); err != nil {
		return 0, fileAccessError("sync files temp file", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return 0, fileAccessError("close files temp file", err)
	}
	closed = true

	if _, err := os.Lstat(dst); err == nil {
		return 0, alreadyExistsError()
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, fileAccessError("stat files destination", err)
	}
	if err := os.Link(tmpName, dst); err != nil {
		if errors.Is(err, os.ErrExist) {
			return 0, alreadyExistsError()
		}
		return 0, fileAccessError("create files path", err)
	}
	return size, nil
}

func copyFileToExclusivePath(ctx context.Context, src string, dst string) (int64, error) {
	target, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fileMode)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return 0, alreadyExistsError()
		}
		return 0, fileAccessError("create files path", err)
	}
	closed := false
	cleanup := true
	defer func() {
		if cleanup {
			if !closed {
				_ = target.Close()
			}
			_ = os.Remove(dst)
		}
	}()

	if err := target.Chmod(fileMode); err != nil {
		return 0, fileAccessError("secure files path", err)
	}
	size, err := copyRegularFileData(ctx, src, target)
	if err != nil {
		return 0, err
	}
	if err := target.Sync(); err != nil {
		return 0, fileAccessError("sync files path", err)
	}
	if err := target.Close(); err != nil {
		closed = true
		return 0, fileAccessError("close files path", err)
	}
	closed = true
	cleanup = false
	return size, nil
}

func copyRegularFileData(ctx context.Context, src string, dst *os.File) (int64, error) {
	info, err := mutableSourceInfo(src)
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() {
		return 0, unsupportedFileTypeError()
	}
	if info.Size() > MaxFileBytes {
		return 0, fileTooLargeError()
	}

	source, err := os.Open(src)
	if err != nil {
		return 0, fileAccessError("open files path", err)
	}
	defer source.Close()

	buffer := make([]byte, 32*1024)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		n, readErr := source.Read(buffer)
		if n > 0 {
			nextTotal := total + int64(n)
			if nextTotal > MaxFileBytes {
				return 0, fileTooLargeError()
			}
			written, writeErr := dst.Write(buffer[:n])
			if writeErr != nil {
				return 0, fileAccessError("write files path", writeErr)
			}
			if written != n {
				return 0, fileAccessError("write files path", io.ErrShortWrite)
			}
			total = nextTotal
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return 0, fileAccessError("read files path", readErr)
		}
	}
	return total, nil
}

func sameOrWithin(base string, candidate string) bool {
	base = filepath.Clean(base)
	candidate = filepath.Clean(candidate)
	return base == candidate || pathWithin(base, candidate)
}

func alreadyExistsError() error {
	return filesError(409, "already_exists", "files path already exists")
}

func fileTooLargeError() error {
	return filesError(413, "file_too_large", "file exceeds files size cap")
}

func treeTooLargeError() error {
	return filesError(413, "tree_too_large", "files tree exceeds files size cap")
}

func unsupportedFileTypeError() error {
	return filesError(400, "unsupported_file_type", "files path is not a regular file or directory")
}
