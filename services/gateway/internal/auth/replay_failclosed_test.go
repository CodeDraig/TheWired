package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type erroringReplayGuard struct{}

func (erroringReplayGuard) Reserve(context.Context, string) (bool, error) {
	return false, errors.New("redis: connection refused")
}

func replayFailClosedHandler(failClosed bool, inner http.Handler) http.Handler {
	return NIP98MiddlewareWithOptions(Options{Replay: erroringReplayGuard{}, ReplayFailClosed: failClosed}, inner)
}

// RATE_LIMIT_FAIL_MODE=closed: with the replay store down, a write cannot be
// proven single-use, so it is refused (503) rather than let through.
func TestReplay_FailClosed_WritesGet503(t *testing.T) {
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		inner := &captureHandler{}
		h := replayFailClosedHandler(true, inner)
		url := "http://localhost:9080/api/spaces"
		req := httptest.NewRequest(method, url, strings.NewReader("{}"))
		req.Header.Set("Authorization", signedAuthHeaderWithTags(t, method, url, nil))
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: expected 503, got %d", method, rr.Code)
		}
		if inner.called {
			t.Fatalf("%s: backend must not be reached", method)
		}
		var body struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil || body.Code != "SERVICE_UNAVAILABLE" {
			t.Fatalf("%s: code = %q (%v)", method, body.Code, err)
		}
	}
}

// Reads are idempotent: a replayed GET leaks nothing new, so they always fail
// open and the API stays up through a Redis blip.
func TestReplay_FailClosed_ReadsStillPass(t *testing.T) {
	inner := &captureHandler{}
	h := replayFailClosedHandler(true, inner)
	url := "http://localhost:9080/api/spaces"
	req := httptest.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", signedAuthHeaderWithTags(t, "GET", url, nil))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !inner.hasPubkey {
		t.Fatalf("GET must fail open: %d pubkey=%v", rr.Code, inner.hasPubkey)
	}
}

// Default mode (open) keeps today's behaviour for writes too.
func TestReplay_FailOpen_WritesPass(t *testing.T) {
	inner := &captureHandler{}
	h := replayFailClosedHandler(false, inner)
	url := "http://localhost:9080/api/spaces"
	req := httptest.NewRequest("POST", url, strings.NewReader("{}"))
	req.Header.Set("Authorization", signedAuthHeaderWithTags(t, "POST", url, nil))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fail-open POST: expected 200, got %d", rr.Code)
	}
}
