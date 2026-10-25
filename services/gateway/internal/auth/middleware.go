package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"

	"encoding/base64"
)

var (
	errPayloadMismatch   = errors.New("payload hash mismatch")
	errPayloadTooLarge   = errors.New("payload too large to verify")
	errPayloadUnreadable = errors.New("could not read request body")
)

// maxPayloadVerifyBytes bounds how much request body we'll buffer to verify a
// NIP-98 `payload` tag. Authenticated API bodies are small JSON; this cap stops
// a forged huge-body request (with a payload tag) from ballooning gateway memory.
// Bodies larger than this with a payload tag are rejected, not silently passed.
const maxPayloadVerifyBytes = 8 << 20 // 8 MiB

// Payload-tag modes (NIP98_REQUIRE_PAYLOAD).
const (
	PayloadOff     = "off"     // verify only when the tag is present (default)
	PayloadWarn    = "warn"    // ...and log body-bearing requests that omit it
	PayloadEnforce = "enforce" // ...and 401 PAYLOAD_REQUIRED when it is missing
)

// Options configures the NIP-98 middleware.
type Options struct {
	// Replay rejects reused auth event ids (#64). nil disables the check.
	Replay ReplayGuard
	// ReplayFailClosed: when the replay store errors, 503 write-method requests
	// instead of letting them through. Reads always fail open.
	ReplayFailClosed bool
	// PayloadMode is one of PayloadOff / PayloadWarn / PayloadEnforce.
	PayloadMode string
}

// NIP98Middleware verifies the NIP-98 auth header with no replay protection.
// Used on the public Blossom catch-all, where bodies are large blobs and the
// replay surface is low.
func NIP98Middleware(next http.Handler) http.Handler {
	return NIP98MiddlewareWithOptions(Options{}, next)
}

// NIP98MiddlewareWithReplay verifies NIP-98 auth and additionally rejects replays
// via `guard` (#64). A nil guard disables replay checks. On a guard error the
// request is allowed through (fail-open) so a Redis blip can't lock out auth.
func NIP98MiddlewareWithReplay(guard ReplayGuard, next http.Handler) http.Handler {
	return NIP98MiddlewareWithOptions(Options{Replay: guard}, next)
}

