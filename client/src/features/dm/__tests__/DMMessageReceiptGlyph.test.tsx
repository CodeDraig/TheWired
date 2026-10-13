import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { lunaVega, riverChen } from "@/__tests__/fixtures/testUsers";
import { login } from "@/store/slices/identitySlice";
import type { DMMessage as DMMessageType } from "@/store/slices/dmSlice";

vi.mock("../../profile/useProfile", () => ({ useProfile: () => ({ profile: null }) }));
vi.mock("../../profile/UserPopoverContext", () => ({ useUserPopover: () => ({ open: vi.fn() }) }));
vi.mock("../DMMessageContextMenu", () => ({ DMMessageContextMenu: () => null }));

import { DMMessage } from "../DMMessage";

const ME = lunaVega.pubkey;
const PEER = riverChen.pubkey;
const ANY_GLYPH = '[data-testid="dm-sent"], [data-testid="dm-delivered"], [data-testid="dm-read"]';

function renderMsg(
  message: DMMessageType,
  isGrouped: boolean,
  isRoom = false,
  onResend?: (m: DMMessageType) => void,
) {
  const store = createTestStore();
  store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
  return render(
    <MemoryRouter>
      <Provider store={store}>
        <DMMessage message={message} partnerPubkey={PEER} isGrouped={isGrouped} isRoom={isRoom} onResend={onResend} />
      </Provider>
    </MemoryRouter>,
  );
}

const base: DMMessageType = {
  id: "m1",
  senderPubkey: ME,
  content: "hello",
  createdAt: 1_700_000_000,
  wrapId: "w1",
  rumorId: "r".repeat(64),
};

/** The one receipt glyph on the row: its test id, title, icon and tint. */
function glyph(container: HTMLElement) {
  const all = container.querySelectorAll(ANY_GLYPH);
  expect(all).toHaveLength(1);
  const el = all[0] as HTMLElement;
  return {
    testId: el.dataset.testid,
    title: el.title,
    icon: el.querySelector("svg.lucide-check-check") ? "check-check" : el.querySelector("svg.lucide-check") ? "check" : null,
    primary: el.classList.contains("text-primary"),
  };
}

describe("DMMessage receipt glyphs (kind 20015 → deliveredTo / readBy)", () => {
  it("shows Sent, then Delivered, then Read on an ungrouped own message", () => {
    const { container, rerender } = renderMsg(base, false);
    expect(glyph(container)).toEqual({ testId: "dm-sent", title: "Sent", icon: "check", primary: false });

    const store = createTestStoreLoggedIn();
    const at = (message: DMMessageType) => (
      <MemoryRouter>
        <Provider store={store}>
          <DMMessage message={message} partnerPubkey={PEER} isGrouped={false} />
        </Provider>
      </MemoryRouter>
    );
    rerender(at({ ...base, deliveredTo: [PEER] }));
    expect(glyph(container)).toEqual({ testId: "dm-delivered", title: "Delivered", icon: "check-check", primary: false });
    rerender(at({ ...base, deliveredTo: [PEER], readBy: [PEER] }));
    expect(glyph(container)).toEqual({ testId: "dm-read", title: "Read", icon: "check-check", primary: true });
  });

  it("still renders the glyph when the message is grouped under a previous own message", () => {
    const { container } = renderMsg({ ...base, readBy: [PEER] }, true);
    expect(glyph(container).testId).toBe("dm-read");
  });

  it("shows Sent on a grouped own message without receipts (a history row is sent by definition)", () => {
    const { container } = renderMsg(base, true);
    expect(glyph(container).testId).toBe("dm-sent");
  });

  it("applies the same rules to a room message (any participant's receipt counts)", () => {
    const { container: a } = renderMsg(base, false, true);
    expect(glyph(a).testId).toBe("dm-sent");
    const { container: b } = renderMsg({ ...base, deliveredTo: ["c".repeat(64)] }, true, true);
    expect(glyph(b).testId).toBe("dm-delivered");
    const { container: c } = renderMsg({ ...base, deliveredTo: [PEER, "c".repeat(64)], readBy: [PEER] }, false, true);
    expect(glyph(c).testId).toBe("dm-read");
  });

  it("never renders a receipt glyph on the peer's messages, and the sync warning replaces it", () => {
    const { container: a } = renderMsg({ ...base, senderPubkey: PEER, readBy: [ME] }, false);
    expect(a.querySelector(ANY_GLYPH)).toBeNull();
    const { container: b } = renderMsg({ ...base, syncWarning: true }, false);
    expect(b.querySelector(ANY_GLYPH)).toBeNull();
    expect(b.querySelector('[data-testid="dm-sync-warning"]')).not.toBeNull();
  });
});

describe("DMMessage send state (relay OK → sent, as on mobile)", () => {
  const SENDING = '[data-testid="dm-sending"]';
  const FAILED = '[data-testid="dm-failed"]';
  const RESEND = '[data-testid="dm-resend"]';

  it("a pending own message shows Sending… and no check until a relay accepts it", () => {
    const { container } = renderMsg({ ...base, status: "pending" }, false);
    expect(container.querySelector(SENDING)?.getAttribute("title")).toBe("Sending…");
    expect(container.querySelector(ANY_GLYPH)).toBeNull();
  });

  it("an accepted message shows the Sent check (explicit status and no status alike)", () => {
    const { container } = renderMsg({ ...base, status: "sent" }, true);
    expect(glyph(container).testId).toBe("dm-sent");
    expect(container.querySelector(SENDING)).toBeNull();
  });

  it("a failed message shows Failed and a Resend that hands the row back", () => {
    const onResend = vi.fn();
    const failed: DMMessageType = { ...base, status: "failed" };
    const { container } = renderMsg(failed, true, false, onResend);
    expect(container.querySelector(FAILED)?.textContent).toContain("Failed");
    expect(container.querySelector(ANY_GLYPH)).toBeNull();
    fireEvent.click(container.querySelector(RESEND)!);
    expect(onResend).toHaveBeenCalledWith(failed);
  });

  it("receipts never show on a failed row, and the peer's rows carry no send state", () => {
    const { container: a } = renderMsg({ ...base, status: "failed", readBy: [PEER] }, false);
    expect(a.querySelector(ANY_GLYPH)).toBeNull();
    expect(a.querySelector(RESEND)).toBeNull(); // no handler → no button
    const { container: b } = renderMsg({ ...base, senderPubkey: PEER, status: "pending" }, false);
    expect(b.querySelector(SENDING)).toBeNull();
  });
});

function createTestStoreLoggedIn() {
  const store = createTestStore();
  store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
  return store;
}
