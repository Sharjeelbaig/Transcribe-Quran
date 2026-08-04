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

    expect(ass).toContain("Amiri Quran");
    expect(ass).toContain("Style: Quran,Amiri Quran,310,&H00FFFFFF,&H0000D7FF,&H00101010,&H90000000,0,0,0,0,100,100,0,0,1,4,1,5,");
    expect(ass).toContain("{\\an5\\pos(540,894)}");
    expect(ass).toContain("{\\an5\\pos(540,1135)}In (the) name");
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

  it("uses the frame-safe display window while retaining the measured word timing", () => {
    const canonical = index.words[0]!;
    const word: AlignedWord = {
      start: 0.5,
      end: 0.52,
      displayStart: 0.5,
      displayEnd: 0.62,
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

    const ass = createAss([word], index, 1, { minimumDisplaySeconds: 0.1 });
    expect(ass).toContain("Dialogue: 0,0:00:00.50,0:00:00.62,Quran");
  });

  it("never stretches a solved display window into the caption after it", () => {
    // The timing guard shortens a caption below the minimum when the reciter
    // is too fast to hold it any longer. Honouring the minimum here anyway
    // would draw two Arabic words on screen at once.
    const canonical = index.words[0]!;
    const base = {
      surah: canonical.surah,
      verse: canonical.verse,
      verseKey: canonical.verseKey,
      arabic: canonical.word.text.uthmani,
      imlaei: canonical.word.text.imlaei,
      wordTranslation: canonical.word.translation,
      verseTranslation: canonical.verseData.translations.saheehInternational,
      confidence: 1,
      inferredTiming: false,
    };
    const words: AlignedWord[] = [
      { ...base, position: 1, canonicalIndex: canonical.index, start: 1, end: 1.2, displayStart: 1, displayEnd: 1.2 },
      { ...base, position: 2, canonicalIndex: canonical.index + 1, start: 1.2, end: 1.9, displayStart: 1.2, displayEnd: 1.9 },
    ];

    const ass = createAss(words, index, 1, { minimumDisplaySeconds: 0.5 });
    const spans = ass
      .split("\n")
      .filter((line) => line.includes(",Quran,"))
      .map((line) => line.slice(10).split(",").slice(0, 3));

    expect(spans[0]?.[2]).toBe("0:00:01.20");
    expect(spans[1]?.[1]).toBe("0:00:01.20");
  });

  it("renders independently timed caption transitions without changing the measured window", () => {
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

    const ass = createAss([word], index, 1, {
      arabicVisual: {
        animationIn: { preset: "fade", duration: 120 },
        animationOut: { preset: "scale", duration: 180 },
      },
    });

    expect(ass).toContain("Dialogue: 0,0:00:00.40,0:00:00.52,Quran");
    expect(ass).toContain("\\alpha&HFF&\\t(0,120,\\alpha&H00&)");
    expect(ass).toContain("Dialogue: 0,0:00:01.02,0:00:01.20,Quran");
    expect(ass).toContain("\\t(0,180,\\fscx112\\fscy112\\alpha&HFF&)");
    expect(ass).toContain("Dialogue: 1,0:00:00.40,0:00:01.20,Translation");
  });

  it("animates a multi-word caption only when the grouped line enters and exits", () => {
    const canonical = index.words.slice(0, 3);
    const words: AlignedWord[] = canonical.map((item, index) => ({
      start: index + 1,
      end: index + 2,
      displayStart: index + 1,
      displayEnd: index + 2,
      surah: item.surah,
      verse: item.verse,
      verseKey: item.verseKey,
      position: item.position,
      arabic: item.word.text.uthmani,
      imlaei: item.word.text.imlaei,
      wordTranslation: item.word.translation,
      verseTranslation: item.verseData.translations.saheehInternational,
      confidence: 1,
      inferredTiming: false,
      canonicalIndex: item.index,
    }));
    const ass = createAss(words, index, 3, {
      arabicVisual: { animationIn: { preset: "fade", duration: 250 }, animationOut: { preset: "fade", duration: 250 } },
      translationVisual: { animationIn: { preset: "fade", duration: 250 }, animationOut: { preset: "fade", duration: 250 } },
    });
    const arabicEvents = ass.split("\n").filter((line) => line.includes(",Quran,"));
    const middle = arabicEvents.find((line) => line.includes("0:00:02.00,0:00:03.00"));

    expect(arabicEvents.some((line) => line.includes("\\alpha&HFF&"))).toBe(true);
    expect(middle).toBeDefined();
    expect(middle).not.toContain("\\alpha");
  });

  it("rejects a negative caption gap", () => {
    expect(() => createAss([], index, 1, { captionGap: -1 })).toThrow("non-negative number");
  });

  it("accepts user-selected Arabic and English font sizes", () => {
    const ass = createAss([], index, 1, { arabicFontSize: 110, translationFontSize: 42 });

    expect(ass).toContain("Style: Quran,Amiri Quran,110,");
    expect(ass).toContain("Style: Translation,Arial,42,");
  });

  it("accepts user-selected Arabic and English font families", () => {
    const ass = createAss([], index, 1, {
      arabicFontName: "Amiri",
      translationFontName: "Georgia",
    });

    expect(ass).toContain("Style: Quran,Amiri,310,");
    expect(ass).toContain("Style: Translation,Georgia,92,");
  });

  it("accepts independent caption and translation colours", () => {
    const ass = createAss([], index, 1, {
      arabicColor: "#FF0000",
      translationColor: "#00FF00",
    });

    expect(ass).toContain("Style: Quran,Amiri Quran,310,&H000000FF,");
    expect(ass).toContain("Style: Translation,Arial,92,&H0000FF00,");
  });

  it("accepts independently positioned caption layers", () => {
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
    const ass = createAss([word], index, 1, {
      arabicPosition: { x: 400, y: 700 },
      translationPosition: { x: 650, y: 1200 },
    });

    expect(ass).toContain("{\\an5\\pos(400,700)}");
    expect(ass).toContain("{\\an5\\pos(650,1200)}");
  });

  it("rejects font names that would corrupt the ASS style format", () => {
    expect(() => createAss([], index, 1, { arabicFontName: "Bad,Font" })).toThrow("font family name");
  });
});
