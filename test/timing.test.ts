import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeSpeech,
  measureCaptionCoverage,
  placeInferredWordsOnSpeech,
  refineSpeechWordTimings,
} from "../src/audio/timing.js";
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

describe("speech-state audio timing refinement", () => {
  it("keeps an elongated final word visible until voice energy stops", () => {
    const audio = new Float32Array(6 * 16_000);
    for (let sample = 1.5 * 16_000; sample < 4.2 * 16_000; sample += 1) audio[sample] = 0.5;
    const words = [aligned("1:7", 9, 1.5, 2), aligned("4:105", 1, 5, 5.5)];

    const refined = refineSpeechWordTimings(words, audio, { pauseSeconds: 0.6 });

    expect(refined[0]?.end).toBeGreaterThan(3.8);
    expect(refined[0]?.end).toBeLessThan(4.3);
    expect(refined[0]?.end).toBeLessThan(refined[1]!.start);
  });

  it("keeps a word active through a short breath and releases it at sustained quiet", () => {
    const audio = new Float32Array(5 * 16_000);
    for (let sample = 0.4 * 16_000; sample < 1.1 * 16_000; sample += 1) audio[sample] = 0.5;
    // A 0.35 second breath is shorter than the configured stop threshold.
    for (let sample = 1.45 * 16_000; sample < 2.4 * 16_000; sample += 1) audio[sample] = 0.5;
    const words = [aligned("1:1", 1, 0.4, 1.1), aligned("1:1", 2, 3.2, 3.6)];

    const refined = refineSpeechWordTimings(words, audio, { pauseSeconds: 0.6 });

    expect(refined[0]?.end).toBeGreaterThan(2.25);
    expect(refined[0]?.end).toBeLessThan(2.5);
  });

  it("holds a word through a long elongation that fades away", () => {
    // A sustained ending that decays instead of stopping abruptly, which an
    // absolute threshold would cut off part-way through.
    const audio = new Float32Array(10 * 16_000);
    for (let sample = 1 * 16_000; sample < 2 * 16_000; sample += 1) audio[sample] = 0.5;
    for (let sample = 2 * 16_000; sample < 6 * 16_000; sample += 1) {
      const progress = (sample - 2 * 16_000) / (4 * 16_000);
      audio[sample] = 0.5 * (1 - progress * 0.75);
    }
    const words = [aligned("1:2", 1, 1, 1.6)];

    const refined = refineSpeechWordTimings(words, audio, { pauseSeconds: 0.6 });

    expect(refined[0]?.end).toBeGreaterThan(5.5);
    expect(refined[0]?.endsSpeechSegment).toBe(true);
  });

  it("places words the recognizer missed on the voice, not evenly across silence", () => {
    // Two bursts of speech separated by silence. Two missing words spread
    // evenly would put the boundary in the gap; by energy it lands on a burst.
    const audio = new Float32Array(8 * 16_000);
    for (let sample = 0.5 * 16_000; sample < 1.5 * 16_000; sample += 1) audio[sample] = 0.5;
    for (let sample = 5.5 * 16_000; sample < 6.5 * 16_000; sample += 1) audio[sample] = 0.5;
    const analysis = analyzeSpeech(audio, { pauseSeconds: 0.6 });
    const words = [
      { ...aligned("1:2", 1, 0.5, 3.5), inferredTiming: true },
      { ...aligned("1:2", 2, 3.5, 6.5), inferredTiming: true },
    ];

    const placed = placeInferredWordsOnSpeech(words, analysis);
    const refined = refineSpeechWordTimings(placed, audio, { pauseSeconds: 0.6 }, analysis);

    // Dividing the span evenly puts the boundary at 3.5 s, in the middle of
    // the silence, which leaves both captions straddling audio they do not
    // belong to. Each word should end up on the burst it was recited in.
    expect(placed[0]!.end).toBeGreaterThan(5);
    expect(refined[0]!.start).toBeLessThan(1);
    expect(refined[0]!.end).toBeLessThan(1.6);
    expect(refined[1]!.start).toBeGreaterThan(5);
    expect(refined[1]!.end).toBeGreaterThan(6.4);
  });

  it("measures the recitation left without a caption", () => {
    const audio = new Float32Array(6 * 16_000);
    for (let sample = 1 * 16_000; sample < 3 * 16_000; sample += 1) audio[sample] = 0.5;
    const analysis = analyzeSpeech(audio, { pauseSeconds: 0.6 });

    const covered = measureCaptionCoverage(analysis, [{ start: 1, end: 3 }]);
    const partial = measureCaptionCoverage(analysis, [{ start: 1, end: 2 }]);

    expect(covered.uncoveredSeconds).toBeLessThan(0.1);
    expect(partial.uncoveredSeconds).toBeGreaterThan(0.9);
    expect(partial.voicedSeconds).toBeGreaterThan(1.9);
  });

  it("leaves timings untouched when the audio holds no speech at all", () => {
    const silence = new Float32Array(4 * 16_000);
    const empty = new Float32Array(0);
    const words = [aligned("1:1", 1, 0.5, 1), aligned("1:1", 2, 1, 1.5)];

    for (const audio of [silence, empty]) {
      const analysis = analyzeSpeech(audio, { pauseSeconds: 0.6 });
      const refined = refineSpeechWordTimings(words, audio, { pauseSeconds: 0.6 }, analysis);

      expect(analysis.segments).toHaveLength(0);
      expect(refined.map((word) => [word.start, word.end])).toEqual([[0.5, 1], [1, 1.5]]);
      expect(refined.every((word) => Number.isFinite(word.start) && Number.isFinite(word.end))).toBe(true);
    }
  });

  it("keeps boundaries ordered and finite for a single word", () => {
    const audio = new Float32Array(3 * 16_000);
    for (let sample = 0.5 * 16_000; sample < 2 * 16_000; sample += 1) audio[sample] = 0.4;

    const refined = refineSpeechWordTimings([aligned("1:1", 1, 0.6, 0.9)], audio, { pauseSeconds: 0.6 });

    expect(refined).toHaveLength(1);
    expect(refined[0]!.end).toBeGreaterThan(refined[0]!.start);
    expect(Number.isFinite(refined[0]!.end)).toBe(true);
  });

  it("does not extend a word across a real pause", () => {
    const audio = new Float32Array(5 * 16_000);
    for (let sample = 0.4 * 16_000; sample < 1.1 * 16_000; sample += 1) audio[sample] = 0.5;
    const words = [aligned("1:1", 1, 0.4, 1.1), aligned("1:1", 2, 3.2, 3.6)];

    const refined = refineSpeechWordTimings(words, audio, { pauseSeconds: 0.6 });

    expect(refined[0]?.end).toBeCloseTo(1.1, 1);
  });
});
