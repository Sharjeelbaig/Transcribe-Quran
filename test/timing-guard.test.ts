import { describe, expect, it } from "vitest";
import { protectWordTimings } from "../src/audio/timing-guard.js";
import type { AlignedWord } from "../src/types.js";

function word(canonicalIndex: number, start: number, end: number): AlignedWord {
  return {
    start,
    end,
    surah: 1,
    verse: 2,
    verseKey: "1:2",
    position: canonicalIndex + 1,
    arabic: "كَلِمَة",
    imlaei: "كلمة",
    wordTranslation: "word",
    verseTranslation: "verse",
    confidence: 1,
    inferredTiming: false,
    canonicalIndex,
  };
}

describe("frame-safe timing guard", () => {
  it("restores a direct word when a later timing pass collapses it at an adjacent boundary", () => {
    const recognizer = [
      word(4, 0.38, 1.34),
      word(5, 1.34, 2.48),
      word(6, 2.48, 3.06),
      word(7, 3.06, 5.56),
    ];
    const refined = recognizer.map((item) => ({ ...item }));
    refined[2] = { ...refined[2]!, start: 2.5, end: 2.52 };
    refined[3] = { ...refined[3]!, start: 2.52, end: 5.78 };

    const result = protectWordTimings(recognizer, refined, { frameRate: 25, minimumCaptionFrames: 3 });
    const collapsed = result.words[2]!;
    const following = result.words[3]!;

    expect(collapsed.start).toBeCloseTo(2.48, 5);
    expect(collapsed.end).toBeCloseTo(3.06, 5);
    expect(collapsed.timingSource).toBe("guard-fallback");
    expect(following.start).toBeCloseTo(3.06, 5);
    expect(following.timingSource).toBe("guard-fallback");
    expect(collapsed.displayEnd! - collapsed.displayStart!).toBeGreaterThanOrEqual(3 / 25);
    expect(following.displayStart).toBeGreaterThanOrEqual(collapsed.displayEnd!);
    expect(result.diagnostics.refinementFallbackWords).toBe(2);
  });

  it("keeps a genuine reciter elongation instead of replacing it with an earlier recognizer end", () => {
    const recognizer = [word(4, 1, 1.6), word(5, 3.4, 4)];
    const refined = [{ ...recognizer[0]!, end: 3.2 }, { ...recognizer[1]! }];

    const result = protectWordTimings(recognizer, refined, { frameRate: 30 });

    expect(result.words[0]?.end).toBe(3.2);
    expect(result.words[0]?.timingSource).toBe("refined");
    expect(result.diagnostics.refinementFallbackWords).toBe(0);
  });

  it("keeps genuinely short source words on screen long enough to read", () => {
    const recognizer = [word(4, 1, 1.02), word(5, 1.02, 1.04)];
    const result = protectWordTimings(recognizer, recognizer, { frameRate: 30, minimumCaptionFrames: 3 });

    expect(result.words[0]?.displayStart).toBe(1);
    expect(result.words[1]?.displayEnd).toBeCloseTo(1.92, 5);
    expect(result.diagnostics.displayExtendedWords).toBe(2);
    expect(result.diagnostics.minimumDisplaySeconds).toBe(0.5);
  });

  it("never shows a caption before its word was recited", () => {
    const recognizer = [word(4, 8, 8.05)];
    const result = protectWordTimings(recognizer, recognizer, { frameRate: 30 });

    expect(result.words[0]?.displayStart).toBe(8);
    expect(result.words[0]!.displayEnd! - result.words[0]!.displayStart!).toBeCloseTo(0.5, 5);
  });

  it("caps how far a caption may lag the audio to stay readable", () => {
    // Six words recited faster than the minimum display time. Captions must
    // stay close to the recitation rather than drifting further behind it.
    const recognizer = Array.from({ length: 6 }, (_, step) => word(4 + step, 1 + step * 0.2, 1.2 + step * 0.2));
    const result = protectWordTimings(recognizer, recognizer, {
      frameRate: 30,
      maximumDisplayDriftSeconds: 0.4,
    });

    for (const [position, item] of result.words.entries()) {
      expect(item.displayStart!).toBeLessThanOrEqual(recognizer[position]!.start + 0.4 + 1e-6);
    }
    expect(result.diagnostics.maximumDisplayShiftSeconds).toBeLessThanOrEqual(0.4 + 1e-6);
    expect(result.diagnostics.belowMinimumWords).toBeGreaterThan(0);
  });

  it("lingers on the last word of a phrase, into the silence that follows", () => {
    const ending = { ...word(4, 1, 2), endsSpeechSegment: true };
    const result = protectWordTimings([ending], [ending], { frameRate: 30, segmentHoldSeconds: 0.35 });

    expect(result.words[0]?.displayEnd).toBeCloseTo(2.35, 5);
  });
});
