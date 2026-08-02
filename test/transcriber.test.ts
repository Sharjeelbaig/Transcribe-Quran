import { describe, expect, it } from "vitest";
import { chunksToWords } from "../src/model/transcriber.js";

describe("Whisper timestamp sanitization", () => {
  it("rejects an impossible multi-window word span", () => {
    const words = chunksToWords(
      [
        { text: "صِرَاطِرِ", timestamp: [0.28, 14.28] },
        { text: "أَنْعَمْتَ", timestamp: [6.94, 8.18] },
      ],
      9,
    );

    expect(words[0]?.start).toBe(0.28);
    expect(words[0]?.end).toBe(0.5);
    expect(words[0]!.end - words[0]!.start).toBeLessThan(5);
  });
});
