package main

import (
	"fmt"
	"time"
)

func main() {
	fmt.Println("VITA-CAPSULE-OCI-WORKLOAD: id=local.oci.capsule status=OK")
	for {
		time.Sleep(time.Hour)
	}
}
