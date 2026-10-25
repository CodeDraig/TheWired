package ratelimit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func ipFloorHandler(t *testing.T, ipPerMin int) (*Limiter, http.Handler) {
	t.Helper()
	limits := DefaultLimits
	limits.IPPerMin = ipPerMin
	limits.ReadPerMin = 1000
	l := reportLimiter(t, limits)
	h := RateLimitMiddleware(l, true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	return l, h
}

func ipRequest(ip, pubkey string) *http.Request {
	req := httptest.NewRequest("GET", "http://localhost:9080/api/spaces", nil)
	req.RemoteAddr = ip + ":4444"
	if pubkey != "" {
		req.Header.Set("X-Auth-Pubkey", pubkey)
	}
	return req
}

// A fresh keypair per request used to multiply the budget: every pubkey got
// its own bucket and each cost a schnorr verify. The per-IP floor counts them
// all against one bucket.
func TestIPFloor_CountsAcrossPubkeysFromOneIP(t *testing.T) {
	l, h := ipFloorHandler(t, 2)
	const ip = "203.0.113.77"
	l.client.Del(context.Background(), "ratelimit:ip:"+ip)

	for i, pk := range []string{"pk-one", "pk-two"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, ipRequest(ip, pk))
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d", i, rr.Code)
		}
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, ipRequest(ip, "pk-three"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("3rd pubkey from the same IP: expected 429, got %d", rr.Code)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil || body.Code != "IP_RATE_LIMITED" {
		t.Fatalf("code = %q (%v), want IP_RATE_LIMITED", body.Code, err)
	}
	if rr.Header().Get("Retry-After") == "" {
		t.Fatal("429 must carry Retry-After")
	}
}

func TestIPFloor_IsPerIP(t *testing.T) {
	l, h := ipFloorHandler(t, 1)
	l.client.Del(context.Background(), "ratelimit:ip:203.0.113.1", "ratelimit:ip:203.0.113.2")

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, ipRequest("203.0.113.1", "pk-a"))
	if rr.Code != http.StatusOK {
		t.Fatalf("first from .1: %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, ipRequest("203.0.113.2", "pk-a"))
	if rr.Code != http.StatusOK {
		t.Fatalf("another IP must have its own floor, got %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, ipRequest("203.0.113.1", "pk-b"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("second from .1 must be throttled, got %d", rr.Code)
	}
}

// 0 disables the floor (the pubkey bucket alone, as before).
func TestIPFloor_ZeroDisables(t *testing.T) {
	l, h := ipFloorHandler(t, 0)
	l.client.Del(context.Background(), "ratelimit:ip:203.0.113.9")
	for i := 0; i < 5; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, ipRequest("203.0.113.9", "pk-"+string(rune('a'+i))))
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d: floor disabled yet got %d", i, rr.Code)
		}
	}
}

// The floor is a ceiling on top of the pubkey bucket, not a replacement: a
// single pubkey is still bound by its own (smaller) read budget.
func TestIPFloor_PubkeyBucketStillApplies(t *testing.T) {
	limits := DefaultLimits
	limits.IPPerMin = 100
	limits.ReadPerMin = 1
	l := reportLimiter(t, limits)
	const pk = "ipfloor-pk-bucket"
	l.client.Del(context.Background(), "ratelimit:ip:203.0.113.5", "ratelimit:read:"+pk)
	h := RateLimitMiddleware(l, true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, ipRequest("203.0.113.5", pk))
	if rr.Code != http.StatusOK {
		t.Fatalf("first: %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, ipRequest("203.0.113.5", pk))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("pubkey bucket must still throttle, got %d", rr.Code)
	}
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body.Code != "RATE_LIMITED" {
		t.Fatalf("code = %q, want RATE_LIMITED (pubkey bucket)", body.Code)
	}
}

// Redis down: the floor follows failOpen like the other buckets.
func TestIPFloor_FailOpenWhenRedisDown(t *testing.T) {
	limits := DefaultLimits
	limits.IPPerMin = 1
	l, err := NewLimiter("redis://localhost:1", limits)
	if err != nil {
		t.Fatal(err)
	}
	h := RateLimitMiddleware(l, true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, ipRequest("203.0.113.3", "pk"))
	if rr.Code != http.StatusOK {
		t.Fatalf("fail-open expected 200, got %d", rr.Code)
	}
}
