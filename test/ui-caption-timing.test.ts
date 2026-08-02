import { describe, expect, it } from "vitest";
import { findActiveCaptionIndex } from "../ui/caption-timing.js";

const words = [
  { start: 3.06, end: 5.56 },
  { start: 6.74, end: 8.28 },
];

describe("caption preview timing", () => {
  it("shows no caption during a real gap instead of falling back to the first word", () => {
    expect(findActiveCaptionIndex(words, 6)).toBe(-1);
  });

  it("selects the active caption", () => {
    expect(findActiveCaptionIndex(words, 4.5)).toBe(0);
    expect(findActiveCaptionIndex(words, 7)).toBe(1);
  });

  it("allows only a small look-ahead for smooth visual entry", () => {
    expect(findActiveCaptionIndex(words, 6.65)).toBe(1);
    expect(findActiveCaptionIndex(words, 6.5)).toBe(-1);
  });
});
