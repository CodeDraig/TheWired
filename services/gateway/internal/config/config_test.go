package config

import (
	"reflect"
	"testing"
)

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"GATEWAY_ENV", "NODE_ENV", "TRUSTED_PROXIES", "ALLOWED_ORIGINS", "RATE_LIMIT_IP_PER_MIN", "MAX_API_BODY_BYTES"} {
		t.Setenv(k, "")
	}
}

// Dev default: the private ranges, so a local Caddy / docker bridge can set XFF.
func TestLoad_Dev_TrustedProxiesDefaultToPrivateRanges(t *testing.T) {
	clearEnv(t)
	cfg := Load()
	want := []string{"172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16", "127.0.0.0/8"}
	if !reflect.DeepEqual(cfg.TrustedProxies, want) {
		t.Fatalf("TrustedProxies = %v, want %v", cfg.TrustedProxies, want)
	}
	if cfg.IsProduction {
		t.Fatal("IsProduction must be false without GATEWAY_ENV/NODE_ENV")
	}
}

// Production default: trust nobody. :9080 may be published on 0.0.0.0, and a
// whole-RFC1918 default lets any client on a private hop spoof X-Forwarded-For
// to rotate the anonymous / auth-fail buckets and the X-Client-Ip it reports.
func TestLoad_Production_TrustedProxiesDefaultEmpty(t *testing.T) {
	clearEnv(t)
	t.Setenv("GATEWAY_ENV", "production")
	cfg := Load()
	if len(cfg.TrustedProxies) != 0 {
		t.Fatalf("TrustedProxies = %v, want none", cfg.TrustedProxies)
	}
	if !cfg.IsProduction {
		t.Fatal("IsProduction must be true")
	}
}

func TestLoad_NodeEnvProductionAlsoCounts(t *testing.T) {
	clearEnv(t)
	t.Setenv("NODE_ENV", "production")
	if cfg := Load(); !cfg.IsProduction || len(cfg.TrustedProxies) != 0 {
		t.Fatalf("NODE_ENV=production must flip the production defaults: %+v", cfg)
	}
}

func TestLoad_Production_ExplicitTrustedProxiesHonoured(t *testing.T) {
	clearEnv(t)
	t.Setenv("GATEWAY_ENV", "production")
	t.Setenv("TRUSTED_PROXIES", "172.18.0.0/16, 172.19.0.5")
	cfg := Load()
	want := []string{"172.18.0.0/16", "172.19.0.5"}
	if !reflect.DeepEqual(cfg.TrustedProxies, want) {
		t.Fatalf("TrustedProxies = %v, want %v", cfg.TrustedProxies, want)
	}
}

// CORS: "*" in dev when unset; deny-by-default (no origins) in production.
func TestLoad_AllowedOrigins_DevDefaultsToStar(t *testing.T) {
	clearEnv(t)
	cfg := Load()
	if !reflect.DeepEqual(cfg.AllowedOrigins, []string{"*"}) {
		t.Fatalf("AllowedOrigins = %v, want [*]", cfg.AllowedOrigins)
	}
}

func TestLoad_AllowedOrigins_ProductionDefaultsToNone(t *testing.T) {
	clearEnv(t)
	t.Setenv("GATEWAY_ENV", "production")
	cfg := Load()
	if len(cfg.AllowedOrigins) != 0 {
		t.Fatalf("AllowedOrigins = %v, want none (deny by default)", cfg.AllowedOrigins)
	}
}

func TestLoad_AllowedOrigins_ExplicitList(t *testing.T) {
	clearEnv(t)
	t.Setenv("GATEWAY_ENV", "production")
	t.Setenv("ALLOWED_ORIGINS", "https://thewired.app, tauri://localhost,https://tauri.localhost")
	cfg := Load()
	want := []string{"https://thewired.app", "tauri://localhost", "https://tauri.localhost"}
	if !reflect.DeepEqual(cfg.AllowedOrigins, want) {
		t.Fatalf("AllowedOrigins = %v, want %v", cfg.AllowedOrigins, want)
	}
}

func TestLoad_IPFloorAndBodyCapDefaults(t *testing.T) {
	clearEnv(t)
	cfg := Load()
	if cfg.RateLimitIP != 1200 {
		t.Fatalf("RateLimitIP = %d, want 1200", cfg.RateLimitIP)
	}
	if cfg.MaxAPIBodyBytes != 2<<20 {
		t.Fatalf("MaxAPIBodyBytes = %d, want %d", cfg.MaxAPIBodyBytes, 2<<20)
	}
	t.Setenv("RATE_LIMIT_IP_PER_MIN", "0")
	t.Setenv("MAX_API_BODY_BYTES", "1024")
	cfg = Load()
	if cfg.RateLimitIP != 0 || cfg.MaxAPIBodyBytes != 1024 {
		t.Fatalf("overrides not honoured: ip=%d body=%d", cfg.RateLimitIP, cfg.MaxAPIBodyBytes)
	}
}
