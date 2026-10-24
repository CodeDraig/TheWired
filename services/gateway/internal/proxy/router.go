package proxy

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/thewired/gateway/internal/gatewayauth"
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Router maps API paths to backend services
type Router struct {
	backendURL string
	signer     *gatewayauth.Signer // nil = X-Gateway-Auth disabled
}

// NewRouter builds the /api router. `signer` (nil to disable) MACs the
// forwarded identity headers so the backend can verify they came from here.
func NewRouter(backendURL string, signer *gatewayauth.Signer) *Router {
	return &Router{backendURL: backendURL, signer: signer}
}

// wirePath is the request-target path as it will be written on the outgoing
// request line: RawPath when it is a valid encoding of Path, else the default
// escaping of Path. This is the string the backend sees in its request URL.
func wirePath(path, rawPath string) string {
	u := url.URL{Path: path, RawPath: rawPath}
	return u.EscapedPath()
}

// NewBlossomHandler returns a handler that proxies Blossom endpoints to the backend.
// Backend handles kind 24242 auth for PUT/DELETE; GET/HEAD are unauthenticated.
// The catch-all runs the optional NIP-98 middleware, so a verified pubkey can
// reach here too — it is signed over the unchanged path.
func NewBlossomHandler(backendURL string, signer *gatewayauth.Signer) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		signer.Apply(r, wirePath(r.URL.Path, r.URL.RawPath))
		proxy := newReverseProxy(backendURL, r.URL.Path, r.URL.RawPath)
		proxy.ServeHTTP(w, r)
	})
}

// stripAPIPrefix removes the leading "/api" from both the decoded path and its
// raw (percent-encoded) form, so an encoded "/" inside a segment survives the
// hop to the backend. rawPath is "" when the request had no special encoding.
func stripAPIPrefix(u *url.URL) (path, rawPath string) {
	path = strings.TrimPrefix(u.Path, "/api")
	if path == "" {
		path = "/"
	}
	if u.RawPath != "" {
		rawPath = strings.TrimPrefix(u.RawPath, "/api")
		if rawPath == "" {
			rawPath = "/"
		}
	}
	return path, rawPath
}

// IsBlossomPath returns true if the path should be routed as a Blossom endpoint.
func IsBlossomPath(path string) bool {
	// /upload (PUT/HEAD)
	if path == "/upload" {
		return true
	}
	// /list/<pubkey>
	if strings.HasPrefix(path, "/list/") {
		return true
	}
	// /<sha256> or /<sha256>.<ext> (GET/DELETE)
	trimmed := strings.TrimPrefix(path, "/")
	// Strip file extension if present
	if idx := strings.LastIndex(trimmed, "."); idx > 0 {
		trimmed = trimmed[:idx]
	}
	return len(trimmed) == 64 && sha256Pattern.MatchString(trimmed)
}

// Handler returns an http.Handler that proxies requests to the backend
func (rt *Router) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Strip /api prefix (keeping any %2F-style encoding intact)
		backendPath, backendRawPath := stripAPIPrefix(r.URL)

		// Sign the identity headers over the path the backend will see.
		rt.signer.Apply(r, wirePath(backendPath, backendRawPath))

		proxy := newReverseProxy(rt.backendURL, backendPath, backendRawPath)
		proxy.ServeHTTP(w, r)
	})
}
