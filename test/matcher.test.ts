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

  it("removes adjacent timestamp overlaps so captions never stack", () => {
    const transcript = transcriptFor(["1:5"]);
    transcript[2] = { ...transcript[2]!, end: 2.2 };
    transcript[3] = { ...transcript[3]!, start: 1.85, end: 2.8 };

    const result = matchTranscript(transcript, index);
    const words = materializeAlignedWords(result.matched, index, "saheehInternational");

    expect(words.map((word) => word.position)).toEqual([1, 2, 3, 4]);
    expect(words.every((word, position) => position === 0 || word.start >= words[position - 1]!.end)).toBe(true);
    expect(words[2]?.end).toBe(words[3]?.start);
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

  it("uses established continuity to recover a damaged following window", () => {
    const recognized = [
      "وإذ",
      "بالله",
      "الرحمن",
      "الرحيم",
      "والضحى",
      "والنيلي",
      "إذا",
      "سجاما",
      "وهد",
      "عاقهم",
      "وما",
      "قلى",
      "وذه",
      "خير",
      "لك",
      "من",
      "عن",
      "كنتم",
      "ولا",
      "سوف",
      "يوعطيني",
      "تربك",
      "فتابى",
      "والراليين",
    ];
    const transcript = recognized.map((text, position) => {
      const start = position < 4 ? position : 15 + (position - 4) * 0.8;
      return {
        text,
        normalized: normalizeArabic(text),
        start,
        end: start + 0.7,
      };
    });
    const result = matchTranscript(transcript, index, 0.5);
    const words = materializeAlignedWords(result.matched, index, "saheehInternational");

    expect(words[0]?.verseKey).toBe("93:1");
    expect(words.at(-1)?.verseKey).toBe("93:5");
    expect(new Set(words.map((word) => word.verseKey))).toEqual(
      new Set(["93:1", "93:2", "93:3", "93:4", "93:5"]),
    );
    expect(words.some((word) => word.arabic === "سَجَىٰ")).toBe(true);
    expect(new Set(words.map((word) => word.canonicalIndex)).size).toBe(words.length);
  });

  it("recovers a damaged final verse word from established local context", () => {
    const verse = index.words.filter((word) => word.verseKey === "1:7");
    const transcript = verse.slice(0, -1).map((word, position) => ({
      text: word.word.text.imlaei,
      normalized: word.normalized,
      start: position * 0.8,
      end: position * 0.8 + 0.7,
    }));
    transcript.push({
      text: "ريء",
      normalized: normalizeArabic("ريء"),
      start: transcript.at(-1)!.end,
      end: transcript.at(-1)!.end + 2.2,
    });

    const result = matchTranscript(transcript, index, 0.5);
    const words = materializeAlignedWords(result.matched, index, "saheehInternational");

    expect(words.map((word) => word.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(words.at(-1)?.arabic).toBe("ٱلضَّآلِّينَ");
    expect(words.at(-1)?.inferredTiming).toBe(true);
  });

  it("restores a word recited too fast to leave a gap, instead of dropping it", () => {
    // The recognizer misses the middle word and reports the two around it back
    // to back, so there is no spare time between them to place the missing one.
    const verse = index.words.filter((word) => word.verseKey === "1:4");
    const matched = [verse[0]!, verse[2]!].map((word, position) => ({
      text: word.word.text.imlaei,
      normalized: word.normalized,
      start: position * 0.6,
      end: position * 0.6 + 0.6,
      canonicalIndex: word.index,
      matchConfidence: 0.95,
    }));

    const words = materializeAlignedWords(matched, index, "saheehInternational");

    expect(words.map((word) => word.position)).toEqual([1, 2, 3]);
    expect(words[1]?.imlaei).toBe(verse[1]?.word.text.imlaei);
    expect(words[1]?.inferredTiming).toBe(true);
    expect(words[1]!.end).toBeGreaterThan(words[1]!.start);
    expect(words.every((word, position) => position === 0 || word.start >= words[position - 1]!.end - 1e-9)).toBe(true);
  });

  it("follows the reciter back to al-Fatiha at the start of a new rak'ah", () => {
    // A passage from a later surah, then al-Fatiha again. The second passage
    // sits far behind the first, which earlier releases discarded outright.
    const later = transcriptFor(["21:1"]);
    const fatiha = index.words
      .filter((word) => ["1:2", "1:3", "1:4"].includes(word.verseKey))
      .map((word, position) => ({
        text: word.word.text.imlaei,
        normalized: word.normalized,
        start: 40 + position * 0.6,
        end: 40 + position * 0.6 + 0.5,
      }));

    const result = matchTranscript([...later, ...fatiha], index, 0.5);
    const words = materializeAlignedWords(result.matched, index, "saheehInternational");

    expect(words.some((word) => word.verseKey === "21:1")).toBe(true);
    expect(words.some((word) => word.verseKey === "1:2")).toBe(true);
    expect(words.some((word) => word.verseKey === "1:4")).toBe(true);
  });
});
