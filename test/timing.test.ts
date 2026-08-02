import { beforeAll, describe, expect, it } from "vitest";
import { refineFinalWordTimings } from "../src/audio/timing.js";
import { buildQuranIndex, loadQuranCorpus } from "../src/index.js";
import type { QuranIndex } from "../src/quran/corpus.js";
import type { AlignedWord } from "../src/types.js";

let index: QuranIndex;

beforeAll(async () => {
  index = buildQuranIndex(await loadQuranCorpus());
});

function aligned(verseKey: string, position: number, start: number, end: number): AlignedWord {
  const canonical = index.words.find((word) => word.verseKey === verseKey && word.position === position)!;
  return {
    start,
    end,
    surah: canonical.surah,
    verse: canonical.verse,
    verseKey,
    position,
    arabic: canonical.word.text.uthmani,
    imlaei: canonical.word.text.imlaei,
    wordTranslation: canonical.word.translation,
    verseTranslation: canonical.verseData.translations.saheehInternational,
    confidence: 1,
    inferredTiming: true,
    canonicalIndex: canonical.index,
  };
}

describe("final-word audio timing refinement", () => {
  it("keeps an elongated final word visible until voice energy stops", () => {
    const audio = new Float32Array(6 * 16_000);
    for (let sample = 1.5 * 16_000; sample < 4.2 * 16_000; sample += 1) audio[sample] = 0.5;
    const words = [aligned("1:7", 9, 1.5, 2), aligned("4:105", 1, 5, 5.5)];

    const refined = refineFinalWordTimings(words, index, audio);

    expect(refined[0]?.end).toBeGreaterThan(3.8);
    expect(refined[0]?.end).toBeLessThan(4.3);
    expect(refined[0]?.end).toBeLessThan(refined[1]!.start);
  });
});
