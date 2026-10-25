package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/thewired/gateway/internal/gatewayauth"
)

const gwTestPubkey = "abababababababababababababababababababababababababababababababab"

// The API router signs the identity headers over the path the BACKEND sees
// (/api stripped, percent-encoding as on the wire), so the backend can verify
// against its own request URL without knowing about the gateway prefix.
func TestRouter_SignsIdentityOverBackendPath(t *testing.T) {
	var gotAuth, gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get(gatewayauth.Header)
		gotPath = r.URL.EscapedPath()
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	signer := gatewayauth.NewSigner("test-secret")
	handler := NewRouter(backend.URL, signer).Handler()

	req := httptest.NewRequest("DELETE", "http://gateway/api/music/track/"+gwTestPubkey+"/a%2Fb?x=1", nil)
	req.Header.Set("X-Auth-Pubkey", gwTestPubkey)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	wantPath := "/music/track/" + gwTestPubkey + "/a%2Fb"
	if gotPath != wantPath {
		t.Fatalf("backend path = %q, want %q", gotPath, wantPath)
	}
	ts, mac, ok := strings.Cut(gotAuth, ".")
	if !ok {
		t.Fatalf("backend got no %s header (%q)", gatewayauth.Header, gotAuth)
	}
	if !signer.Verify(ts, mac, gwTestPubkey, "DELETE", wantPath, "", time.Now()) {
		t.Fatalf("MAC does not verify over the backend path: %q", gotAuth)
	}
}

// The Blossom handler forwards the path unchanged, so it signs that path.
func TestBlossomHandler_SignsIdentityOverForwardedPath(t *testing.T) {
	var gotAuth string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get(gatewayauth.Header)
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	signer := gatewayauth.NewSigner("test-secret")
	handler := NewBlossomHandler(backend.URL, signer)

	req := httptest.NewRequest("GET", "http://gateway/list/"+gwTestPubkey, nil)
	req.Header.Set("X-Auth-Pubkey", gwTestPubkey)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	ts, mac, ok := strings.Cut(gotAuth, ".")
	if !ok {
		t.Fatalf("backend got no %s header (%q)", gatewayauth.Header, gotAuth)
	}
	if !signer.Verify(ts, mac, gwTestPubkey, "GET", "/list/"+gwTestPubkey, "", time.Now()) {
		t.Fatalf("MAC does not verify over the forwarded path: %q", gotAuth)
	}
}

// Without a configured secret nothing changes on the wire (rollout default).
func TestRouter_NoSecret_NoGatewayAuthHeader(t *testing.T) {
	present := false
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, present = r.Header[http.CanonicalHeaderKey(gatewayauth.Header)]
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	handler := NewRouter(backend.URL, nil).Handler()
	req := httptest.NewRequest("GET", "http://gateway/api/spaces", nil)
	req.Header.Set("X-Auth-Pubkey", gwTestPubkey)
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if present {
		t.Fatal("no secret configured, yet the gateway emitted X-Gateway-Auth")
	}
}
