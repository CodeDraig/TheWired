// Package gatewayauth signs the identity headers the gateway forwards to the
// backend (X-Auth-Pubkey after NIP-98 verification, X-Client-Ip for the guest
// report intake) so the backend can tell a gateway-vouched identity from a
// header planted by anything else that can reach it on the Docker network.
//
// Wire format, one header:
//
//	X-Gateway-Auth: <unix_ts>.<hex HMAC-SHA256(GATEWAY_SHARED_SECRET, msg)>
//	msg = ts + "\n" + pubkey + "\n" + METHOD + "\n" + path + "\n" + clientIp
//
// where `path` is the request-target path the backend receives (the /api
// prefix already stripped, percent-encoded exactly as written on the wire, no
// query string), and `pubkey` / `clientIp` are the exact forwarded header
// values or "" when the header is absent. The backend verifies with a
// constant-time compare and |now - ts| <= 120s.
package gatewayauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Header carries the MAC. It is an internal header: proxy.StripInternalHeaders
// removes any inbound copy before routing.
const Header = "X-Gateway-Auth"

// MaxSkew is how far the backend lets the signing timestamp drift from its
// own clock. The two containers share a host clock, so this only has to cover
// a slow proxy hop.
const MaxSkew = 120 * time.Second

// Signer holds the shared secret. A nil *Signer is a valid, disabled signer.
type Signer struct {
	secret []byte
	now    func() time.Time
}

// NewSigner returns nil when the secret is empty — the rollout default, where
// nothing new is sent and the backend keeps today's topological trust.
func NewSigner(secret string) *Signer {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil
	}
	return &Signer{secret: []byte(secret), now: time.Now}
}

// MAC computes the hex HMAC over the canonical string.
func MAC(secret []byte, ts int64, pubkey, method, path, clientIP string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(pubkey))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(method))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(path))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(clientIP))
	return hex.EncodeToString(mac.Sum(nil))
}

// Apply signs r's identity headers over backendPath and sets Header. It always
// clears any pre-existing value first; when the request carries no identity
// (anonymous, no forwarded IP) the header stays absent.
func (s *Signer) Apply(r *http.Request, backendPath string) {
	r.Header.Del(Header)
	if s == nil {
		return
	}
	pubkey := r.Header.Get("X-Auth-Pubkey")
	clientIP := r.Header.Get("X-Client-Ip")
	if pubkey == "" && clientIP == "" {
		return
	}
	ts := s.now().Unix()
	r.Header.Set(Header, strconv.FormatInt(ts, 10)+"."+MAC(s.secret, ts, pubkey, r.Method, backendPath, clientIP))
}

// Verify is the backend-side check, kept here so the gateway tests pin the
// exact contract the backend (services/backend/src/middleware/authContext.ts)
// implements: parse ts, bound the skew, constant-time compare.
func (s *Signer) Verify(tsStr, mac, pubkey, method, path, clientIP string, now time.Time) bool {
	if s == nil {
		return false
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return false
	}
	skew := now.Unix() - ts
	if skew < 0 {
		skew = -skew
	}
	if time.Duration(skew)*time.Second > MaxSkew {
		return false
	}
	want := MAC(s.secret, ts, pubkey, method, path, clientIP)
	return subtle.ConstantTimeCompare([]byte(want), []byte(mac)) == 1
}
