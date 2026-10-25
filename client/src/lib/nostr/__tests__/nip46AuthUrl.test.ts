import { describe, it, expect } from "vitest";
import { bunkerAuthUrlOrNull } from "../nip46AuthUrl";

/**
 * The NIP-46 `auth_url` is chosen by the remote bunker. It is handed to the
 * system opener (desktop) or window.open (web), so only an https page may go
 * through — never javascript:, file:, custom schemes, or plain http.
 */
describe("bunkerAuthUrlOrNull", () => {
  it("passes an https auth page through unchanged", () => {
    expect(bunkerAuthUrlOrNull("https://nsec.app/auth?token=abc")).toBe("https://nsec.app/auth?token=abc");
    expect(bunkerAuthUrlOrNull("  https://bunker.example/approve#x ")).toBe("https://bunker.example/approve#x");
  });

  it("rejects every non-https scheme", () => {
    for (const u of [
      "http://nsec.app/auth",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "nostrconnect://x",
      "data:text/html,<script>",
      "vbscript:msgbox",
      "ftp://x.example/",
      "//nsec.app/auth",
      "nsec.app/auth",
      "",
    ]) {
      expect(bunkerAuthUrlOrNull(u), u).toBeNull();
    }
  });

  it("rejects https URLs that carry credentials in the authority", () => {
    expect(bunkerAuthUrlOrNull("https://user:pw@nsec.app/auth")).toBeNull();
  });
});
