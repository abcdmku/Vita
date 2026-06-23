package main

import (
	"fmt"
	"os"
	"runtime"
	"time"
)

const capsuleID = "local.hostile-oci.capsule"

func main() {
	runtime.GOMAXPROCS(1)

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "mem":
			runMemoryChild()
			return
		case "pid":
			time.Sleep(30 * time.Second)
			return
		}
	}

	fmt.Printf("VITA-CAPSULE-OCI-HOSTILE-WORKLOAD: id=%s status=RUNNING\n", capsuleID)

	children := make([]*os.Process, 0, 64)
	if child, err := startChild("mem"); err == nil {
		children = append(children, child)
	}

	deadline := time.Now().Add(20 * time.Second)
	nextFork := time.Now()
	var spin uint64
	for time.Now().Before(deadline) {
		if !time.Now().Before(nextFork) {
			if child, err := startChild("pid"); err == nil {
				children = append(children, child)
			}
			nextFork = time.Now().Add(10 * time.Millisecond)
		}
		for i := 0; i < 500000; i++ {
			spin = spin*1664525 + 1013904223
		}
	}

	for _, child := range children {
		_ = child.Kill()
		_, _ = child.Wait()
	}
	_ = spin
}

func startChild(mode string) (*os.Process, error) {
	return os.StartProcess("/init", []string{"/init", mode}, &os.ProcAttr{
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
	})
}

func runMemoryChild() {
	time.Sleep(750 * time.Millisecond)

	blocks := make([][]byte, 0, 256)
	for i := 0; i < 256; i++ {
		block := make([]byte, 1024*1024)
		for offset := 0; offset < len(block); offset += 4096 {
			block[offset] = byte(i)
		}
		blocks = append(blocks, block)
	}
	time.Sleep(30 * time.Second)
}
