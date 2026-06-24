//go:build linux

package mesh

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/internal/sysdeps"
)

const meshTestThreadNetnsPath = "/proc/thread-self/ns/net"

func TestLinuxWireGuardMeshHandshakeReachAndDeny(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%06x", time.Now().UnixNano()&0xffffff)
	hostVeth := "vmh" + suffix
	peerVeth := "vmp" + suffix
	peerWG := "wgp" + suffix

	nodePort := freeUDPPort(t)
	peerPort := freeUDPPort(t)
	allowedPort := freeTCPPort(t)
	deniedPort := freeTCPPort(t)

	nodePrivate, nodePublic, nodePrivateText := generateWireGuardKey(t)
	peerPrivate, peerPublic, _ := generateWireGuardKey(t)
	if len(nodePrivate) != meshPrivateKeyBytes {
		t.Fatalf("node private key length = %d, want %d", len(nodePrivate), meshPrivateKeyBytes)
	}
	keyRoot := filepath.ToSlash(filepath.Join(t.TempDir(), "keys"))
	nodeKeyRef := writeTestPrivateKey(t, keyRoot, "node.key", nodePrivateText)

	peerNetns := createMeshTestNetns(t)
	defer peerNetns.Close()

	if err := sysdeps.CreateVeth(hostVeth, peerVeth); err != nil {
		skipIfRealOpUnavailable(t, err)
		t.Fatalf("CreateVeth returned error: %v", err)
	}
	t.Cleanup(func() {
		_ = sysdeps.DeleteLink(hostVeth)
	})
	if err := sysdeps.AddIPv4Address(hostVeth, "192.0.2.1/30"); err != nil {
		t.Fatalf("AddIPv4Address host underlay returned error: %v", err)
	}
	if err := sysdeps.SetLinkUp(hostVeth); err != nil {
		t.Fatalf("SetLinkUp host underlay returned error: %v", err)
	}
	if err := sysdeps.MoveLinkToNetns(peerVeth, int(peerNetns.Fd())); err != nil {
		t.Fatalf("MoveLinkToNetns returned error: %v", err)
	}
	withMeshTestNetns(t, peerNetns, func() {
		if err := sysdeps.AddIPv4Address(peerVeth, "192.0.2.2/30"); err != nil {
			t.Fatalf("AddIPv4Address peer underlay returned error: %v", err)
		}
		if err := sysdeps.SetLinkUp(peerVeth); err != nil {
			t.Fatalf("SetLinkUp peer underlay returned error: %v", err)
		}
	})

	keepalive := 1
	config := MeshConfig{
		PrivateKeyRef: nodeKeyRef,
		ListenPort:    nodePort,
		InterfaceCIDR: "10.221.75.0/24",
		Peers: []MeshPeer{
			{
				PublicKey:           base64.StdEncoding.EncodeToString(peerPublic),
				AllowedIPs:          []string{"10.221.75.2/32"},
				PersistentKeepalive: &keepalive,
				Services: []MeshService{
					{Proto: network.ProtoTCP, Port: allowedPort},
				},
			},
		},
	}
	capability := newCapability(defaultMeshSystem{}, keyRoot)
	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &config})
	if err != nil {
		skipIfRealOpUnavailable(t, err)
		t.Fatalf("mesh Apply returned error: %v", err)
	}
	t.Cleanup(func() {
		_ = undo.Undo(context.Background())
	})

	withMeshTestNetns(t, peerNetns, func() {
		if err := sysdeps.CreateWireGuardLink(peerWG); err != nil {
			skipIfRealOpUnavailable(t, err)
			t.Fatalf("CreateWireGuardLink peer returned error: %v", err)
		}
		t.Cleanup(func() {
			withMeshTestNetns(t, peerNetns, func() {
				_ = sysdeps.DeleteLink(peerWG)
			})
		})
		if err := sysdeps.SetWireGuardPrivateKey(peerWG, peerPrivate, peerPort); err != nil {
			t.Fatalf("SetWireGuardPrivateKey peer returned error: %v", err)
		}
		if err := sysdeps.ReplaceWireGuardPeers(peerWG, []sysdeps.WireGuardPeer{
			{
				PublicKey:           nodePublic,
				AllowedIPs:          []string{"10.221.75.1/32"},
				Endpoint:            net.JoinHostPort("192.0.2.1", strconv.Itoa(nodePort)),
				PersistentKeepalive: &keepalive,
			},
		}); err != nil {
			t.Fatalf("ReplaceWireGuardPeers peer returned error: %v", err)
		}
		if err := sysdeps.AddIPAddress(peerWG, "10.221.75.2/24"); err != nil {
			t.Fatalf("AddIPAddress peer WireGuard returned error: %v", err)
		}
		if err := sysdeps.SetLinkUp(peerWG); err != nil {
			t.Fatalf("SetLinkUp peer WireGuard returned error: %v", err)
		}
	})

	allowed := startMeshTCPListener(t, "10.221.75.1", allowedPort)
	defer allowed.Close()
	denied := startMeshTCPListener(t, "10.221.75.1", deniedPort)
	defer denied.Close()

	if err := dialMeshTCPFromNetns(peerNetns, "10.221.75.1", allowedPort, 2*time.Second); err != nil {
		t.Fatalf("declared service was not reachable over mesh: %v", err)
	}
	if err := waitForMeshHandshake("vita-mesh0", base64.StdEncoding.EncodeToString(peerPublic)); err != nil {
		t.Fatalf("mesh handshake was not observed: %v", err)
	}
	if err := dialMeshTCPFromNetns(peerNetns, "10.221.75.1", deniedPort, 750*time.Millisecond); err == nil {
		t.Fatalf("undeclared mesh port %d was reachable; default-deny failed", deniedPort)
	}

	normalized, err := normalizeMeshConfig(config, keyRoot)
	if err != nil {
		t.Fatalf("normalizeMeshConfig returned error: %v", err)
	}
	table, err := sysdeps.ListNftTable(normalized.NftFamily, normalized.NftTable)
	if err != nil {
		t.Fatalf("ListNftTable returned error: %v", err)
	}
	if err := verifyMeshNftTable(normalized, string(table)); err != nil {
		t.Fatalf("verifyMeshNftTable returned error: %v", err)
	}
}

