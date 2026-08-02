import { describe, expect, it } from "vitest";
import { buildQuranIndex, loadQuranCorpus, normalizeArabic } from "../src/index.js";

describe("canonical Qur'an corpus", () => {
  it("loads all surahs, verses, and words", async () => {
    const corpus = await loadQuranCorpus();
    const index = buildQuranIndex(corpus);

    expect(corpus.totals).toEqual({ surahs: 114, verses: 6236, words: 77429 });
    expect(corpus.surahs).toHaveLength(114);
    expect(index.verses.size).toBe(6236);
    expect(index.words).toHaveLength(77429);
    expect(index.words[0]?.verseKey).toBe("1:1");
    expect(index.words.at(-1)?.verseKey).toBe("114:6");
  });

  it("normalizes reciter output without changing display text", () => {
    expect(normalizeArabic("بِسْمِ ٱللَّهِ الرَّحْمَـٰنِ الرَّحِيمِ")).toBe(
      "بسم الله الرحمن الرحيم",
    );
    expect(normalizeArabic("إِنَّا أَعْطَيْنَاكَ الْكَوْثَرَ")).toBe(
      "انا اعطيناك الكوثر",
    );
  });
});
