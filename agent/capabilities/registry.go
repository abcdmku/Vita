package capabilities

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

// TypedRequest is implemented by explicit capability request structs.
type TypedRequest interface {
	CapabilityRequest()
}

// TypedResponse is implemented by explicit capability response structs.
type TypedResponse interface {
	CapabilityResponse()
}

// Capability is a narrow, typed operation exposed by the privileged agent.
type Capability interface {
	Name() string
	Handle(context.Context, TypedRequest) (TypedResponse, error)
}

type Registry struct {
	capabilities map[string]Capability
	names        []string
}

type UnknownCapabilityError struct {
	Name string
}

func (e *UnknownCapabilityError) Error() string {
	return fmt.Sprintf("unknown capability %q", e.Name)
}

type InvalidCapabilityError struct {
	Name   string
	Reason string
}

func (e *InvalidCapabilityError) Error() string {
	if e.Name == "" {
		return fmt.Sprintf("invalid capability: %s", e.Reason)
	}
	return fmt.Sprintf("invalid capability %q: %s", e.Name, e.Reason)
}

var ErrNilRequest = errors.New("nil typed request")

func NewRegistry(capabilities ...Capability) (*Registry, error) {
	registry := &Registry{
		capabilities: make(map[string]Capability, len(capabilities)),
		names:        make([]string, 0, len(capabilities)),
	}

	for _, capability := range capabilities {
		if capability == nil {
			return nil, &InvalidCapabilityError{Reason: "nil capability"}
		}

		name := capability.Name()
		if !validCapabilityName(name) {
			return nil, &InvalidCapabilityError{Name: name, Reason: "name must use only ASCII letters, digits, dot, underscore, or hyphen"}
		}
		if _, exists := registry.capabilities[name]; exists {
			return nil, &InvalidCapabilityError{Name: name, Reason: "duplicate registration"}
		}

		registry.capabilities[name] = capability
		registry.names = append(registry.names, name)
	}

	sort.Strings(registry.names)
	return registry, nil
}

func (r *Registry) Dispatch(ctx context.Context, name string, req TypedRequest) (TypedResponse, error) {
	if req == nil {
		return nil, ErrNilRequest
	}
	if r == nil {
		return nil, &UnknownCapabilityError{Name: name}
	}

	capability, ok := r.capabilities[name]
	if !ok {
		return nil, &UnknownCapabilityError{Name: name}
	}

	return capability.Handle(ctx, req)
}

func (r *Registry) Lookup(name string) (Capability, bool) {
	if r == nil {
		return nil, false
	}

	capability, ok := r.capabilities[name]
	return capability, ok
}

func (r *Registry) Names() []string {
	if r == nil {
		return []string{}
	}

	names := make([]string, len(r.names))
	copy(names, r.names)
	return names
}

func validCapabilityName(name string) bool {
	if name == "" {
		return false
	}

	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '.', r == '_', r == '-':
		default:
			return false
		}
	}

	return true
}
