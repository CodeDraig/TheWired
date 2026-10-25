package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// An unparsable BACKEND_URL used to be ignored (url.Parse error dropped) and
// surfaced as a 502 on every request. It is a boot-time configuration error.
func TestNewRouter_RejectsUnparsableBackendURL(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected NewRouter to panic on an unparsable backend URL")
		}
	}()
	NewRouter("http://[::1", nil)
}

func TestNewBlossomHandler_RejectsUnparsableBackendURL(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected NewBlossomHandler to panic on an unparsable backend URL")
		}
	}()
	NewBlossomHandler("://nope", nil)
}

func TestValidateBackendURL(t *testing.T) {
	if err := ValidateBackendURL("http://backend:3002"); err != nil {
		t.Fatalf("valid URL rejected: %v", err)
	}
	for _, bad := range []string{"", "backend:3002", "http://", "://x", "ftp://backend"} {
		if err := ValidateBackendURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// A backend that never sends headers must not pin a gateway goroutine (and
// the client) forever: the transport has a response-header timeout.
func TestReverseProxy_ResponseHeaderTimeout(t *testing.T) {
	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()
	defer close(release)

	rt := NewRouter(backend.URL, nil)
	rt.transport = newBackendTransport(100 * time.Millisecond)

	req := httptest.NewRequest("GET", "http://gateway/api/spaces", nil)
	rr := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		rt.Handler().ServeHTTP(rr, req)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("proxy hung on a backend that never answered")
	}
	if rr.Code != http.StatusBadGateway && rr.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 502/504, got %d", rr.Code)
	}
}
