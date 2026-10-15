import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { RichContent } from "../RichContent";

vi.mock("@/features/profile/useProfile", () => ({ useProfile: () => ({ profile: null }) }));

describe("music provider links in notes", () => {
  it("draws a SoundCloud link as a card named from its slug", () => {
    renderWithProviders(<RichContent content="new mix https://soundcloud.com/some-artist/late_night-mix" />);
    expect(screen.getByText("late night mix")).toBeTruthy();
    expect(screen.getByText("SoundCloud · track")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://soundcloud.com/some-artist/late_night-mix");
  });

  it("names an Apple Music link from the slug before its id", () => {
    renderWithProviders(<RichContent content="https://music.apple.com/us/album/blue-hour/1234567890?i=987" />);
    expect(screen.getByText("blue hour")).toBeTruthy();
    expect(screen.getByText("Apple Music · song")).toBeTruthy();
  });

  it("leaves other links as links", () => {
    renderWithProviders(<RichContent content="https://example.com/page" />);
    expect(screen.getByRole("link").textContent).toBe("https://example.com/page");
  });
});