// NIP98MiddlewareWithOptions is the fully configurable constructor.
func NIP98MiddlewareWithOptions(opts Options, next http.Handler) http.Handler {
	if opts.PayloadMode != PayloadWarn && opts.PayloadMode != PayloadEnforce {
		opts.PayloadMode = PayloadOff
	}
	var warnMu sync.Mutex
	var lastWarn time.Time
	warnOncePerMinute := func(format string, args ...any) {
		warnMu.Lock()
		defer warnMu.Unlock()
		if time.Since(lastWarn) < time.Minute {
			return
		}
		lastWarn = time.Now()
		log.Printf(format, args...)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Always strip X-Auth-Pubkey from inbound requests — it is an
		// internal header injected by this middleware after verification.
		// Without this, an unauthenticated client could forge it.
		r.Header.Del("X-Auth-Pubkey")

		authHeader := r.Header.Get("Authorization")

		// Allow unauthenticated requests (pubkey will be empty)
		if authHeader == "" {
			next.ServeHTTP(w, r)
			return
		}

		if !strings.HasPrefix(authHeader, "Nostr ") {
			writeAuthError(w, http.StatusUnauthorized, "INVALID_AUTH", "invalid auth scheme")
			return
		}

		// Decode base64 event
		eventB64 := strings.TrimPrefix(authHeader, "Nostr ")
		eventJSON, err := base64.StdEncoding.DecodeString(eventB64)
		if err != nil {
			writeAuthError(w, http.StatusUnauthorized, "INVALID_AUTH", "invalid base64")
			return
		}

		var event NostrEvent
		if err := json.Unmarshal(eventJSON, &event); err != nil {
			writeAuthError(w, http.StatusUnauthorized, "INVALID_AUTH", "invalid event JSON")
			return
		}

		// Build expected URL from request.
		// Behind a TLS-terminating reverse proxy (Caddy, nginx, etc.)
		// the direct connection is plain HTTP, so check X-Forwarded-Proto first.
		scheme := "http"
		if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
			scheme = proto
		} else if r.TLS != nil {
			scheme = "https"
		}
		// #63 — the client signs the FULL request URL including the query string
		// (NIP-98: the `u` tag MUST equal the absolute request URL). Comparing
		// path-only 401s every authenticated request that carries query params.
		// RequestURI() preserves the raw path+query as sent on the wire.
		expectedURL := scheme + "://" + r.Host + r.URL.RequestURI()

		if err := VerifyNIP98(&event, expectedURL, r.Method); err != nil {
			// The verifier's message names the client's own `u` tag; the client
			// gets a fixed description, the detail goes to the log.
			log.Printf("NIP-98 verify failed for %s %s: %v", r.Method, r.URL.Path, err)
			writeAuthError(w, http.StatusUnauthorized, "AUTH_FAILED", "auth event does not match this request")
			return
		}

		// #64 — payload tag is verify-if-present: when the client binds the body
		// hash into the auth event, the body MUST match. NIP98_REQUIRE_PAYLOAD
		// additionally warns about / rejects body-bearing requests without one.
		payloadTag := getTagValue(event.Tags, "payload")
		if payloadTag != "" {
			if err := verifyPayload(r, payloadTag); err != nil {
				writeAuthError(w, http.StatusUnauthorized, "AUTH_FAILED", err.Error())
				return
			}
		} else if opts.PayloadMode != PayloadOff && hasBody(r) && !isMultipart(r) {
			if opts.PayloadMode == PayloadEnforce {
				writeAuthError(w, http.StatusUnauthorized, "PAYLOAD_REQUIRED",
					"NIP-98 payload tag (sha256 of the request body) is required")
				return
			}
			warnOncePerMinute("NIP-98 payload tag missing on %s %s (mode=warn; pubkey %s…)",
				r.Method, r.URL.Path, event.PubKey[:8])
		}

		// #64 — single-use replay protection, checked AFTER full verification so an
		// attacker can't poison the cache with unverified ids. On a store error
		// reads fail open (a Redis outage must not 401 every authenticated
		// request); writes follow ReplayFailClosed.
		if opts.Replay != nil {
			fresh, err := opts.Replay.Reserve(r.Context(), event.ID)
			if err != nil {
				if opts.ReplayFailClosed && isWriteMethod(r.Method) {
					log.Printf("NIP-98 replay guard error (fail-closed, %s): %v", r.Method, err)
					writeAuthError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "service temporarily unavailable")
					return
				}
				log.Printf("NIP-98 replay guard error (fail-open): %v", err)
			} else if !fresh {
				writeAuthError(w, http.StatusUnauthorized, "AUTH_REPLAY", "auth event already used")
				return
			}
		}

		// Inject pubkey header for backend
		r.Header.Set("X-Auth-Pubkey", event.PubKey)
		next.ServeHTTP(w, r)
	})
}

// writeAuthError emits a fixed-shape JSON error. Messages are constants chosen
// here, never client input, and the body is built with json.Marshal.
func writeAuthError(w http.ResponseWriter, status int, code, message string) {
	body, _ := json.Marshal(map[string]string{"error": message, "code": code})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
}

func isWriteMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// hasBody reports whether the request carries a body: a known positive length
// or an unknown (chunked) one. ContentLength 0 means none.
func hasBody(r *http.Request) bool {
	if r.Body == nil || r.Body == http.NoBody {
		return false
	}
	return r.ContentLength != 0
}

// isMultipart: a browser serializes FormData (boundary included) only inside
// fetch, so the client cannot know the body hash up front. Upload routes are
// therefore exempt from the payload requirement (the backend's kind-24242 /
// per-pubkey upload guards still apply).
func isMultipart(r *http.Request) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mt == "multipart/form-data"
}

// verifyPayload checks that sha256(body) hex-equals the NIP-98 `payload` tag,
// then restores r.Body so the proxy can forward it unchanged. Bodies over the
// cap are rejected (we won't buffer unbounded memory to verify a claimed hash).
func verifyPayload(r *http.Request, payloadTag string) error {
	if r.Body == nil {
		// A payload tag with no body can only match the empty-string hash.
		return matchHash(payloadTag, nil)
	}
	limited := io.LimitReader(r.Body, maxPayloadVerifyBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return errPayloadUnreadable
	}
	if len(body) > maxPayloadVerifyBytes {
		// Drain+restore best-effort, but reject: can't verify within the cap.
		r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), r.Body))
		return errPayloadTooLarge
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return matchHash(payloadTag, body)
}

func matchHash(payloadTag string, body []byte) error {
	sum := sha256.Sum256(body)
	if hex.EncodeToString(sum[:]) != payloadTag {
		return errPayloadMismatch
	}
	return nil
}
