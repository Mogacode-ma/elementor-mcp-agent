import { describe, it, expect, beforeEach } from "vitest";
import { issueConfirmation, consumeConfirmation, _clearAllConfirmations } from "../src/utils/confirmation.js";

describe("confirmation tokens", () => {
  beforeEach(() => _clearAllConfirmations());

  it("issues and consumes a token once", () => {
    const t = issueConfirmation("op", { a: 1 }, 60);
    expect(consumeConfirmation(t, "op")).not.toBeNull();
    expect(consumeConfirmation(t, "op")).toBeNull(); // already consumed
  });
  it("rejects mismatched intent", () => {
    const t = issueConfirmation("op_a", {}, 60);
    expect(consumeConfirmation(t, "op_b")).toBeNull();
  });
  it("rejects expired tokens", async () => {
    const t = issueConfirmation("op", {}, 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(consumeConfirmation(t, "op")).toBeNull();
  });
});
