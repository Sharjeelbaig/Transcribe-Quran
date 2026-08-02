import type { AlignedWord } from "../types.js";
import type { QuranIndex } from "../quran/corpus.js";

const SAMPLE_RATE = 16_000;
const FRAME_SECONDS = 0.05;
const HOP_SECONDS = 0.025;
const LOW_ENERGY_SECONDS = 0.25;
const MAX_FINAL_WORD_EXTENSION_SECONDS = 4;

function rms(audio: Float32Array, start: number, end: number): number {
  const first = Math.max(0, Math.floor(start * SAMPLE_RATE));
  const last = Math.min(audio.length, Math.ceil(end * SAMPLE_RATE));
  if (last <= first) return 0;
  let sum = 0;
  for (let index = first; index < last; index += 1) {
    const sample = audio[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (last - first));
}

function quantile(values: number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function energyFrames(audio: Float32Array, start: number, end: number): Array<{ start: number; level: number }> {
  const frames: Array<{ start: number; level: number }> = [];
  for (let frameStart = Math.max(0, start); frameStart < end; frameStart += HOP_SECONDS) {
    const frameEnd = Math.min(end, frameStart + FRAME_SECONDS);
    frames.push({ start: frameStart, level: rms(audio, frameStart, frameEnd) });
  }
  return frames;
}

/**
 * Whisper often closes an ayah's final word at the last reliable phoneme,
 * even when the reciter is still holding a vowel. Extend only that final word
 * to the measured audio endpoint; ordinary words and verse transitions remain
 * untouched.
 */
export function refineFinalWordTimings(words: AlignedWord[], index: QuranIndex, audio: Float32Array): AlignedWord[] {
  const output = words.map((word) => ({ ...word }));
  const audioDuration = audio.length / SAMPLE_RATE;

  for (let position = 0; position < output.length; position += 1) {
    const word = output[position];
    if (!word) continue;
    const verse = index.verses.get(word.verseKey);
    if (!verse || word.position !== verse.words.length) continue;

    const next = output[position + 1];
    const nextStart = next?.start ?? audioDuration;
    const limit = Math.min(nextStart - 0.04, word.end + MAX_FINAL_WORD_EXTENSION_SECONDS, audioDuration);
    if (limit <= word.end + 0.1) continue;

    const activeFrames = energyFrames(audio, Math.max(word.start, word.end - 0.75), word.end);
    const tailFrames = energyFrames(audio, word.end, limit);
    if (!activeFrames.length || !tailFrames.length) continue;

    const activeReference = quantile(
      activeFrames.map((frame) => frame.level),
      0.75,
    );
    if (activeReference <= 0.0001) continue;
    const tailNoise = quantile(
      tailFrames.map((frame) => frame.level),
      0.05,
    );
    const threshold = Math.max(tailNoise * 2, activeReference * 0.25);
    const requiredLowFrames = Math.max(1, Math.ceil(LOW_ENERGY_SECONDS / HOP_SECONDS));
    let lowFrames = 0;
    let refinedEnd: number | undefined;

    for (const frame of tailFrames) {
      if (frame.level < threshold) lowFrames += 1;
      else lowFrames = 0;
      if (lowFrames >= requiredLowFrames) {
        refinedEnd = frame.start - (requiredLowFrames - 1) * HOP_SECONDS;
        break;
      }
    }

    const candidateEnd = refinedEnd ?? limit;
    if (candidateEnd > word.end + 0.1) word.end = Math.min(candidateEnd, limit);
  }

  return output;
}