func createMeshTestNetns(t *testing.T) *os.File {
	t.Helper()
	prior, err := os.Open(meshTestThreadNetnsPath)
	if err != nil {
		t.Fatalf("open current netns returned error: %v", err)
	}

	runtime.LockOSThread()
	if err := sysdeps.UnshareNetworkNamespace(); err != nil {
		runtime.UnlockOSThread()
		_ = prior.Close()
		skipIfRealOpUnavailable(t, err)
		t.Fatalf("UnshareNetworkNamespace returned error: %v", err)
	}
	if err := sysdeps.SetLoopbackUp(); err != nil {
		restoreErr := sysdeps.SetNetworkNamespace(int(prior.Fd()))
		if restoreErr == nil {
			runtime.UnlockOSThread()
		}
		_ = prior.Close()
		t.Fatalf("SetLoopbackUp in test netns returned error: %v", errors.Join(err, restoreErr))
	}

	target, openErr := os.Open(meshTestThreadNetnsPath)
	restoreErr := sysdeps.SetNetworkNamespace(int(prior.Fd()))
	if restoreErr == nil {
		runtime.UnlockOSThread()
	}
	_ = prior.Close()
	if openErr != nil {
		t.Fatalf("open target netns returned error: %v", openErr)
	}
	if restoreErr != nil {
		_ = target.Close()
		t.Fatalf("restore original netns returned error: %v", restoreErr)
	}
	return target
}

