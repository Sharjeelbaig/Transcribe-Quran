import { describe, expect, it } from "vitest";
import { buildPhraseSegments } from "../src/audio/segmenter.js";
import { analyzeSpeech } from "../src/audio/timing.js";
import { atempoFilters } from "../src/audio/tempo.js";
import { spokenForm } from "../src/model/session.js";

function tone(spans: Array<[number, number]>, seconds: number): Float32Array {
  const audio = new Float32Array(seconds * 16_000);
  for (const [from, to] of spans) {
    for (let sample = from * 16_000; sample < to * 16_000; sample += 1) audio[sample] = 0.5;
  }
  return audio;
}

describe("phrase segmentation", () => {
  it("splits the recording where the reciter stops", () => {
    const audio = tone([[0.5, 3], [5, 8]], 10);
    const phrases = buildPhraseSegments(analyzeSpeech(audio, { pauseSeconds: 0.6 }), 28);

    expect(phrases).toHaveLength(2);
    expect(phrases[0]!.start).toBeLessThan(0.6);
    expect(phrases[0]!.end).toBeCloseTo(3, 1);
    expect(phrases[0]!.endsOnSilence).toBe(true);
    expect(phrases[1]!.start).toBeCloseTo(5, 1);
    expect(phrases[1]!.endsOnSilence).toBe(true);
  });

  it("divides a phrase too long for the model's audio window", () => {
    const audio = tone([[0.5, 40]], 42);
    const phrases = buildPhraseSegments(analyzeSpeech(audio, { pauseSeconds: 0.6 }), 15);

    expect(phrases.length).toBeGreaterThan(2);
    for (const phrase of phrases) expect(phrase.end - phrase.start).toBeLessThanOrEqual(15 + 1e-6);
    // Only the true end of the recitation counts as a stop; the rest are cuts.
    expect(phrases.filter((phrase) => phrase.endsOnSilence)).toHaveLength(1);
    expect(phrases.at(-1)!.endsOnSilence).toBe(true);
    // The phrases must tile the recitation without gaps or overlaps.
    for (let position = 1; position < phrases.length; position += 1) {
      expect(phrases[position]!.start).toBeCloseTo(phrases[position - 1]!.end, 6);
    }
  });

  it("ignores a click too short to be recitation", () => {
    const audio = tone([[1, 1.05], [3, 6]], 8);
    const phrases = buildPhraseSegments(analyzeSpeech(audio, { pauseSeconds: 0.6 }), 28);

    expect(phrases).toHaveLength(1);
    expect(phrases[0]!.start).toBeCloseTo(3, 1);
  });

  it("produces nothing for silence", () => {
    expect(buildPhraseSegments(analyzeSpeech(new Float32Array(5 * 16_000)), 28)).toHaveLength(0);
  });
});

describe("tempo change", () => {
  it("leaves audio alone at normal speed", () => {
    expect(atempoFilters(1)).toEqual([]);
  });

  it("chains stages for a rate a single filter cannot reach", () => {
    // ffmpeg's atempo accepts 0.5 and above, so slower rates need chaining.
    const filters = atempoFilters(0.25);
    expect(filters.length).toBeGreaterThan(1);
    const product = filters.reduce((total, filter) => total * Number(filter.split("=")[1]), 1);
    expect(product).toBeCloseTo(0.25, 6);
  });

  it("expresses an ordinary rate as one stage", () => {
    expect(atempoFilters(1.5)).toEqual(["atempo=1.5"]);
  });
});

describe("canonical text prepared for the decoder", () => {
  it("removes pause marks that carry their own space", () => {
    // A mark like this would otherwise be read as a separate word and shift
    // every following token onto the wrong one.
    expect(spokenForm("اللَّهُ ۚ")).toBe("اللَّهُ");
    expect(spokenForm("مُّبِينًۭا")).toBe("مُّبِينًۭا".replace(/[ۖ-ۭ]/g, ""));
    expect(spokenForm("  ")).toBe("");
  });

  it("keeps the diacritics the model was trained to read", () => {
    expect(spokenForm("ٱلْحَمْدُ")).toBe("ٱلْحَمْدُ");
  });
});
