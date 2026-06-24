package files

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ResolveWithinScope resolves rel under base without following symlinks in the
// request path. Symlinks are refused rather than traversed, including symlinks
// that point back inside the scope, so a compromised runtime cannot use a link
// as an alternate authority boundary.
func ResolveWithinScope(base string, rel string) (string, bool) {
	segments, ok := cleanRelativeSegments(rel)
	if !ok {
		return "", false
	}

	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return "", false
	}
	baseClean := filepath.Clean(baseAbs)
	baseResolved, err := filepath.EvalSymlinks(baseClean)
	if err != nil {
		return "", false
	}

	candidate := baseResolved
	for _, segment := range segments {
		candidate = filepath.Join(candidate, segment)
		if !pathWithin(baseResolved, candidate) {
			return "", false
		}

		info, err := os.Lstat(candidate)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return "", false
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", false
		}
	}

	if !pathWithin(baseResolved, candidate) {
		return "", false
	}
	return candidate, true
}

func cleanRelativeSegments(rel string) ([]string, bool) {
	if rel == "" || rel == "." || rel == ".." {
		return nil, false
	}
	if filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" {
		return nil, false
	}
	if strings.ContainsRune(rel, '\x00') || strings.Contains(rel, "\\") {
		return nil, false
	}

	segments := strings.Split(rel, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || strings.ContainsRune(segment, '\x00') {
			return nil, false
		}
	}
	return segments, true
}

func pathWithin(base string, candidate string) bool {
	rel, err := filepath.Rel(base, candidate)
	if err != nil {
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
