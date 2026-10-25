package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/thewired/gateway/internal/config"
	"github.com/thewired/gateway/internal/gatewayauth"
	"github.com/thewired/gateway/internal/ratelimit"
)

const sha = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34"

// newTestGateway wires the real handler tree against a fake backend. Redis is
// unreachable (port 1) and fail mode is open, so the limiter passes everything.
func newTestGateway(t *testing.T, backend http.Handler, tweak func(*config.Config)) (http.Handler, *httptest.Server) {
	t.Helper()
	be := httptest.NewServer(backend)
	t.Cleanup(be.Close)
	cfg := &config.Config{
		BackendURL:          be.URL,
		RedisURL:            "redis://localhost:1",
		TrustedProxies:      nil,
		AllowedOrigins:      []string{"*"},
		RateLimitFailMode:   "open",
		AuthFailPerMin:      3,
		MaxAPIBodyBytes:     4 << 10,
		GatewaySharedSecret: "test-secret",
	}
	if tweak != nil {
		tweak(cfg)
	}
	limiter, err := ratelimit.NewLimiter(cfg.RedisURL, ratelimit.DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	return buildHandler(cfg, limiter, nil, gatewayauth.NewSigner(cfg.GatewaySharedSecret)), be
}

func backend401() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
}

// The Blossom upload/list routes skip NIP-98 at the gateway (the backend checks
// kind 24242), so their 401s were never counted: a brute-force of the upload
// auth cost nothing. They now sit inside the same per-IP auth-fail guard.
func TestServer_BlossomUploadAuthFailuresAreThrottled(t *testing.T) {
	h, _ := newTestGateway(t, backend401(), nil)
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("PUT", "http://gateway/upload", strings.NewReader("blob"))
		req.RemoteAddr = "203.0.113.20:1000"
		req.Header.Set("Authorization", "Nostr bogus")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected backend 401 passthrough, got %d", i, rr.Code)
		}
	}
	req := httptest.NewRequest("PUT", "http://gateway/upload", strings.NewReader("blob"))
	req.RemoteAddr = "203.0.113.20:1000"
	req.Header.Set("Authorization", "Nostr bogus")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("4th failed upload auth from one IP: expected 429, got %d", rr.Code)
	}
}

// The blob catch-all runs optional NIP-98: a garbage Authorization costs a
// verify attempt and 401s there, so it is guarded too.
func TestServer_BlobCatchAllAuthFailuresAreThrottled(t *testing.T) {
	h, _ := newTestGateway(t, backend401(), nil)
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "http://gateway/"+sha, nil)
		req.RemoteAddr = "203.0.113.21:1000"
		req.Header.Set("Authorization", "Nostr !!!")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401, got %d", i, rr.Code)
		}
	}
	req := httptest.NewRequest("GET", "http://gateway/"+sha, nil)
	req.RemoteAddr = "203.0.113.21:1000"
	req.Header.Set("Authorization", "Nostr !!!")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after repeated 401s, got %d", rr.Code)
	}
}

// Unauthenticated blob/HLS fetches are never counted or throttled.
func TestServer_AnonymousBlobFetchNotThrottled(t *testing.T) {
	h, _ := newTestGateway(t, backend401(), nil)
	for i := 0; i < 6; i++ {
		req := httptest.NewRequest("GET", "http://gateway/hls/"+sha+"/master.m3u8", nil)
		req.RemoteAddr = "203.0.113.22:1000"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code == http.StatusTooManyRequests {
			t.Fatalf("anonymous HLS fetch %d was throttled", i)
		}
	}
}

// JSON API bodies are capped; the music upload routes are not.
func TestServer_APIBodyCapAndUploadExemption(t *testing.T) {
	var gotPath string
	h, _ := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}), nil)

	big := strings.NewReader(strings.Repeat("x", 8<<10))
	req := httptest.NewRequest("POST", "http://gateway/api/spaces", big)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize JSON body: expected 413, got %d", rr.Code)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil || body.Code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("code = %q (%v)", body.Code, err)
	}

	gotPath = ""
	req = httptest.NewRequest("POST", "http://gateway/api/music/upload", strings.NewReader(strings.Repeat("x", 8<<10)))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=b")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || gotPath != "/music/upload" {
		t.Fatalf("music upload must be exempt from the cap: %d path=%q", rr.Code, gotPath)
	}
}

// Internal headers are stripped on every route, and the Blossom proxy signs
// only a gateway-set identity (none here).
func TestServer_ForgedInternalHeadersStrippedOnEveryRoute(t *testing.T) {
	var seen http.Header
	h, _ := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}), nil)
	for _, path := range []string{"/upload", "/list/" + sha, "/hls/" + sha + "/master.m3u8", "/" + sha, "/api/spaces"} {
		method := "GET"
		if path == "/upload" {
			method = "HEAD"
		}
		req := httptest.NewRequest(method, "http://gateway"+path, nil)
		req.Header.Set("X-Auth-Pubkey", "deadbeef")
		req.Header.Set("X-Client-Ip", "203.0.113.1")
		req.Header.Set("X-Gateway-Auth", "1.deadbeef")
		h.ServeHTTP(httptest.NewRecorder(), req)
		for _, name := range []string{"X-Auth-Pubkey", "X-Client-Ip", "X-Gateway-Auth"} {
			if _, present := seen[name]; present {
				t.Errorf("%s: forged %s reached the backend", path, name)
			}
		}
	}
}
