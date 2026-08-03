import type { AlignedWord } from "../types.js";

export const DEFAULT_MINIMUM_CAPTION_FRAMES = 3;
export const DEFAULT_FALLBACK_FRAME_RATE = 30;

export interface TimingGuardOptions {
  frameRate?: number;
  minimumCaptionFrames?: number;
}

export interface TimingGuardDiagnostics {
  frameRate: number;
  minimumCaptionFrames: number;
  minimumMeasuredSeconds: number;
  minimumDisplaySeconds: number;
  refinementFallbackWords: number;
  displayExtendedWords: number;
  maximumDisplayShiftSeconds: number;
}

export interface TimingGuardResult {
  words: AlignedWord[];
  diagnostics: TimingGuardDiagnostics;
}

const EPSILON = 1e-6;

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function duration(word: Pick<AlignedWord, "start" | "end">): number {
  return Math.max(0, word.end - word.start);
}

function sameInterval(left: Pick<AlignedWord, "start" | "end">, right: Pick<AlignedWord, "start" | "end">): boolean {
  return Math.abs(left.start - right.start) < EPSILON && Math.abs(left.end - right.end) < EPSILON;
}

function referenceQueues(words: readonly AlignedWord[]): Map<number, AlignedWord[]> {
  const queues = new Map<number, AlignedWord[]>();
  for (const word of words) {
    const queue = queues.get(word.canonicalIndex) ?? [];
    queue.push(word);
    queues.set(word.canonicalIndex, queue);
  }
  return queues;
}

function takeReference(queues: Map<number, AlignedWord[]>, canonicalIndex: number): AlignedWord | undefined {
  return queues.get(canonicalIndex)?.shift();
}

/**
 * Keeps semantic word identity separate from audio-timing refinement.
 *
 * A timing refiner may move boundaries for a different recitation style, but
 * it is never allowed to turn a useful ASR interval into a sub-frame word. In
 * that case the original recognizer interval is restored. The display window
 * is then made visible for a configurable number of actual video frames.
 */
export function protectWordTimings(
  recognizerWords: readonly AlignedWord[],
  refinedWords: readonly AlignedWord[],
  options: TimingGuardOptions = {},
): TimingGuardResult {
  const frameRate = positiveFinite(options.frameRate, DEFAULT_FALLBACK_FRAME_RATE);
  const minimumCaptionFrames = Math.max(1, Math.round(positiveFinite(options.minimumCaptionFrames, DEFAULT_MINIMUM_CAPTION_FRAMES)));
  const minimumMeasuredSeconds = 2 / frameRate;
  const minimumDisplaySeconds = minimumCaptionFrames / frameRate;
  const queues = referenceQueues(recognizerWords);
  let refinementFallbackWords = 0;

  const measured: AlignedWord[] = [];
  const references: Array<AlignedWord | undefined> = [];
  for (const candidateWord of refinedWords) {
    const reference = takeReference(queues, candidateWord.canonicalIndex);
    references.push(reference);
    const referenceUsable = reference !== undefined && duration(reference) >= minimumMeasuredSeconds;
    const candidateUsable = Number.isFinite(candidateWord.start) && Number.isFinite(candidateWord.end) && duration(candidateWord) >= minimumMeasuredSeconds;
    const collapsedByRefinement = referenceUsable && !candidateUsable;
    const selected = collapsedByRefinement && reference
      ? {
          ...candidateWord,
          start: reference.start,
          end: reference.end,
          timingSource: "guard-fallback" as const,
        }
      : {
          ...candidateWord,
          timingSource: candidateWord.timingSource ?? (candidateWord.inferredTiming ? "inferred" : reference && !sameInterval(candidateWord, reference) ? "refined" : "recognizer"),
        };
    if (collapsedByRefinement) refinementFallbackWords += 1;
    if (reference && !reference.inferredTiming) {
      selected.recognizerStart = reference.recognizerStart ?? reference.start;
      selected.recognizerEnd = reference.recognizerEnd ?? reference.end;
    }
    measured.push(selected);
  }

  // A collapsed word can pull the next refined word backwards. Restore the
  // next recognizer interval too when it is the only monotonic audio boundary.
  for (let index = 1; index < measured.length; index += 1) {
    const previous = measured[index - 1];
    const current = measured[index];
    const reference = references[index];
    if (!previous || !current || current.start >= previous.end - EPSILON) continue;
    if (reference && reference.start >= previous.end - EPSILON && duration(reference) > 0) {
      current.start = reference.start;
      current.end = reference.end;
      current.timingSource = "guard-fallback";
      current.recognizerStart = reference.recognizerStart ?? reference.start;
      current.recognizerEnd = reference.recognizerEnd ?? reference.end;
      refinementFallbackWords += 1;
      continue;
    }
    // Keep the original ordering even for malformed model timestamps. This is
    // an audit-visible last resort; display timing below will still keep both
    // captions visible without using a word-specific rule.
    current.start = previous.end;
    current.end = Math.max(current.end, current.start + EPSILON);
    current.timingSource = "guard-fallback";
    refinementFallbackWords += 1;
  }

  let displayCursor = 0;
  let displayExtendedWords = 0;
  let maximumDisplayShiftSeconds = 0;
  const words = measured.map((word) => {
    const measuredStart = nonNegativeFinite(word.start);
    const measuredEnd = Math.max(measuredStart + EPSILON, nonNegativeFinite(word.end, measuredStart + EPSILON));
    const displayStart = Math.max(measuredStart, displayCursor);
    const displayEnd = Math.max(measuredEnd, displayStart + minimumDisplaySeconds);
    const shift = displayStart - measuredStart;
    if (displayEnd > measuredEnd + EPSILON) displayExtendedWords += 1;
    maximumDisplayShiftSeconds = Math.max(maximumDisplayShiftSeconds, shift);
    displayCursor = displayEnd;
    return { ...word, start: measuredStart, end: measuredEnd, displayStart, displayEnd };
  });

  return {
    words,
    diagnostics: {
      frameRate,
      minimumCaptionFrames,
      minimumMeasuredSeconds,
      minimumDisplaySeconds,
      refinementFallbackWords,
      displayExtendedWords,
      maximumDisplayShiftSeconds,
    },
  };
}
