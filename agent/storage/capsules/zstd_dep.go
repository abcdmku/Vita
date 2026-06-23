package capsules

// TEMPORARY dependency bootstrap (P1-051): a blank import pins github.com/klauspost/compress/zstd
// into go.mod + vendor/ so the OFFLINE Docker build can use it (workers cannot add deps offline).
// The P1-051 worker REPLACES this with the real zstd decode in fetch.go and DELETES this file.
import _ "github.com/klauspost/compress/zstd"
