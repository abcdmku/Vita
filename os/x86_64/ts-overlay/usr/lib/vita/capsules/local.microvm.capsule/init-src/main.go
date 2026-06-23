package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	pid := os.Getpid()
	pidNamespace := "unexpected"
	if pid == 1 || pid == 2 {
		pidNamespace = "own"
	}
	fmt.Printf("VITA-CAPSULE-MICROVM-WORKLOAD: id=local.microvm.capsule pid=%d pid1=%s status=OK\n", pid, pidNamespace)
	for {
		time.Sleep(time.Hour)
	}
}
