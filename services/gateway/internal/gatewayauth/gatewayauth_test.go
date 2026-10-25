package gatewayauth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	testSecret = "test-secret"
	testTS     = int64(1700000000)
	testPubkey = "abababababababababababababababababababababababababababababababab"
	// Known-answer vectors, shared with the backend test
	// (services/backend/test/middleware/gatewayAuth.test.ts) so both sides are
	// pinned to the same string format.
	vecPubkey   = "e337c80510e3d610ee5ebf60f43228f843deac1c6e5d75ae8b3e60e3c8108150"
	vecClientIP = "85a1abfbdf44ac3aa4b1a380248e653cb7b0c78c028b6ccff13dc5f443e696b4"
)

func fixedSigner(t *testing.T) *Signer {
	t.Helper()
	s := NewSigner(testSecret)
	if s == nil {
		t.Fatal("NewSigner returned nil for a non-empty secret")
	}
	s.now = func() time.Time { return time.Unix(testTS, 0) }
	return s
}

func TestMAC_KnownAnswer_Pubkey(t *testing.T) {
	got := MAC([]byte(testSecret), testTS, testPubkey, "POST", "/spaces", "")
	if got != vecPubkey {
		t.Fatalf("MAC = %s, want %s", got, vecPubkey)
	}
}

func TestMAC_KnownAnswer_ClientIPOnly(t *testing.T) {
	got := MAC([]byte(testSecret), testTS, "", "POST", "/reports", "203.0.113.9")
	if got != vecClientIP {
		t.Fatalf("MAC = %s, want %s", got, vecClientIP)
	}
}

func TestMAC_EveryFieldIsBound(t *testing.T) {
	base := MAC([]byte(testSecret), testTS, testPubkey, "POST", "/spaces", "")
	variants := map[string]string{
		"ts":     MAC([]byte(testSecret), testTS+1, testPubkey, "POST", "/spaces", ""),
		"pubkey": MAC([]byte(testSecret), testTS, strings.Repeat("cd", 32), "POST", "/spaces", ""),
		"method": MAC([]byte(testSecret), testTS, testPubkey, "GET", "/spaces", ""),
		"path":   MAC([]byte(testSecret), testTS, testPubkey, "POST", "/spaces/x", ""),
		"ip":     MAC([]byte(testSecret), testTS, testPubkey, "POST", "/spaces", "198.51.100.1"),
		"secret": MAC([]byte("other"), testTS, testPubkey, "POST", "/spaces", ""),
	}
	for name, v := range variants {
		if v == base {
			t.Errorf("changing %s did not change the MAC", name)
		}
	}
}

func TestApply_SetsHeaderForVerifiedPubkey(t *testing.T) {
	s := fixedSigner(t)
	req := httptest.NewRequest("POST", "http://gateway/api/spaces", nil)
	req.Header.Set("X-Auth-Pubkey", testPubkey)

	s.Apply(req, "/spaces")

	want := "1700000000." + vecPubkey
	if got := req.Header.Get(Header); got != want {
		t.Fatalf("%s = %q, want %q", Header, got, want)
	}
}

func TestApply_CoversClientIP(t *testing.T) {
	s := fixedSigner(t)
	req := httptest.NewRequest("POST", "http://gateway/api/reports", nil)
	req.Header.Set("X-Client-Ip", "203.0.113.9")

	s.Apply(req, "/reports")

	want := "1700000000." + vecClientIP
	if got := req.Header.Get(Header); got != want {
		t.Fatalf("%s = %q, want %q", Header, got, want)
	}
}

func TestApply_NoIdentity_NoHeader(t *testing.T) {
	s := fixedSigner(t)
	req := httptest.NewRequest("GET", "http://gateway/api/spaces", nil)
	// A client-planted value must never survive, even on an anonymous request.
	req.Header.Set(Header, "1.deadbeef")

	s.Apply(req, "/spaces")

	if _, present := req.Header[http.CanonicalHeaderKey(Header)]; present {
		t.Fatalf("anonymous request must carry no %s, got %q", Header, req.Header.Get(Header))
	}
}

func TestApply_NilSigner_IsANoOp(t *testing.T) {
	var s *Signer
	req := httptest.NewRequest("POST", "http://gateway/api/spaces", nil)
	req.Header.Set("X-Auth-Pubkey", testPubkey)
	s.Apply(req, "/spaces")
	if _, present := req.Header[http.CanonicalHeaderKey(Header)]; present {
		t.Fatal("disabled signer must not set the header")
	}
}

func TestVerify_AcceptsFreshAndRejectsStaleOrTampered(t *testing.T) {
	s := fixedSigner(t)
	now := time.Unix(testTS+30, 0)
	ts := "1700000000"
	if !s.Verify(ts, vecPubkey, testPubkey, "POST", "/spaces", "", now) {
		t.Fatal("fresh, matching MAC must verify")
	}
	if s.Verify(ts, vecPubkey, testPubkey, "POST", "/spaces", "", time.Unix(testTS+121, 0)) {
		t.Fatal("a MAC older than the 120s skew window must not verify")
	}
	if s.Verify(ts, vecPubkey, testPubkey, "POST", "/spaces", "", time.Unix(testTS-121, 0)) {
		t.Fatal("a MAC from 121s in the future must not verify")
	}
	if s.Verify(ts, vecPubkey, strings.Repeat("cd", 32), "POST", "/spaces", "", now) {
		t.Fatal("a swapped pubkey must not verify")
	}
	if s.Verify("not-a-number", vecPubkey, testPubkey, "POST", "/spaces", "", now) {
		t.Fatal("a garbage timestamp must not verify")
	}
	if s.Verify(ts, "zz", testPubkey, "POST", "/spaces", "", now) {
		t.Fatal("a garbage MAC must not verify")
	}
}

func TestNewSigner_EmptySecretDisables(t *testing.T) {
	if NewSigner("") != nil {
		t.Fatal("empty secret must disable signing")
	}
	if NewSigner("   ") != nil {
		t.Fatal("blank secret must disable signing")
	}
}
