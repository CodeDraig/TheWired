import { describe, it, expect } from "vitest";
import { hostVerdict, modDeleteRefusal } from "../modDelete";

describe("hostVerdict", () => {
  const results = [
    { relayUrl: "wss://mirror.example", success: true, message: "" },
    { relayUrl: "wss://relay.example", success: false, message: "restricted: not authorized" },
  ];

  it("reads the host relay's answer, not a mirror's acceptance", () => {
    expect(hostVerdict(results, "wss://relay.example")?.success).toBe(false);
  });

  it("normalizes URL spellings", () => {
    expect(hostVerdict(results, "wss://relay.example/")?.message).toBe("restricted: not authorized");
  });

  it("is undefined when the host never answered or there is no host", () => {
    expect(hostVerdict(results, "wss://other.example")).toBeUndefined();
    expect(hostVerdict(results, undefined)).toBeUndefined();
  });
});

describe("modDeleteRefusal", () => {
  it("turns the relay's prefixes into words", () => {
    expect(modDeleteRefusal("restricted: not authorized")).toBe("You don't have permission to delete messages here.");
    expect(modDeleteRefusal("not authorized")).toBe("You don't have permission to delete messages here.");
    expect(modDeleteRefusal("invalid: event is not in this group")).toBe("That message isn't in this space.");
    expect(modDeleteRefusal("error: db down")).toBe("The relay refused: error: db down");
    expect(modDeleteRefusal("")).toBe("The relay refused the delete.");
  });
});
