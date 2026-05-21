import { describe, it, expect } from "vitest";
import { TokenBucket } from "../src/throttle/token-bucket.js";

describe("TokenBucket", () => {
  it("starts at full capacity", () => {
    const b = new TokenBucket(60);
    expect(b.available).toBe(60);
  });
  it("decrements on acquire", async () => {
    const b = new TokenBucket(60);
    await b.acquire();
    expect(b.available).toBe(59);
  });
  it("refills over time", async () => {
    const b = new TokenBucket(600); // 10/s
    for (let i = 0; i < 5; i++) await b.acquire();
    expect(b.available).toBeGreaterThanOrEqual(595);
    await new Promise((r) => setTimeout(r, 400));
    expect(b.available).toBeGreaterThanOrEqual(599);
  });
});
