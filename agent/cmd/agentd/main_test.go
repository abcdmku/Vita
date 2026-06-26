package main

import (
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDevTCPServerDisabledByDefault(t *testing.T) {
	unsetEnv(t, devTCPEnv)

	server, transports, err := devTCPServerFromEnv(listenAddr, http.NewServeMux())
	if err != nil {
		t.Fatalf("devTCPServerFromEnv() error = %v", err)
	}
	if server != nil {
		t.Fatalf("devTCPServerFromEnv() server = %#v, want nil", server)
	}
	if transports != "unix" {
		t.Fatalf("devTCPServerFromEnv() transports = %q, want unix", transports)
	}
}

func TestDevTCPServerRejectsUnknownOptInValues(t *testing.T) {
	for _, value := range []string{"0", "true", "yes", "dev", "1 "} {
		t.Run(value, func(t *testing.T) {
			t.Setenv(devTCPEnv, value)

			server, transports, err := devTCPServerFromEnv(listenAddr, http.NewServeMux())
			if err != nil {
				t.Fatalf("devTCPServerFromEnv() error = %v", err)
			}
			if server != nil {
				t.Fatalf("devTCPServerFromEnv() server = %#v, want nil", server)
			}
			if transports != "unix" {
				t.Fatalf("devTCPServerFromEnv() transports = %q, want unix", transports)
			}
		})
	}
}

func TestDevTCPServerEnabledByExplicitOptIn(t *testing.T) {
	t.Setenv(devTCPEnv, "1")
	mux := http.NewServeMux()

	server, transports, err := devTCPServerFromEnv(listenAddr, mux)
	if err != nil {
		t.Fatalf("devTCPServerFromEnv() error = %v", err)
	}
	if server == nil {
		t.Fatal("devTCPServerFromEnv() server = nil, want tcp server")
	}
	if server.Addr != listenAddr {
		t.Fatalf("devTCPServerFromEnv() addr = %q, want %q", server.Addr, listenAddr)
	}
	if server.Handler != mux {
		t.Fatal("devTCPServerFromEnv() did not preserve handler")
	}
	if server.ReadHeaderTimeout != 5*time.Second {
		t.Fatalf("devTCPServerFromEnv() ReadHeaderTimeout = %v, want 5s", server.ReadHeaderTimeout)
	}
	if transports != "unix+tcp(dev)" {
		t.Fatalf("devTCPServerFromEnv() transports = %q, want unix+tcp(dev)", transports)
	}
}

func TestDevTCPServerRejectsNonLoopbackAddress(t *testing.T) {
	t.Setenv(devTCPEnv, "1")

	server, transports, err := devTCPServerFromEnv("0.0.0.0:8786", http.NewServeMux())
	if err == nil {
		t.Fatal("devTCPServerFromEnv() error = nil, want non-loopback rejection")
	}
	if server != nil {
		t.Fatalf("devTCPServerFromEnv() server = %#v, want nil", server)
	}
	if transports != "" {
		t.Fatalf("devTCPServerFromEnv() transports = %q, want empty on error", transports)
	}
	if !strings.Contains(err.Error(), "non-loopback address") {
		t.Fatalf("devTCPServerFromEnv() error = %v, want non-loopback address", err)
	}
}

func TestServeUntilStoppedAllowsNilTCPServer(t *testing.T) {
	listenerErr := errors.New("listener failed")

	err := serveUntilStopped(nil, &http.Server{}, failingListener{err: listenerErr}, nil)
	if !errors.Is(err, listenerErr) {
		t.Fatalf("serveUntilStopped() error = %v, want %v", err, listenerErr)
	}
}

func unsetEnv(t *testing.T, key string) {
	t.Helper()

	old, ok := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("unset %s: %v", key, err)
	}
	t.Cleanup(func() {
		var err error
		if ok {
			err = os.Setenv(key, old)
		} else {
			err = os.Unsetenv(key)
		}
		if err != nil {
			t.Errorf("restore %s: %v", key, err)
		}
	})
}

type failingListener struct {
	err error
}

func (l failingListener) Accept() (net.Conn, error) {
	return nil, l.err
}

func (l failingListener) Close() error {
	return nil
}

func (l failingListener) Addr() net.Addr {
	return failingAddr("unix")
}

type failingAddr string

func (a failingAddr) Network() string {
	return string(a)
}

func (a failingAddr) String() string {
	return string(a)
}
