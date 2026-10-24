package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/thewired/gateway/internal/auth"
	"github.com/thewired/gateway/internal/config"
	"github.com/thewired/gateway/internal/gatewayauth"
	"github.com/thewired/gateway/internal/proxy"
	"github.com/thewired/gateway/internal/ratelimit"
)

func main() {
	cfg := config.Load()

	if err := proxy.ValidateBackendURL(cfg.BackendURL); err != nil {
		log.Fatalf("%v", err)
	}

	limits := ratelimit.Limits{
		ReadPerMin:        cfg.RateLimitRead,
		WritePerMin:       cfg.RateLimitWrite,
		SearchPerMin:      cfg.RateLimitSearch,
		MediaPerMin:       cfg.RateLimitMedia,
		ReportAnonPerHour: cfg.RateLimitReportAnon,
		ReportPerHour:     cfg.RateLimitReport,
		IPPerMin:          cfg.RateLimitIP,
	}
	limiter, err := ratelimit.NewLimiter(cfg.RedisURL, limits)
	if err != nil {
		log.Fatalf("Failed to initialize rate limiter: %v", err)
	}

	// #64 — single-use replay guard for API auth events (Redis SET NX EX). The
	// constructor only parses REDIS_URL (the client dials lazily), so the only
	// failure is a bad URL — the same one the limiter above already accepted.
	// Treat it as the configuration error it is instead of silently running
	// without replay protection for the life of the process. Per-request store
	// errors are handled in the middleware (reads fail open; writes follow
	// RATE_LIMIT_FAIL_MODE).
	replayGuard, err := auth.NewRedisReplayGuard(cfg.RedisURL)
	if err != nil {
		log.Fatalf("Failed to initialize NIP-98 replay guard: %v", err)
	}

	// Identity-header MAC shared with the backend (GATEWAY_SHARED_SECRET). nil
	// when unset: nothing new on the wire, the backend keeps topological trust.
	signer := gatewayauth.NewSigner(cfg.GatewaySharedSecret)
	if signer == nil {
		log.Printf("GATEWAY_SHARED_SECRET unset: forwarded identity headers are not signed")
	}
	if cfg.IsProduction && len(cfg.TrustedProxies) == 0 {
		log.Printf("TRUSTED_PROXIES unset in production: X-Forwarded-* is ignored, every client is keyed by the proxy's address")
	}

	addr := fmt.Sprintf(":%d", cfg.Port)
	srv := &http.Server{
		Addr:    addr,
		Handler: buildHandler(cfg, limiter, replayGuard, signer),
		// #65 — bound slow-header/idle connections (Slowloris). Read/Write body
		// timeouts are intentionally left unset because /upload streams large
		// Blossom blobs and the catch-all streams them back to slow clients.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	// Start server in a goroutine
	go func() {
		log.Printf("Gateway listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for SIGTERM or SIGINT
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	sig := <-quit
	log.Printf("Received %v, shutting down...", sig)

	// Give in-flight requests 15 seconds to complete
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Gateway stopped")
}
