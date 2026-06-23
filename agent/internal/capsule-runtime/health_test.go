package capsuleruntime

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestPollHealthHTTPStatusCodes(t *testing.T) {
	statusCode := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(statusCode)
	}))
	t.Cleanup(server.Close)

	check := Check{
		Name:            "ready",
		Type:            CheckTypeHTTP,
		Target:          server.URL,
		IntervalSeconds: 1,
		TimeoutSeconds:  1,
	}

	status, err := PollHealth(context.Background(), check)
	if err != nil {
		t.Fatalf("PollHealth 200 returned error: %v", err)
	}
	if status != StatusOK {
		t.Fatalf("PollHealth 200 = %q, want %q", status, StatusOK)
	}

	statusCode = http.StatusInternalServerError
	status, err = PollHealth(context.Background(), check)
	if err != nil {
		t.Fatalf("PollHealth 500 returned error: %v", err)
	}
	if status != StatusUnhealthy {
		t.Fatalf("PollHealth 500 = %q, want %q", status, StatusUnhealthy)
	}
}

func TestPollHealthTCP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen returned error: %v", err)
	}
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	check := Check{
		Name:            "port",
		Type:            CheckTypeTCP,
		Target:          listener.Addr().String(),
		IntervalSeconds: 1,
		TimeoutSeconds:  1,
	}

	status, err := PollHealth(context.Background(), check)
	if err != nil {
		t.Fatalf("PollHealth open tcp returned error: %v", err)
	}
	if status != StatusOK {
		t.Fatalf("PollHealth open tcp = %q, want %q", status, StatusOK)
	}

	if err := listener.Close(); err != nil {
		t.Fatalf("Close listener returned error: %v", err)
	}
	<-acceptDone

	status, err = PollHealth(context.Background(), check)
	if err != nil {
		t.Fatalf("PollHealth closed tcp returned error: %v", err)
	}
	if status != StatusDown {
		t.Fatalf("PollHealth closed tcp = %q, want %q", status, StatusDown)
	}
}

func TestPollHealthLifecycle(t *testing.T) {
	prober := healthProber{
		systemctl: &fakeSystemctl{
			active: map[string]bool{
				"vita-capsule-ok.service": true,
			},
			properties: map[string]UnitProperties{
				"vita-capsule-failed.service": {
					ActiveState: "failed",
					SubState:    "failed",
					Result:      "exit-code",
				},
			},
		},
	}

	activeCheck := Check{
		Name:            "lifecycle",
		Type:            CheckTypeLifecycle,
		Target:          "vita-capsule-ok.service",
		IntervalSeconds: 1,
		TimeoutSeconds:  1,
	}
	status, err := prober.PollHealth(context.Background(), activeCheck)
	if err != nil {
		t.Fatalf("active lifecycle returned error: %v", err)
	}
	if status != StatusOK {
		t.Fatalf("active lifecycle status = %q, want %q", status, StatusOK)
	}

	failedCheck := activeCheck
	failedCheck.Target = "vita-capsule-failed.service"
	status, err = prober.PollHealth(context.Background(), failedCheck)
	if err != nil {
		t.Fatalf("failed lifecycle returned error: %v", err)
	}
	if status != StatusDown {
		t.Fatalf("failed lifecycle status = %q, want %q", status, StatusDown)
	}
}

func TestPollHealthFailsClosedOnProbeError(t *testing.T) {
	prober := healthProber{
		systemctl: &fakeSystemctl{
			err: errors.New("systemctl unavailable"),
		},
	}
	check := Check{
		Name:            "lifecycle",
		Type:            CheckTypeLifecycle,
		Target:          "vita-capsule-test.service",
		IntervalSeconds: 1,
		TimeoutSeconds:  1,
	}

	status, err := prober.PollHealth(context.Background(), check)
	if err == nil {
		t.Fatal("PollHealth returned nil error, want probe error")
	}
	if status != StatusUnknown {
		t.Fatalf("PollHealth on probe error = %q, want %q", status, StatusUnknown)
	}
}

func TestSupervisorPollerUpdatesWorkloadStatus(t *testing.T) {
	prober := &mutableProber{
		status:   StatusOK,
		restarts: 1,
	}
	supervisor := NewSupervisor(Options{
		Prober: prober,
		Jitter: func(WorkloadSpec, Check) time.Duration {
			return 0
		},
	})
	check := Check{
		Name:            "lifecycle",
		Type:            CheckTypeLifecycle,
		Target:          "vita-capsule-test.service",
		IntervalSeconds: 1,
		TimeoutSeconds:  1,
		Interval:        10 * time.Millisecond,
		Timeout:         10 * time.Millisecond,
	}

	supervisor.StartWorkload(WorkloadSpec{
		ID:     "local.test.capsule",
		Unit:   "vita-capsule-test.service",
		Checks: []Check{check},
	})
	t.Cleanup(func() {
		supervisor.StopWorkload("vita-capsule-test.service")
	})

	waitForWorkloadStatus(t, supervisor, StatusOK, 1)

	prober.set(StatusDown, 2)
	waitForWorkloadStatus(t, supervisor, StatusDown, 2)

	if calls := prober.calls(); calls < 2 {
		t.Fatalf("poll calls = %d, want at least 2", calls)
	}
}

func waitForWorkloadStatus(t *testing.T, supervisor *Supervisor, want Status, wantRestarts int) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot := supervisor.Snapshot()
		if len(snapshot) == 1 && snapshot[0].Status == want && snapshot[0].Health == want && snapshot[0].Restarts == wantRestarts {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("workload status did not become %q restarts=%d; snapshot=%#v", want, wantRestarts, supervisor.Snapshot())
}

type fakeSystemctl struct {
	active     map[string]bool
	properties map[string]UnitProperties
	restarts   map[string]int
	err        error
}

func (s *fakeSystemctl) IsActive(_ context.Context, unit string) (bool, error) {
	if s.err != nil {
		return false, s.err
	}
	if s.active == nil {
		return false, nil
	}
	return s.active[unit], nil
}

func (s *fakeSystemctl) Properties(_ context.Context, unit string) (UnitProperties, error) {
	if s.err != nil {
		return UnitProperties{}, s.err
	}
	if s.properties == nil {
		return UnitProperties{}, nil
	}
	return s.properties[unit], nil
}

func (s *fakeSystemctl) Restarts(_ context.Context, unit string) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	if s.restarts == nil {
		return 0, nil
	}
	return s.restarts[unit], nil
}

type mutableProber struct {
	mu       sync.Mutex
	status   Status
	restarts int
	count    int
}

func (p *mutableProber) PollHealth(context.Context, Check) (Status, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.count++
	return p.status, nil
}

func (p *mutableProber) Restarts(context.Context, string) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.restarts, nil
}

func (p *mutableProber) set(status Status, restarts int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.status = status
	p.restarts = restarts
}

func (p *mutableProber) calls() int {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.count
}
