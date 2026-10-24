package main

import (
	"net/http"

	"github.com/thewired/gateway/internal/auth"
	"github.com/thewired/gateway/internal/config"
	"github.com/thewired/gateway/internal/cors"
	"github.com/thewired/gateway/internal/gatewayauth"
	gmiddleware "github.com/thewired/gateway/internal/logging"
	"github.com/thewired/gateway/internal/proxy"
	"github.com/thewired/gateway/internal/ratelimit"
)

// buildHandler assembles the whole route tree. Kept apart from main so the
// wiring (which guard wraps which route) is testable against a fake backend.
func buildHandler(cfg *config.Config, limiter *ratelimit.Limiter, replay auth.ReplayGuard, signer *gatewayauth.Signer) http.Handler {
	router := proxy.NewRouter(cfg.BackendURL, signer)
	blossomProxy := proxy.NewBlossomHandler(cfg.BackendURL, signer)
	failOpen := cfg.RateLimitFailMode != "closed"

	// One per-IP guard on FAILED auth for every route that can 401 on an
	// Authorization header: the NIP-98 routes (/api, blob catch-all) and the
	// Blossom routes whose kind-24242 auth the backend verifies.
	authFail := ratelimit.NewAuthFailGuard(cfg.AuthFailPerMin)

	// Common outer layers: trusted-proxy -> logging -> (route-specific CORS).
	edge := func(next http.Handler) http.Handler {
		return proxy.TrustedProxyMiddleware(cfg.TrustedProxies, gmiddleware.LoggingMiddleware(next))
	}

	mux := http.NewServeMux()

	// Health check (no auth required)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok","service":"gateway"}`))
	})

	// Blossom endpoints (no auth at gateway -- backend handles kind 24242)
	// PUT /upload, HEAD /upload, GET /list/<pubkey>
	blossomHandler := edge(cors.BlossomCORSMiddleware(authFail.Middleware(blossomProxy)))
	mux.Handle("/upload", blossomHandler)
	mux.Handle("/list/", blossomHandler)

	// HLS adaptive audio streams (public, GET-only, no auth, no rate limit).
	// Segments are immutable + CDN-cached so rate-limiting would just burn
	// Redis for no benefit. Same CORS policy as Blossom GETs. The auth-fail
	// guard only engages when a request carries Authorization.
	mux.Handle("/hls/", blossomHandler)

	// API routes: edge -> CORS -> body cap -> auth-fail guard -> auth -> rate
	// limit -> proxy. The auth-fail guard sits OUTSIDE NIP-98 so it can count
	// 401s and throttle per-IP brute-force of the (expensive) signature verify.
	apiHandler := edge(
		cors.CORSMiddleware(cfg.AllowedOrigins)(
			proxy.BodyLimitMiddleware(cfg.MaxAPIBodyBytes,
				authFail.Middleware(
					auth.NIP98MiddlewareWithOptions(auth.Options{
						Replay:           replay,
						ReplayFailClosed: !failOpen,
						PayloadMode:      cfg.NIP98RequirePayload,
					},
						ratelimit.RateLimitMiddleware(limiter, failOpen,
							router.Handler(),
						),
					),
				),
			),
		),
	)
	mux.Handle("/api/", apiHandler)

	// Blossom blob retrieval/deletion catch-all: /<sha256>[.<ext>]
	// Registered as "/" so it catches paths not matched by /upload, /list/, /api/, /hls/, /health
	// NIP-98 auth is optional here — allows backend to check access for protected blobs
	defaultHandler := edge(
		cors.BlossomCORSMiddleware(
			authFail.Middleware(
				auth.NIP98Middleware(
					http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if proxy.IsBlossomPath(r.URL.Path) {
							blossomProxy.ServeHTTP(w, r)
							return
						}
						http.NotFound(w, r)
					}),
				),
			),
		),
	)
	mux.Handle("/", defaultHandler)

	// Strip forgeable internal headers on EVERY route before routing (#108).
	return proxy.StripInternalHeaders(mux)
}
