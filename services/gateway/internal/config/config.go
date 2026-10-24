package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port           int
	BackendURL     string
	RedisURL       string
	RelayURL       string
	LogLevel       string
	AllowedOrigins []string
	TrustedProxies []string // CIDRs allowed to set X-Forwarded-* headers

	RateLimitRead   int // per-pubkey reads per minute
	RateLimitWrite  int // per-pubkey writes per minute
	RateLimitSearch int // per-pubkey searches per minute
	// Play-time media lookups (/api/music/variants/*, /api/music/access/*):
	// a queue of tracks fires these in bursts, so they get their own bucket
	// instead of competing with the /spaces/* refetches in the read budget.
	RateLimitMedia int
	// POST /api/reports, per hour: guests by IP, signed-in callers by pubkey.
	RateLimitReportAnon int
	RateLimitReport     int

	// On a Redis outage: "open" (default) lets requests through so a cache blip
	// can't 503 the whole API; "closed" returns 503 (abuse-proof, lower
	// availability). #67.
	RateLimitFailMode string
	// Per-IP cap on FAILED auth attempts per minute (#111).
	AuthFailPerMin int

	// Shared with the backend (GATEWAY_SHARED_SECRET on both sides). When set,
	// every forwarded X-Auth-Pubkey / X-Client-Ip is accompanied by an
	// X-Gateway-Auth HMAC (internal/gatewayauth). Empty = header not sent; the
	// backend's GATEWAY_AUTH_MODE decides whether it is required.
	GatewaySharedSecret string
}

func Load() *Config {
	port, _ := strconv.Atoi(getEnv("GATEWAY_PORT", "9080"))
	originsStr := getEnv("ALLOWED_ORIGINS", "*")
	var origins []string
	for _, o := range strings.Split(originsStr, ",") {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}

	var proxies []string
	for _, p := range strings.Split(getEnv("TRUSTED_PROXIES", "172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,127.0.0.0/8"), ",") {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			proxies = append(proxies, trimmed)
		}
	}

	return &Config{
		Port:           port,
		BackendURL:     getEnv("BACKEND_URL", "http://localhost:3002"),
		RedisURL:       getEnv("REDIS_URL", "redis://localhost:6380"),
		RelayURL:       getEnv("RELAY_URL", "ws://localhost:7777"),
		LogLevel:       getEnv("LOG_LEVEL", "info"),
		AllowedOrigins: origins,
		TrustedProxies: proxies,

		RateLimitRead:   getEnvInt("RATE_LIMIT_READ_PER_MIN", 100),
		RateLimitWrite:  getEnvInt("RATE_LIMIT_WRITE_PER_MIN", 30),
		RateLimitSearch: getEnvInt("RATE_LIMIT_SEARCH_PER_MIN", 10),
		RateLimitMedia:  getEnvInt("RATE_LIMIT_MEDIA_PER_MIN", 300),

		RateLimitReportAnon: getEnvInt("RATE_LIMIT_REPORT_ANON_PER_HOUR", 5),
		RateLimitReport:     getEnvInt("RATE_LIMIT_REPORT_PER_HOUR", 30),

		RateLimitFailMode: getEnv("RATE_LIMIT_FAIL_MODE", "open"),
		AuthFailPerMin:    getEnvInt("RATE_LIMIT_AUTH_FAIL_PER_MIN", 60),

		GatewaySharedSecret: os.Getenv("GATEWAY_SHARED_SECRET"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
