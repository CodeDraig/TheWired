package proxy

import (
	"net/http"
	"strings"
)

// uploadPaths are the /api routes that legitimately carry large multipart
// bodies (the backend enforces MAX_BLOB_SIZE on them). Everything else under
// /api is small JSON and gets the cap. Blossom's PUT /upload is not under /api.
var uploadPaths = map[string]bool{
	"/api/music/upload":       true,
	"/api/music/upload/cover": true,
}

func isUploadPath(path string) bool {
	return uploadPaths[strings.TrimRight(path, "/")]
}

// BodyLimitMiddleware caps request bodies on non-upload /api routes. A declared
// Content-Length over the cap is refused with 413 up front; an undeclared
// (chunked) body is wrapped in http.MaxBytesReader so the read stops at the
// cap. maxBytes <= 0 disables the cap.
func BodyLimitMiddleware(maxBytes int64, next http.Handler) http.Handler {
	if maxBytes <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isUploadPath(r.URL.Path) || r.Body == nil || r.Body == http.NoBody {
			next.ServeHTTP(w, r)
			return
		}
		if r.ContentLength > maxBytes {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			w.Write([]byte(`{"error":"request body too large","code":"PAYLOAD_TOO_LARGE"}`))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		next.ServeHTTP(w, r)
	})
}
