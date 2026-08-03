import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalSpanOf,
  completeVerse,
  evenTimings,
  materializeSpan,
  reconcileSpan,
  trimCollapsedTail,
} from "../src/quran/passage.js";
import { buildQuranIndex, loadQuranCorpus } from "../src/index.js";
import type { QuranIndex } from "../src/quran/corpus.js";

let index: QuranIndex;

beforeAll(async () => {
  index = buildQuranIndex(await loadQuranCorpus());
});

function firstOf(verseKey: string): number {
  return index.words.find((word) => word.verseKey === verseKey && word.position === 1)!.index;
}

describe("canonical passage selection", () => {
  it("takes the whole range a phrase covers, including words the recognizer missed", () => {
    const start = firstOf("1:2");
    const span = canonicalSpanOf([start, start + 3], index, 6);

    expect(span).toEqual({ first: start, last: start + 3 });
  });

  it("ignores a stray match elsewhere in the Qur'an rather than spanning to it", () => {
    const start = firstOf("1:2");
    // One recognized word matched thousands of positions away. Taking the
    // outer bounds would caption the entire distance between them.
    const span = canonicalSpanOf([start, start + 1, start + 2, start + 12_000], index, 15);

    expect(span).toEqual({ first: start, last: start + 2 });
  });

  it("refuses a span implying more words than the phrase had time for", () => {
    const start = firstOf("2:1");
    const wide = Array.from({ length: 60 }, (_, step) => start + step);

    expect(canonicalSpanOf(wide, index, 1)).toBeUndefined();
    expect(canonicalSpanOf(wide, index, 60)).toEqual({ first: start, last: start + 59 });
  });

  it("returns nothing when no position was matched", () => {
    expect(canonicalSpanOf([], index, 5)).toBeUndefined();
  });
});

describe("passage continuity between phrases", () => {
  it("never repeats words the previous phrase already showed", () => {
    const span = reconcileSpan({ first: 100, last: 108 }, 103, true);

    expect(span).toEqual({ first: 104, last: 108 });
  });

  it("closes a small gap so the displayed text stays contiguous", () => {
    const span = reconcileSpan({ first: 110, last: 118 }, 105, true);

    expect(span).toEqual({ first: 106, last: 118 });
  });

  it("leaves a jump to an unrelated passage alone", () => {
    const span = reconcileSpan({ first: 5_000, last: 5_004 }, 105, false);

    expect(span).toEqual({ first: 5_000, last: 5_004 });
  });

  it("drops a phrase whose passage the previous one already covered", () => {
    expect(reconcileSpan({ first: 100, last: 103 }, 103, true)).toBeUndefined();
  });

  it("follows the reciter back to an earlier passage instead of pushing forward", () => {
    // A new rak'ah returns to al-Fatiha after a later surah. Advancing past the
    // previous phrase here would caption words the reciter never said.
    const span = reconcileSpan({ first: 1, last: 6 }, 4_000, false);

    expect(span).toEqual({ first: 1, last: 6 });
  });
});

describe("finishing an ayah the recognizer cut short", () => {
  it("offers the remaining words of the verse", () => {
    // Al-Fatiha 1:7 has nine words; a span stopping at the seventh should be
    // offered the eighth and ninth.
    const start = firstOf("1:7");
    const extended = completeVerse({ first: start, last: start + 6 }, index);

    expect(extended.last).toBe(start + 8);
  });

  it("leaves a span that already ends the verse untouched", () => {
    const start = firstOf("1:7");
    const span = { first: start, last: start + 8 };

    expect(completeVerse(span, index)).toEqual(span);
  });

  it("keeps offered words the audio supports and discards the rest", () => {
    const timings = [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 2.6 },
      { start: 2.6, end: 2.62 },
    ];

    expect(trimCollapsedTail(timings, 2, 0.25)).toBe(3);
    expect(trimCollapsedTail(timings, 4, 0.25)).toBe(4);
  });
});

describe("caption words for a passage", () => {
  it("takes every displayed value from the corpus, not the recognizer", () => {
    const start = firstOf("1:2");
    const span = { first: start, last: start + 1 };
    const words = materializeSpan(span, index, "saheehInternational", [
      { start: 0.5, end: 1.5 },
      { start: 1.5, end: 2.5 },
    ], 0.9, true);

    expect(words).toHaveLength(2);
    expect(words[0]?.arabic).toBe(index.words[start]!.word.text.uthmani);
    expect(words[0]?.verseTranslation).toBe(index.words[start]!.verseData.translations.saheehInternational);
    expect(words[0]?.timingSource).toBe("forced");
    expect(words[0]?.inferredTiming).toBe(false);
    expect(words[1]?.start).toBe(1.5);
  });

  it("marks timings as inferred when they were not measured", () => {
    const start = firstOf("1:2");
    const words = materializeSpan({ first: start, last: start }, index, "saheehInternational", evenTimings(1, 2), 0.5, false);

    expect(words[0]?.inferredTiming).toBe(true);
    expect(words[0]?.timingSource).toBe("inferred");
  });
});
