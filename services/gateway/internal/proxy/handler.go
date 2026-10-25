package proxy

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// DefaultResponseHeaderTimeout bounds how long the gateway waits for the
// backend to START answering after the request (body included) was sent. The
// slowest legitimate case is a music upload that transcodes before replying.
const DefaultResponseHeaderTimeout = 60 * time.Second

// ValidateBackendURL checks BACKEND_URL at boot so a typo is a clear fatal
// instead of a 502 on every request.
func ValidateBackendURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("BACKEND_URL %q: %w", raw, err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("BACKEND_URL %q: need an http(s) URL with a host", raw)
	}
	return nil
}

// mustParseBackend is the constructor-time form: the URL was validated by
// main, so a failure here is a programming error.
func mustParseBackend(raw string) *url.URL {
	if err := ValidateBackendURL(raw); err != nil {
		panic(err)
	}
	u, _ := url.Parse(raw)
	return u
}

// newBackendTransport is the shared upstream transport: bounded dial,
// response-header and idle timeouts, a small keep-alive pool.
func newBackendTransport(responseHeaderTimeout time.Duration) *http.Transport {
	return &http.Transport{
		Proxy: nil, // never route backend traffic through an env HTTP proxy
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ResponseHeaderTimeout: responseHeaderTimeout,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}

// newReverseProxy forwards to target with the request path replaced by
// `path` (decoded) / `rawPath` (its original percent-encoding, or "" when the
// default encoding of `path` is already exact). Carrying RawPath matters for
// path segments holding an encoded "/" (`%2F`): with only the decoded Path set,
// the outgoing request line re-encodes it as a literal "/", the segment splits
// in two, and the backend route no longer matches (e.g. a music d-tag with a
// slash in DELETE /music/track/:pubkey/:slug). url.URL ignores a RawPath that
// isn't a valid encoding of Path, so a mismatched value degrades to the old
// decoded behaviour rather than forwarding the wrong path.
func newReverseProxy(target *url.URL, transport http.RoundTripper, path, rawPath string) *httputil.ReverseProxy {
	director := func(req *http.Request) {
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.URL.Path = path
		req.URL.RawPath = rawPath
		req.Host = target.Host
	}

	proxy := &httputil.ReverseProxy{Director: director, Transport: transport}

	// Strip CORS headers from backend response — the gateway CORS middleware owns these.
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("Access-Control-Allow-Origin")
		resp.Header.Del("Access-Control-Allow-Methods")
		resp.Header.Del("Access-Control-Allow-Headers")
		resp.Header.Del("Access-Control-Allow-Credentials")
		resp.Header.Del("Access-Control-Max-Age")
		return nil
	}

	return proxy
}
