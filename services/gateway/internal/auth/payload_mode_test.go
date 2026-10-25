package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// payloadModeHandler builds the /api middleware in the given NIP98_REQUIRE_PAYLOAD
// mode with no replay guard.
func payloadModeHandler(mode string, inner http.Handler) http.Handler {
	return NIP98MiddlewareWithOptions(Options{PayloadMode: mode}, inner)
}

func bodyRequest(t *testing.T, method, url, body, contentType string, extraTags [][]string) *http.Request {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, url, nil)
	} else {
		req = httptest.NewRequest(method, url, strings.NewReader(body))
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Authorization", signedAuthHeaderWithTags(t, method, url, extraTags))
	return req
}

func TestPayloadMode_Enforce_BodyWithoutTag_401(t *testing.T) {
	inner := &bodyEchoHandler{}
	h := payloadModeHandler("enforce", inner)
	const url = "http://localhost:9080/api/music/play"
	req := bodyRequest(t, "POST", url, `{"trackId":"x"}`, "application/json", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
	if inner.called {
		t.Fatal("inner handler must not run")
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not JSON: %q", rr.Body.String())
	}
	if body.Code != "PAYLOAD_REQUIRED" {
		t.Fatalf("code = %q, want PAYLOAD_REQUIRED", body.Code)
	}
}

func TestPayloadMode_Enforce_BodyWithTag_Passes(t *testing.T) {
	inner := &bodyEchoHandler{}
	h := payloadModeHandler("enforce", inner)
	const url = "http://localhost:9080/api/music/play"
	body := `{"trackId":"x"}`
	req := bodyRequest(t, "POST", url, body, "application/json", [][]string{payloadTag([]byte(body))})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if inner.body != body {
		t.Fatalf("body not forwarded intact: %q", inner.body)
	}
}

func TestPayloadMode_Enforce_NoBody_NoTagNeeded(t *testing.T) {
	for _, method := range []string{"GET", "DELETE", "POST"} {
		inner := &captureHandler{}
		h := payloadModeHandler("enforce", inner)
		url := "http://localhost:9080/api/spaces"
		req := bodyRequest(t, method, url, "", "", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s without body: expected 200, got %d", method, rr.Code)
		}
		if !inner.hasPubkey {
			t.Fatalf("%s without body: pubkey not injected", method)
		}
	}
}

func TestPayloadMode_Enforce_MultipartExempt(t *testing.T) {
	inner := &bodyEchoHandler{}
	h := payloadModeHandler("enforce", inner)
	const url = "http://localhost:9080/api/music/upload"
	req := bodyRequest(t, "POST", url, "--b\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nxx\r\n--b--\r\n",
		"multipart/form-data; boundary=b", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("multipart upload without a payload tag must pass (browser cannot hash FormData), got %d", rr.Code)
	}
}

func TestPayloadMode_Warn_BodyWithoutTag_Passes(t *testing.T) {
	inner := &bodyEchoHandler{}
	h := payloadModeHandler("warn", inner)
	const url = "http://localhost:9080/api/music/play"
	req := bodyRequest(t, "POST", url, `{"a":1}`, "application/json", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !inner.called {
		t.Fatalf("warn mode must let the request through, got %d", rr.Code)
	}
}

func TestPayloadMode_Off_BodyWithoutTag_Passes(t *testing.T) {
	inner := &bodyEchoHandler{}
	h := payloadModeHandler("off", inner)
	const url = "http://localhost:9080/api/music/play"
	req := bodyRequest(t, "POST", url, `{"a":1}`, "application/json", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("off mode must keep today's behaviour, got %d", rr.Code)
	}
}

// A present-but-wrong tag is rejected in every mode (regression for the
// verify-if-present behaviour).
func TestPayloadMode_MismatchRejectedInEveryMode(t *testing.T) {
	for _, mode := range []string{"off", "warn", "enforce"} {
		inner := &bodyEchoHandler{}
		h := payloadModeHandler(mode, inner)
		const url = "http://localhost:9080/api/music/play"
		req := bodyRequest(t, "POST", url, `{"a":1}`, "application/json", [][]string{payloadTag([]byte(`{"a":2}`))})
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("mode %s: mismatched payload must 401, got %d", mode, rr.Code)
		}
		var body struct {
			Code  string `json:"code"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("mode %s: error body is not JSON: %q", mode, rr.Body.String())
		}
		if body.Code != "AUTH_FAILED" {
			t.Fatalf("mode %s: code = %q", mode, body.Code)
		}
	}
}

// Error bodies are built with json.Marshal: a `u` tag full of quotes and braces
// must come back as valid JSON with a fixed message, never echoing the input.
func TestAuthError_IsValidJSONAndDoesNotEchoClientURL(t *testing.T) {
	inner := &captureHandler{}
	h := NIP98Middleware(inner)
	evil := `http://localhost:9080/api/spaces","code":"X"}{"pwn":"`
	// Sign for a different URL so the u-tag mismatch path fires with the evil string.
	req := httptest.NewRequest("GET", "http://localhost:9080/api/spaces", nil)
	req.Header.Set("Authorization", signedAuthHeaderWithTags(t, "GET", evil, nil))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not valid JSON: %q", rr.Body.String())
	}
	if _, pwned := body["pwn"]; pwned {
		t.Fatalf("client-controlled text was spliced into the error JSON: %q", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "pwn") {
		t.Fatalf("client URL echoed into the error body: %q", rr.Body.String())
	}
	if rr.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type = %q", rr.Header().Get("Content-Type"))
	}
}
