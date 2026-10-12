package ratelimit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The play-time media lookups get their own bucket so a queue of tracks (one
// /variants + one /access per track) cannot drain the read budget the
// /spaces/* refetch bursts live in — and vice versa.
func TestClassify_MediaLookupsGetTheirOwnBucket(t *testing.T) {
	sha := "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12"
	tests := []struct {
		method string
		path   string
		want   string
	}{
		{"GET", "/api/music/variants/" + sha, "media"},
		{"HEAD", "/api/music/variants/" + sha, "media"},
		{"GET", "/api/music/access/" + sha + "/my-track", "media"},
		// Neighbours stay in their usual buckets.
		{"GET", "/api/music/resolve/" + sha + "/my-track", "read"},
		{"GET", "/api/music/variants", "read"}, // no trailing segment → not the lookup
		{"GET", "/api/spaces", "read"},
		{"POST", "/api/music/access/" + sha + "/my-track", "write"},
		{"GET", "/api/music/search?q=x", "search"},
		{"GET", "/api/music/variants/" + sha + "/search", "search"}, // search still wins
	}
	for _, tt := range tests {
		if got := classify(tt.method, tt.path); got != tt.want {
			t.Errorf("classify(%q, %q) = %q, want %q", tt.method, tt.path, got, tt.want)
		}
	}
}

// Allow() maps the "media" category onto MediaPerMin, not the read limit.
func TestAllow_MediaCategoryUsesMediaLimit(t *testing.T) {
	limits := DefaultLimits
	limits.ReadPerMin = 1
	limits.MediaPerMin = 3
	l := reportLimiter(t, limits) // skips when the dev Redis is unreachable
	const pk = "media-bucket-test-pubkey"
	l.client.Del(context.Background(), "ratelimit:media:"+pk, "ratelimit:read:"+pk)

	for i := 0; i < 3; i++ {
		res, err := l.Allow(context.Background(), pk, "media")
		if err != nil {
			t.Fatalf("allow %d: %v", i, err)
		}
		if !res.Allowed {
			t.Fatalf("media request %d denied under a limit of 3", i+1)
		}
	}
	res, err := l.Allow(context.Background(), pk, "media")
	if err != nil {
		t.Fatalf("allow 4: %v", err)
	}
	if res.Allowed {
		t.Fatal("4th media request should be denied")
	}
	// The read budget is untouched by the media traffic.
	read, err := l.Allow(context.Background(), pk, "read")
	if err != nil {
		t.Fatalf("read allow: %v", err)
	}
	if !read.Allowed {
		t.Fatal("read bucket should be independent of the media bucket")
	}
}

// End to end through the middleware: a variants lookup is keyed in the media
// bucket, so exhausting it 429s the lookup while an ordinary read still passes.
func TestMiddleware_MediaBucketIsIndependentOfReads(t *testing.T) {
	limits := DefaultLimits
	limits.MediaPerMin = 2
	limits.ReadPerMin = 100
	l := reportLimiter(t, limits)
	const pk = "media-middleware-test-pubkey"
	l.client.Del(context.Background(), "ratelimit:media:"+pk, "ratelimit:read:"+pk)

	handler := RateLimitMiddleware(l, true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	get := func(path string) int {
		req := httptest.NewRequest("GET", "http://localhost:9080"+path, nil)
		req.Header.Set("X-Auth-Pubkey", pk)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		return rr.Code
	}
	sha := "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34"
	if c := get("/api/music/variants/" + sha); c != http.StatusOK {
		t.Fatalf("1st variants lookup: %d", c)
	}
	if c := get("/api/music/access/" + sha + "/track"); c != http.StatusOK {
		t.Fatalf("1st access mint: %d", c)
	}
	if c := get("/api/music/variants/" + sha); c != http.StatusTooManyRequests {
		t.Fatalf("3rd media lookup should be 429, got %d", c)
	}
	if c := get("/api/spaces"); c != http.StatusOK {
		t.Fatalf("a read must not be throttled by the media bucket, got %d", c)
	}
}