func withMeshTestNetns(t *testing.T, target *os.File, fn func()) {
	t.Helper()
	prior, err := os.Open(meshTestThreadNetnsPath)
	if err != nil {
		t.Fatalf("open current netns returned error: %v", err)
	}
	defer prior.Close()

	runtime.LockOSThread()
	if err := sysdeps.SetNetworkNamespace(int(target.Fd())); err != nil {
		runtime.UnlockOSThread()
		t.Fatalf("join target netns returned error: %v", err)
	}
	restored := false
	defer func() {
		if restored {
			runtime.UnlockOSThread()
		}
	}()
	defer func() {
		if restoreErr := sysdeps.SetNetworkNamespace(int(prior.Fd())); restoreErr != nil {
			t.Fatalf("restore original netns returned error: %v", restoreErr)
		}
		restored = true
	}()
	fn()
}

func generateWireGuardKey(t *testing.T) ([]byte, []byte, string) {
	t.Helper()
	privateBytes := make([]byte, meshPrivateKeyBytes)
	if _, err := rand.Read(privateBytes); err != nil {
		t.Fatalf("rand.Read returned error: %v", err)
	}
	privateKey, err := ecdh.X25519().NewPrivateKey(privateBytes)
	if err != nil {
		t.Fatalf("NewPrivateKey returned error: %v", err)
	}
	return privateBytes, privateKey.PublicKey().Bytes(), base64.StdEncoding.EncodeToString(privateBytes)
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket udp returned error: %v", err)
	}
	defer conn.Close()
	_, portText, err := net.SplitHostPort(conn.LocalAddr().String())
	if err != nil {
		t.Fatalf("SplitHostPort udp returned error: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("Atoi udp port returned error: %v", err)
	}
	return port
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen tcp returned error: %v", err)
	}
	defer listener.Close()
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort tcp returned error: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("Atoi tcp port returned error: %v", err)
	}
	return port
}

func startMeshTCPListener(t *testing.T, addr string, port int) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp4", net.JoinHostPort(addr, strconv.Itoa(port)))
	if err != nil {
		t.Fatalf("Listen %s:%d returned error: %v", addr, port, err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	return listener
}

func dialMeshTCPFromNetns(target *os.File, addr string, port int, timeout time.Duration) error {
	var dialErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		prior, err := os.Open(meshTestThreadNetnsPath)
		if err != nil {
			dialErr = err
			return
		}
		defer prior.Close()
		runtime.LockOSThread()
		if err := sysdeps.SetNetworkNamespace(int(target.Fd())); err != nil {
			runtime.UnlockOSThread()
			dialErr = err
			return
		}
		restored := false
		defer func() {
			if restored {
				runtime.UnlockOSThread()
			}
		}()
		defer func() {
			if err := sysdeps.SetNetworkNamespace(int(prior.Fd())); err != nil {
				dialErr = errors.Join(dialErr, err)
				return
			}
			restored = true
		}()
		dialer := net.Dialer{Timeout: timeout}
		conn, err := dialer.Dial("tcp4", net.JoinHostPort(addr, strconv.Itoa(port)))
		if err != nil {
			dialErr = err
			return
		}
		_ = conn.Close()
	}()
	<-done
	return dialErr
}

func waitForMeshHandshake(deviceName string, peerPublicKey string) error {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		device, err := sysdeps.WireGuardDevice(deviceName)
		if err != nil {
			return err
		}
		for _, peer := range device.Peers {
			if base64.StdEncoding.EncodeToString(peer.PublicKey) == peerPublicKey && peer.LastHandshakeUnix > 0 {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("latest handshake stayed zero")
}

func skipIfRealOpUnavailable(t *testing.T, err error) {
	t.Helper()
	code := sysdeps.ErrnoCode(err)
	switch code {
	case "EPERM", "EACCES", "ENOENT", "ENODEV", "EEXIST", "EOPNOTSUPP":
		t.Skipf("privileged mesh real-op unavailable (%s): %v", code, err)
	}
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "operation not permitted") ||
		strings.Contains(lower, "not supported") ||
		strings.Contains(lower, "no such file") ||
		strings.Contains(lower, "no such device") ||
		strings.Contains(lower, "file exists") {
		t.Skipf("privileged mesh real-op unavailable: %v", err)
	}
}
