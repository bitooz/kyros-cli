import { describe, expect, it } from "vitest";
import { formatElapsedTime } from "../components.js";

describe("formatElapsedTime", () => {
  it("formats elapsed time with compact units", () => {
    expect(formatElapsedTime(59_000)).toBe("59s");
    expect(formatElapsedTime(14 * 60_000)).toBe("14m");
    expect(formatElapsedTime(60 * 60_000)).toBe("1h");
    expect(formatElapsedTime((60 + 24) * 60_000)).toBe("1h 24m");
  });

  it("clamps negative elapsed time to zero seconds", () => {
    expect(formatElapsedTime(-1000)).toBe("0s");
  });
});
