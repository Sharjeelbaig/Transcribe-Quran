import { beforeAll, describe, expect, it } from "vitest";
import { buildQuranIndex, createAss, loadQuranCorpus } from "../src/index.js";
import type { QuranIndex } from "../src/quran/corpus.js";
import type { AlignedWord } from "../src/types.js";

let index: QuranIndex;

beforeAll(async () => {
  index = buildQuranIndex(await loadQuranCorpus());
});

describe("ASS caption generation", () => {
  it("renders canonical Arabic, an active-word highlight, and translation", () => {
    const canonical = index.words[0]!;
    const word: AlignedWord = {
      start: 0.4,
      end: 1.2,
      surah: canonical.surah,
      verse: canonical.verse,
      verseKey: canonical.verseKey,
      position: canonical.position,
      arabic: canonical.word.text.uthmani,
      imlaei: canonical.word.text.imlaei,
      wordTranslation: canonical.word.translation,
      verseTranslation: canonical.verseData.translations.saheehInternational,
      confidence: 1,
      inferredTiming: false,
      canonicalIndex: canonical.index,
    };
    const ass = createAss([word], index);

    expect(ass).toContain("Noto Naskh Arabic");
    expect(ass).toContain("{\\c&H0000D7FF&\\b1}\u2067بِسْمِ\u2069");
    expect(ass).not.toContain("ٱللَّهِ");
    expect(ass).toContain("In (the) name  •  1:1");
    expect(ass).toContain("Dialogue: 0,0:00:00.40,0:00:01.20,Quran");
  });

  it("serializes multi-word groups in explicit right-to-left visual order", () => {
    const canonical = index.words[0]!;
    const word: AlignedWord = {
      start: 0.4,
      end: 1.2,
      surah: canonical.surah,
      verse: canonical.verse,
      verseKey: canonical.verseKey,
      position: canonical.position,
      arabic: canonical.word.text.uthmani,
      imlaei: canonical.word.text.imlaei,
      wordTranslation: canonical.word.translation,
      verseTranslation: canonical.verseData.translations.saheehInternational,
      confidence: 1,
      inferredTiming: false,
      canonicalIndex: canonical.index,
    };
    const ass = createAss([word], index, 4);
    const event = ass.split("\n").find((line) => line.includes(",Quran,"))!;
    const verseWords = canonical.verseData.words.map((item) => item.text.uthmani);

    expect(event.indexOf(verseWords[3]!)).toBeLessThan(event.indexOf(verseWords[2]!));
    expect(event.indexOf(verseWords[2]!)).toBeLessThan(event.indexOf(verseWords[1]!));
    expect(event.indexOf(verseWords[1]!)).toBeLessThan(event.indexOf(verseWords[0]!));
  });

  it("rejects invalid word limits", () => {
    expect(() => createAss([], index, 0)).toThrow("positive integer");
  });
});
