package capabilities

import (
	"context"
	"errors"
	"testing"
)

type echoRequest struct {
	Message string
}

func (echoRequest) CapabilityRequest() {}

type echoResponse struct {
	Message string
}

func (echoResponse) CapabilityResponse() {}

type echoCapability struct {
	called bool
}

func (c *echoCapability) Name() string {
	return "test.echo"
}

func (c *echoCapability) Handle(_ context.Context, req TypedRequest) (TypedResponse, error) {
	c.called = true

	typedReq, ok := req.(echoRequest)
	if !ok {
		return nil, errors.New("unexpected request type")
	}

	return echoResponse{Message: typedReq.Message}, nil
}

func TestRegistryDispatchRoutesRegisteredCapability(t *testing.T) {
	capability := &echoCapability{}
	registry, err := NewRegistry(capability)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}

	response, err := registry.Dispatch(context.Background(), "test.echo", echoRequest{Message: "ok"})
	if err != nil {
		t.Fatalf("Dispatch returned error: %v", err)
	}

	typedResponse, ok := response.(echoResponse)
	if !ok {
		t.Fatalf("Dispatch returned %T, want echoResponse", response)
	}
	if typedResponse.Message != "ok" {
		t.Fatalf("Dispatch returned message %q, want %q", typedResponse.Message, "ok")
	}
	if !capability.called {
		t.Fatal("registered capability was not called")
	}
}

func TestRegistryDispatchUnknownCapabilityFailsClosed(t *testing.T) {
	capability := &echoCapability{}
	registry, err := NewRegistry(capability)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}

	response, err := registry.Dispatch(context.Background(), "test.missing", echoRequest{Message: "do not execute"})
	if response != nil {
		t.Fatalf("Dispatch returned response %v, want nil", response)
	}

	var unknown *UnknownCapabilityError
	if !errors.As(err, &unknown) {
		t.Fatalf("Dispatch error = %v, want UnknownCapabilityError", err)
	}
	if unknown.Name != "test.missing" {
		t.Fatalf("UnknownCapabilityError.Name = %q, want %q", unknown.Name, "test.missing")
	}
	if capability.called {
		t.Fatal("unknown dispatch called a registered capability")
	}
}
