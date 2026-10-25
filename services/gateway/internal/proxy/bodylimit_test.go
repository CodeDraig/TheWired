package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const kb = 1024

// A declared Content-Length over the cap is refused up front with 413, before
// a byte reaches the backend.
func TestBodyLimit_DeclaredOversizeIs413(t *testing.T) {
	called := false
	h := BodyLimitMiddleware(4*kb, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest("POST", "http://gateway/api/spaces", strings.NewReader(strings.Repeat("x", 5*kb)))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", rr.Code)
	}
	if called {
		t.Fatal("backend must not be reached")
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil || body.Code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("code = %q (%v), want PAYLOAD_TOO_LARGE", body.Code, err)
	}
}

// Without a Content-Length (chunked) the body is wrapped in MaxBytesReader so
// the backend read stops at the cap.
func TestBodyLimit_ChunkedOversizeStopsAtCap(t *testing.T) {
	var readErr error
	h := BodyLimitMiddleware(4*kb, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest("POST", "http://gateway/api/spaces", strings.NewReader(strings.Repeat("x", 5*kb)))
	req.ContentLength = -1 // unknown length
	h.ServeHTTP(httptest.NewRecorder(), req)
	var mbe *http.MaxBytesError
	if !errors.As(readErr, &mbe) {
		t.Fatalf("expected MaxBytesError from the capped body, got %v", readErr)
	}
}

func TestBodyLimit_SmallBodyPassesIntact(t *testing.T) {
	var got string
	h := BodyLimitMiddleware(4*kb, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest("POST", "http://gateway/api/spaces", strings.NewReader(`{"ok":1}`))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || got != `{"ok":1}` {
		t.Fatalf("small body must pass intact: %d %q", rr.Code, got)
	}
}

// Upload routes stream files far larger than the JSON cap and are exempt.
func TestBodyLimit_UploadRoutesExempt(t *testing.T) {
	for _, path := range []string{"/api/music/upload", "/api/music/upload/cover"} {
		called := false
		h := BodyLimitMiddleware(4*kb, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			w.WriteHeader(http.StatusOK)
		}))
		req := httptest.NewRequest("POST", "http://gateway"+path, strings.NewReader(strings.Repeat("x", 50*kb)))
		req.Header.Set("Content-Type", "multipart/form-data; boundary=b")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK || !called {
			t.Fatalf("%s: upload route must be exempt, got %d", path, rr.Code)
		}
	}
}

func TestBodyLimit_ZeroDisables(t *testing.T) {
	called := false
	h := BodyLimitMiddleware(0, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest("POST", "http://gateway/api/spaces", strings.NewReader(strings.Repeat("x", 50*kb)))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if !called {
		t.Fatalf("limit 0 must disable the cap, got %d", rr.Code)
	}
}
