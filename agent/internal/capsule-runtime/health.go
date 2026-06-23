package capsuleruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vita/agent/internal/jsonsafe"
)

const (
	defaultSystemctlPath = "/usr/bin/systemctl"

	maxCheckNameLength = 128
	maxTargetLength    = 2048
)

type CheckType string

const (
	CheckTypeHTTP      CheckType = "http"
	CheckTypeTCP       CheckType = "tcp"
	CheckTypeLifecycle CheckType = "lifecycle"
)

type Status string

const (
	StatusOK        Status = "OK"
	StatusUnhealthy Status = "unhealthy"
	StatusDown      Status = "down"
	StatusUnknown   Status = "unknown"
)

type Check struct {
	Name            string        `json:"name"`
	Type            CheckType     `json:"type"`
	Target          string        `json:"target"`
	IntervalSeconds int64         `json:"intervalSeconds"`
	TimeoutSeconds  int64         `json:"timeoutSeconds"`
	Interval        time.Duration `json:"-"`
	Timeout         time.Duration `json:"-"`
	Jitter          time.Duration `json:"-"`
}

func (c *Check) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return err
	}

	var wire struct {
		Name            string    `json:"name"`
		Type            CheckType `json:"type"`
		Target          string    `json:"target"`
		IntervalSeconds int64     `json:"intervalSeconds"`
		TimeoutSeconds  int64     `json:"timeoutSeconds"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("body must contain exactly one JSON value")
		}
		return err
	}

	check := Check{
		Name:            wire.Name,
		Type:            wire.Type,
		Target:          wire.Target,
		IntervalSeconds: wire.IntervalSeconds,
		TimeoutSeconds:  wire.TimeoutSeconds,
	}
	if err := check.Validate(); err != nil {
		return err
	}

	*c = check
	return nil
}

func (c Check) Validate() error {
	if !validCheckName(c.Name) {
		return fmt.Errorf("health check name must be a safe non-empty string")
	}
	switch c.Type {
	case CheckTypeHTTP:
		if err := validateHTTPTarget(c.Target); err != nil {
			return err
		}
	case CheckTypeTCP:
		if err := validateTCPTarget(c.Target); err != nil {
			return err
		}
	case CheckTypeLifecycle:
		if c.Target != "self" && c.Target != "unit" {
			if err := validateLifecycleTarget(c.Target); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("health check type must be http, tcp, or lifecycle")
	}
	if c.intervalDuration() <= 0 {
		return fmt.Errorf("health check intervalSeconds must be positive")
	}
	if c.timeoutDuration() <= 0 {
		return fmt.Errorf("health check timeoutSeconds must be positive")
	}
	return nil
}

type WorkloadSpec struct {
	ID     string
	Unit   string
	Checks []Check
}

type WorkloadStatus struct {
	ID       string `json:"id"`
	Unit     string `json:"unit"`
	Status   Status `json:"status"`
	Health   Status `json:"health"`
	Restarts int    `json:"restarts"`
}

type Prober interface {
	PollHealth(context.Context, Check) (Status, error)
	Restarts(context.Context, string) (int, error)
}

type ProbeFunc func(context.Context, Check) (Status, error)

func (f ProbeFunc) PollHealth(ctx context.Context, check Check) (Status, error) {
	return f(ctx, check)
}

func (f ProbeFunc) Restarts(context.Context, string) (int, error) {
	return 0, nil
}

type Options struct {
	Prober Prober
	Jitter func(WorkloadSpec, Check) time.Duration
}

type Supervisor struct {
	mu        sync.Mutex
	workloads map[string]*workloadState
	prober    Prober
	jitter    func(WorkloadSpec, Check) time.Duration
}

type workloadState struct {
	id       string
	unit     string
	cancel   context.CancelFunc
	statuses map[string]Status
	restarts int
}

func NewSupervisor(options Options) *Supervisor {
	prober := options.Prober
	if prober == nil {
		prober = defaultProber
	}

	jitter := options.Jitter
	if jitter == nil {
		jitter = defaultJitter
	}

	return &Supervisor{
		workloads: make(map[string]*workloadState),
		prober:    prober,
		jitter:    jitter,
	}
}

func (s *Supervisor) StartWorkload(spec WorkloadSpec) {
	if s == nil || spec.ID == "" || spec.Unit == "" {
		return
	}
	checks, err := ChecksForUnit(spec.Checks, spec.Unit)
	if err != nil {
		return
	}
	spec.Checks = checks

	ctx, cancel := context.WithCancel(context.Background())
	state := &workloadState{
		id:       spec.ID,
		unit:     spec.Unit,
		cancel:   cancel,
		statuses: make(map[string]Status, len(spec.Checks)),
	}
	for i, check := range spec.Checks {
		state.statuses[checkKey(i, check)] = StatusUnknown
	}

	s.mu.Lock()
	if existing, ok := s.workloads[spec.Unit]; ok {
		existing.cancel()
	}
	s.workloads[spec.Unit] = state
	s.mu.Unlock()

	for i, check := range spec.Checks {
		key := checkKey(i, check)
		s.pollCheck(ctx, spec, state, key, check)
		go s.runCheck(ctx, spec, state, key, check)
	}
}

func (s *Supervisor) StopWorkload(unit string) {
	if s == nil || unit == "" {
		return
	}

	s.mu.Lock()
	state, ok := s.workloads[unit]
	if ok {
		delete(s.workloads, unit)
	}
	s.mu.Unlock()

	if ok {
		state.cancel()
	}
}

func (s *Supervisor) Snapshot() []WorkloadStatus {
	if s == nil {
		return []WorkloadStatus{}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]WorkloadStatus, 0, len(s.workloads))
	for _, state := range s.workloads {
		status := aggregateStatus(state.statuses)
		out = append(out, WorkloadStatus{
			ID:       state.id,
			Unit:     state.unit,
			Status:   status,
			Health:   status,
			Restarts: state.restarts,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ID != out[j].ID {
			return out[i].ID < out[j].ID
		}
		return out[i].Unit < out[j].Unit
	})
	return out
}

func (s *Supervisor) runCheck(ctx context.Context, spec WorkloadSpec, state *workloadState, key string, check Check) {
	for {
		timer := time.NewTimer(s.nextDelay(spec, check))
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return
		case <-timer.C:
			s.pollCheck(ctx, spec, state, key, check)
		}
	}
}

func (s *Supervisor) pollCheck(ctx context.Context, spec WorkloadSpec, expected *workloadState, key string, check Check) {
	status, err := s.prober.PollHealth(ctx, check)
	if err != nil {
		status = StatusUnknown
	}
	if !validStatus(status) {
		status = StatusUnknown
	}
	if err := ctx.Err(); err != nil {
		return
	}

	var restarts *int
	if check.Type == CheckTypeLifecycle {
		if value, err := s.prober.Restarts(ctx, spec.Unit); err == nil && value >= 0 {
			restarts = &value
		}
	}
	if err := ctx.Err(); err != nil {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.workloads[spec.Unit]
	if !ok || state != expected {
		return
	}
	state.statuses[key] = status
	if restarts != nil {
		state.restarts = *restarts
	}
}

func (s *Supervisor) nextDelay(spec WorkloadSpec, check Check) time.Duration {
	delay := check.intervalDuration()
	if delay <= 0 {
		delay = time.Second
	}

	jitter := check.Jitter
	if s.jitter != nil {
		jitter += s.jitter(spec, check)
	}
	if jitter < 0 {
		jitter = 0
	}
	return delay + jitter
}

func PollHealth(ctx context.Context, check Check) (Status, error) {
	return defaultProber.PollHealth(ctx, check)
}

type healthProber struct {
	systemctl systemctlClient
}

var defaultProber = healthProber{
	systemctl: commandSystemctl{path: defaultSystemctlPath},
}

func (p healthProber) PollHealth(ctx context.Context, check Check) (Status, error) {
	if err := ctx.Err(); err != nil {
		return StatusUnknown, err
	}
	if err := check.Validate(); err != nil {
		return StatusUnknown, err
	}

	switch check.Type {
	case CheckTypeHTTP:
		return pollHTTP(ctx, check)
	case CheckTypeTCP:
		return pollTCP(ctx, check)
	case CheckTypeLifecycle:
		systemctl := p.systemctl
		if systemctl == nil {
			systemctl = commandSystemctl{path: defaultSystemctlPath}
		}
		return pollLifecycle(ctx, check, systemctl)
	default:
		return StatusUnknown, fmt.Errorf("unsupported health check type %q", check.Type)
	}
}

func (p healthProber) Restarts(ctx context.Context, unit string) (int, error) {
	systemctl := p.systemctl
	if systemctl == nil {
		systemctl = commandSystemctl{path: defaultSystemctlPath}
	}
	return systemctl.Restarts(ctx, unit)
}

func pollHTTP(ctx context.Context, check Check) (Status, error) {
	target, err := url.Parse(check.Target)
	if err != nil {
		return StatusUnknown, fmt.Errorf("parse http health target: %w", err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return StatusUnknown, fmt.Errorf("http health target must use http or https")
	}
	if !isLoopbackHost(target.Hostname()) {
		return StatusUnknown, fmt.Errorf("http health target must be loopback")
	}

	probeCtx, cancel := context.WithTimeout(ctx, check.timeoutDuration())
	defer cancel()

	request, err := http.NewRequestWithContext(probeCtx, http.MethodGet, target.String(), nil)
	if err != nil {
		return StatusUnknown, fmt.Errorf("build http health request: %w", err)
	}

	dialer := &net.Dialer{Timeout: check.timeoutDuration()}
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, network string, address string) (net.Conn, error) {
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return nil, err
				}
				if !isLoopbackHost(host) {
					return nil, fmt.Errorf("http health dial target must be loopback")
				}
				return dialer.DialContext(ctx, network, address)
			},
		},
	}

	response, err := client.Do(request)
	if err != nil {
		return StatusUnknown, fmt.Errorf("http health probe failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode >= 200 && response.StatusCode < 400 {
		return StatusOK, nil
	}
	return StatusUnhealthy, nil
}

func pollTCP(ctx context.Context, check Check) (Status, error) {
	if err := validateTCPTarget(check.Target); err != nil {
		return StatusUnknown, err
	}
	host, _, _ := net.SplitHostPort(check.Target)
	if !isLoopbackHost(host) {
		return StatusUnknown, fmt.Errorf("tcp health target must be loopback")
	}

	probeCtx, cancel := context.WithTimeout(ctx, check.timeoutDuration())
	defer cancel()

	dialer := &net.Dialer{Timeout: check.timeoutDuration()}
	conn, err := dialer.DialContext(probeCtx, "tcp", check.Target)
	if err != nil {
		if isConnectionRefused(err) {
			return StatusDown, nil
		}
		return StatusUnknown, fmt.Errorf("tcp health probe failed: %w", err)
	}
	if err := conn.Close(); err != nil {
		return StatusUnknown, fmt.Errorf("close tcp health probe: %w", err)
	}
	return StatusOK, nil
}

func pollLifecycle(ctx context.Context, check Check, systemctl systemctlClient) (Status, error) {
	if err := validateLifecycleTarget(check.Target); err != nil {
		return StatusUnknown, err
	}

	probeCtx, cancel := context.WithTimeout(ctx, check.timeoutDuration())
	defer cancel()

	active, err := systemctl.IsActive(probeCtx, check.Target)
	if err != nil {
		return StatusUnknown, fmt.Errorf("read lifecycle active state: %w", err)
	}
	if active {
		return StatusOK, nil
	}

	properties, err := systemctl.Properties(probeCtx, check.Target)
	if err != nil {
		return StatusUnknown, fmt.Errorf("read lifecycle unit state: %w", err)
	}
	if properties.down() {
		return StatusDown, nil
	}
	return StatusUnknown, fmt.Errorf("lifecycle unit state is %s/%s", properties.ActiveState, properties.SubState)
}

type UnitProperties struct {
	ActiveState string
	SubState    string
	Result      string
	Restarts    int
}

func (p UnitProperties) down() bool {
	switch p.ActiveState {
	case "failed", "inactive", "deactivating":
		return true
	}
	switch p.SubState {
	case "failed", "dead", "exited":
		return true
	}
	return p.Result != "" && p.Result != "success"
}

type systemctlClient interface {
	IsActive(context.Context, string) (bool, error)
	Properties(context.Context, string) (UnitProperties, error)
	Restarts(context.Context, string) (int, error)
}

type commandSystemctl struct {
	path string
}

func (s commandSystemctl) IsActive(ctx context.Context, unit string) (bool, error) {
	output, err := exec.CommandContext(ctx, s.path, "is-active", "--quiet", unit).CombinedOutput()
	if err == nil {
		return true, nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return false, ctxErr
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return false, nil
	}
	return false, fmt.Errorf("systemctl is-active %s: %w: %s", unit, err, strings.TrimSpace(string(output)))
}

func (s commandSystemctl) Properties(ctx context.Context, unit string) (UnitProperties, error) {
	output, err := exec.CommandContext(
		ctx,
		s.path,
		"show",
		"--property=ActiveState",
		"--property=SubState",
		"--property=Result",
		"--property=NRestarts",
		unit,
	).CombinedOutput()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return UnitProperties{}, ctxErr
		}
		return UnitProperties{}, fmt.Errorf("systemctl show %s: %w: %s", unit, err, strings.TrimSpace(string(output)))
	}
	return parseUnitProperties(output)
}

func (s commandSystemctl) Restarts(ctx context.Context, unit string) (int, error) {
	output, err := exec.CommandContext(ctx, s.path, "show", "--property=NRestarts", "--value", unit).CombinedOutput()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return 0, ctxErr
		}
		return 0, fmt.Errorf("systemctl show restarts %s: %w: %s", unit, err, strings.TrimSpace(string(output)))
	}
	value := strings.TrimSpace(string(output))
	if value == "" {
		return 0, nil
	}
	restarts, err := strconv.Atoi(value)
	if err != nil || restarts < 0 {
		return 0, fmt.Errorf("systemctl show restarts %s returned invalid value %q", unit, value)
	}
	return restarts, nil
}

func parseUnitProperties(raw []byte) (UnitProperties, error) {
	properties := UnitProperties{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "ActiveState":
			properties.ActiveState = value
		case "SubState":
			properties.SubState = value
		case "Result":
			properties.Result = value
		case "NRestarts":
			if value == "" {
				continue
			}
			restarts, err := strconv.Atoi(value)
			if err != nil || restarts < 0 {
				return UnitProperties{}, fmt.Errorf("invalid NRestarts value %q", value)
			}
			properties.Restarts = restarts
		}
	}
	return properties, nil
}

func aggregateStatus(statuses map[string]Status) Status {
	if len(statuses) == 0 {
		return StatusUnknown
	}

	hasUnhealthy := false
	hasUnknown := false
	for _, status := range statuses {
		switch status {
		case StatusDown:
			return StatusDown
		case StatusUnhealthy:
			hasUnhealthy = true
		case StatusUnknown:
			hasUnknown = true
		case StatusOK:
		default:
			hasUnknown = true
		}
	}
	if hasUnhealthy {
		return StatusUnhealthy
	}
	if hasUnknown {
		return StatusUnknown
	}
	return StatusOK
}

func defaultJitter(spec WorkloadSpec, check Check) time.Duration {
	interval := check.intervalDuration()
	if interval <= 0 {
		return 0
	}
	maxJitter := interval / 10
	if maxJitter > time.Second {
		maxJitter = time.Second
	}
	if maxJitter <= 0 {
		return 0
	}

	hash := fnv.New64a()
	_, _ = hash.Write([]byte(spec.ID))
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(spec.Unit))
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(check.Name))
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(check.Type))
	return time.Duration(hash.Sum64() % uint64(maxJitter+1))
}

func checkKey(index int, check Check) string {
	return strconv.Itoa(index) + ":" + check.Name
}

func ChecksForUnit(checks []Check, unit string) ([]Check, error) {
	out := make([]Check, len(checks))
	copy(out, checks)
	for i := range out {
		if err := out[i].Validate(); err != nil {
			return nil, fmt.Errorf("health check %d: %w", i, err)
		}
		if out[i].Type != CheckTypeLifecycle {
			continue
		}
		switch out[i].Target {
		case "self", "unit":
			if err := validateLifecycleTarget(unit); err != nil {
				return nil, fmt.Errorf("health check %d lifecycle unit: %w", i, err)
			}
			out[i].Target = unit
		case unit:
		default:
			return nil, fmt.Errorf("health check %d lifecycle target must be the capsule unit", i)
		}
	}
	return out, nil
}

func checksForWorkload(spec WorkloadSpec) []Check {
	checks, err := ChecksForUnit(spec.Checks, spec.Unit)
	if err != nil {
		return []Check{}
	}
	return checks
}

func (c Check) intervalDuration() time.Duration {
	if c.Interval > 0 {
		return c.Interval
	}
	return time.Duration(c.IntervalSeconds) * time.Second
}

func (c Check) timeoutDuration() time.Duration {
	if c.Timeout > 0 {
		return c.Timeout
	}
	return time.Duration(c.TimeoutSeconds) * time.Second
}

func validStatus(status Status) bool {
	switch status {
	case StatusOK, StatusUnhealthy, StatusDown, StatusUnknown:
		return true
	default:
		return false
	}
}

func validCheckName(value string) bool {
	if value == "" || len(value) > maxCheckNameLength || value != strings.TrimSpace(value) || hasControl(value) {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '.', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

func validateHTTPTarget(target string) error {
	if !validTargetString(target) {
		return fmt.Errorf("http health target must be a safe non-empty string")
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return fmt.Errorf("parse http health target: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("http health target must use http or https")
	}
	if parsed.Host == "" {
		return fmt.Errorf("http health target must include a host")
	}
	if !isLoopbackHost(parsed.Hostname()) {
		return fmt.Errorf("http health target must be loopback")
	}
	return nil
}

func validateTCPTarget(target string) error {
	if !validTargetString(target) {
		return fmt.Errorf("tcp health target must be a safe non-empty string")
	}
	if _, _, err := net.SplitHostPort(target); err != nil {
		return fmt.Errorf("tcp health target must be host:port: %w", err)
	}
	host, _, _ := net.SplitHostPort(target)
	if !isLoopbackHost(host) {
		return fmt.Errorf("tcp health target must be loopback")
	}
	return nil
}

func validateLifecycleTarget(target string) error {
	if !validTargetString(target) {
		return fmt.Errorf("lifecycle health target must be a safe non-empty string")
	}
	if strings.ContainsAny(target, `/\`) || strings.HasPrefix(target, ".") || strings.Contains(target, "..") {
		return fmt.Errorf("lifecycle health target must be a systemd unit name")
	}
	if !strings.HasSuffix(target, ".service") {
		return fmt.Errorf("lifecycle health target must be a service unit")
	}
	for _, r := range target {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == ':', r == '.', r == '_', r == '@', r == '-':
		default:
			return fmt.Errorf("lifecycle health target must be a systemd unit name")
		}
	}
	return nil
}

func validTargetString(value string) bool {
	return value != "" && len(value) <= maxTargetLength && value == strings.TrimSpace(value) && !hasControl(value)
}

func hasControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isConnectionRefused(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "connection refused") ||
		strings.Contains(message, "actively refused") ||
		strings.Contains(message, "connection reset by peer")
}
