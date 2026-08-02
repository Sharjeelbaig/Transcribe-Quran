import { beforeAll, describe, expect, it } from "vitest";
import {
  buildQuranIndex,
  loadQuranCorpus,
  matchTranscript,
  materializeAlignedWords,
  normalizeArabic,
} from "../src/index.js";
import type { QuranIndex } from "../src/quran/corpus.js";
import type { TranscriptWord } from "../src/types.js";

let index: QuranIndex;

beforeAll(async () => {
  index = buildQuranIndex(await loadQuranCorpus());
});

function transcriptFor(verseKeys: string[]): TranscriptWord[] {
  const canonical = index.words.filter((word) => verseKeys.includes(word.verseKey));
  return canonical.map((word, position) => ({
    text: word.word.text.imlaei,
    normalized: word.normalized,
    start: position * 0.4,
    end: position * 0.4 + 0.38,
  }));
}

describe("Qur'an passage matcher", () => {
  it("finds a passage anywhere in the full Qur'an", () => {
    const transcript = transcriptFor(["112:1", "112:2", "112:3", "112:4"]);
    const result = matchTranscript(transcript, index);
    const words = materializeAlignedWords(result.matched, index, "saheehInternational");

    expect(result.unmatchedWindows).toBe(0);
    expect(words).toHaveLength(transcript.length);
    expect(words[0]?.verseKey).toBe("112:1");
    expect(words.at(-1)?.verseKey).toBe("112:4");
    expect(words.every((word) => word.confidence > 0.9)).toBe(true);
  });

  it("survives a recognition error while keeping canonical display text", () => {
    const transcript = transcriptFor(["108:1", "108:2", "108:3"]);
    transcript[1] = {
      ...transcript[1]!,
      text: "فصل",
      normalized: normalizeArabic("فصل"),
    };
    const result = matchTranscript(transcript, index, 0.5);
    const words = materializeAlignedWords(result.matched, index, "abdulHaleem");

    expect(words[0]?.verseKey).toBe("108:1");
    expect(words.at(-1)?.verseKey).toBe("108:3");
    expect(words.some((word) => word.arabic.includes("فَصَلِّ"))).toBe(true);
  });

  it("refuses unrelated speech instead of inventing Qur'an captions", () => {
    const transcript = ["مرحبا", "صباح", "سياره", "جامعه", "حاسوب"].map(
      (text, position) => ({
        text,
        normalized: normalizeArabic(text),
        start: position * 0.5,
        end: position * 0.5 + 0.4,
      }),
    );
    const result = matchTranscript(transcript, index);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedWindows).toBe(1);
  });

  it("refuses an exact phrase that occurs at multiple Qur'an locations", () => {
    const transcript = transcriptFor(["1:1"]);
    const result = matchTranscript(transcript, index);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedWindows).toBe(1);
  });
});
