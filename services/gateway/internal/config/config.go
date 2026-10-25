package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port       int
	BackendURL string
	RedisURL   string
	RelayURL   string
	LogLevel   string
	// GATEWAY_ENV=production (or NODE_ENV=production) flips the safe defaults
	// below: TrustedProxies empty and AllowedOrigins deny-by-default.
	IsProduction   bool
	AllowedOrigins []string
	TrustedProxies []string // CIDRs allowed to set X-Forwarded-* headers

	RateLimitRead   int // per-pubkey reads per minute
	RateLimitWrite  int // per-pubkey writes per minute
	RateLimitSearch int // per-pubkey searches per minute
	// Play-time media lookups (/api/music/variants/*, /api/music/access/*):
	// a queue of tracks fires these in bursts, so they get their own bucket
	// instead of competing with the /spaces/* refetches in the read budget.
	RateLimitMedia int
	// Per-client-IP ceiling on EVERY /api request per minute, on top of the
	// per-pubkey buckets: a fresh keypair per request used to multiply the
	// budget (and each costs a schnorr verify). 0 disables.
	RateLimitIP int
	// POST /api/reports, per hour: guests by IP, signed-in callers by pubkey.
	RateLimitReportAnon int
	RateLimitReport     int

	// On a Redis outage: "open" (default) lets requests through so a cache blip
	// can't 503 the whole API; "closed" returns 503 (abuse-proof, lower
	// availability). #67. Also governs the NIP-98 replay guard for write methods.
	RateLimitFailMode string
	// Per-IP cap on FAILED auth attempts per minute (#111).
	AuthFailPerMin int

	// Shared with the backend (GATEWAY_SHARED_SECRET on both sides). When set,
	// every forwarded X-Auth-Pubkey / X-Client-Ip is accompanied by an
	// X-Gateway-Auth HMAC (internal/gatewayauth). Empty = header not sent; the
	// backend's GATEWAY_AUTH_MODE decides whether it is required.
	GatewaySharedSecret string

	// NIP-98 `payload` tag requirement on body-bearing /api requests:
	// off (verify-if-present, default) | warn | enforce (401 PAYLOAD_REQUIRED).
	NIP98RequirePayload string

	// Cap on request bodies to /api routes that are not uploads (bytes).
	MaxAPIBodyBytes int64
}

// devTrustedProxies is the non-production default: Docker bridge networks and
// loopback, so a local Caddy or compose stack can set X-Forwarded-*.
const devTrustedProxies = "172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,127.0.0.0/8"

func Load() *Config {
	port, _ := strconv.Atoi(getEnv("GATEWAY_PORT", "9080"))
	isProduction := strings.EqualFold(getEnv("GATEWAY_ENV", os.Getenv("NODE_ENV")), "production")

	// CORS: unset means "*" in dev and nobody in production (a server that
	// forgot ALLOWED_ORIGINS should not reflect every origin).
	originsDefault := "*"
	if isProduction {
		originsDefault = ""
	}
	origins := splitList(getEnv("ALLOWED_ORIGINS", originsDefault))

	// Trusted proxies: in production trust nobody unless told whom. :9080 may
	// be published on 0.0.0.0, and a whole-RFC1918 default lets any client on a
	// private hop spoof X-Forwarded-For to rotate the anonymous / auth-fail
	// buckets and the X-Client-Ip it reports to the backend.
	proxiesDefault := devTrustedProxies
	if isProduction {
		proxiesDefault = ""
	}
	proxies := splitList(getEnv("TRUSTED_PROXIES", proxiesDefault))

	return &Config{
		Port:           port,
		BackendURL:     getEnv("BACKEND_URL", "http://localhost:3002"),
		RedisURL:       getEnv("REDIS_URL", "redis://localhost:6380"),
		RelayURL:       getEnv("RELAY_URL", "ws://localhost:7777"),
		LogLevel:       getEnv("LOG_LEVEL", "info"),
		IsProduction:   isProduction,
		AllowedOrigins: origins,
		TrustedProxies: proxies,

		RateLimitRead:   getEnvInt("RATE_LIMIT_READ_PER_MIN", 100),
		RateLimitWrite:  getEnvInt("RATE_LIMIT_WRITE_PER_MIN", 30),
		RateLimitSearch: getEnvInt("RATE_LIMIT_SEARCH_PER_MIN", 10),
		RateLimitMedia:  getEnvInt("RATE_LIMIT_MEDIA_PER_MIN", 300),
		RateLimitIP:     getEnvInt("RATE_LIMIT_IP_PER_MIN", 1200),

		RateLimitReportAnon: getEnvInt("RATE_LIMIT_REPORT_ANON_PER_HOUR", 5),
		RateLimitReport:     getEnvInt("RATE_LIMIT_REPORT_PER_HOUR", 30),

		RateLimitFailMode: getEnv("RATE_LIMIT_FAIL_MODE", "open"),
		AuthFailPerMin:    getEnvInt("RATE_LIMIT_AUTH_FAIL_PER_MIN", 60),

		GatewaySharedSecret: os.Getenv("GATEWAY_SHARED_SECRET"),
		NIP98RequirePayload: strings.ToLower(getEnv("NIP98_REQUIRE_PAYLOAD", "off")),

		MaxAPIBodyBytes: int64(getEnvInt("MAX_API_BODY_BYTES", 2<<20)),
	}
}

// splitList splits a comma list, trimming blanks; "" yields nil.
func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
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
