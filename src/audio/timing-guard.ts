import type { AlignedWord } from "../types.js";

export const DEFAULT_MINIMUM_CAPTION_FRAMES = 3;
export const DEFAULT_FALLBACK_FRAME_RATE = 30;
/**
 * A caption shown for a couple of frames registers as a flicker rather than a
 * word. Every caption is kept on screen for at least this long so that nothing
 * the reciter said can look skipped.
 */
export const DEFAULT_MINIMUM_WORD_SECONDS = 0.5;
/**
 * Holding a word into the silence after the reciter stops avoids an abrupt
 * blank frame at the end of an ayah.
 */
export const DEFAULT_SEGMENT_HOLD_SECONDS = 0.35;
/**
 * Reaching the minimum display time can only ever delay a later caption by
 * this much. The bound is per word, not cumulative, so captions re-synchronise
 * with the audio at the next natural pause instead of drifting away from it.
 */
export const DEFAULT_MAXIMUM_DISPLAY_DRIFT_SECONDS = 0.4;

export interface TimingGuardOptions {
  frameRate?: number;
  minimumCaptionFrames?: number;
  /** Absolute floor on how long a caption stays readable. */
  minimumWordSeconds?: number;
  /** Extra time a caption lingers into the silence after the reciter stops. */
  segmentHoldSeconds?: number;
  /** How far reaching the minimum may delay a later caption. */
  maximumDisplayDriftSeconds?: number;
}

export interface TimingGuardDiagnostics {
  frameRate: number;
  minimumCaptionFrames: number;
  minimumMeasuredSeconds: number;
  minimumDisplaySeconds: number;
  refinementFallbackWords: number;
  displayExtendedWords: number;
  maximumDisplayShiftSeconds: number;
  /** Captions that could not reach the minimum without unacceptable drift. */
  belowMinimumWords: number;
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

interface DisplayWindow {
  start: number;
  end: number;
}

/**
 * Turns measured speech intervals into on-screen windows that are readable,
 * ordered, and still faithful to the audio.
 *
 * Time for a short word is taken from neighbouring silence first, because that
 * costs nothing. Only when there is no silence to borrow does a caption delay
 * the one after it, and that delay is capped so captions cannot drift away
 * from the recitation.
 */
function solveDisplayWindows(
  measured: readonly AlignedWord[],
  minimumSeconds: number,
  frameFloorSeconds: number,
  holdSeconds: number,
  maximumDriftSeconds: number,
): DisplayWindow[] {
  const count = measured.length;
  const windows: DisplayWindow[] = measured.map((word) => ({ start: word.start, end: word.end }));

  // Borrow forwards into free time before the next caption. A caption that
  // ends a stretch of recitation may also linger into the silence.
  for (let index = 0; index < count; index += 1) {
    const window = windows[index]!;
    const nextStart = index + 1 < count ? measured[index + 1]!.start : Number.POSITIVE_INFINITY;
    const wanted = measured[index]!.endsSpeechSegment
      ? Math.max(window.start + minimumSeconds, window.end + holdSeconds)
      : window.start + minimumSeconds;
    if (wanted > window.end) window.end = Math.max(window.end, Math.min(nextStart, wanted));
  }

  // A caption is never shown before the word is recited, so time is only ever
  // borrowed forwards. Appearing early is more jarring to a viewer following
  // along than lingering late.

  // Lay the windows out in order. A caption may still take time from the next
  // one to stay readable, but never more than the drift bound allows.
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const window = windows[index]!;
    const start = Math.max(window.start, cursor);
    const nextMeasuredStart = index + 1 < count ? measured[index + 1]!.start : Number.POSITIVE_INFINITY;
    const driftLimit = nextMeasuredStart === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : nextMeasuredStart + maximumDriftSeconds;
    const wanted = Math.max(window.end, start + minimumSeconds);
    const end = Math.max(start + frameFloorSeconds, Math.min(wanted, Math.max(driftLimit, start + frameFloorSeconds)));
    window.start = start;
    window.end = end;
    cursor = end;
  }

  return windows;
}

/**
 * Keeps semantic word identity separate from audio-timing refinement.
 *
 * A timing refiner may move boundaries for a different recitation style, but
 * it is never allowed to turn a useful ASR interval into a sub-frame word. In
 * that case the original recognizer interval is restored. The display window
 * is then made readable without letting captions drift off the recitation.
 */
export function protectWordTimings(
  recognizerWords: readonly AlignedWord[],
  refinedWords: readonly AlignedWord[],
  options: TimingGuardOptions = {},
): TimingGuardResult {
  const frameRate = positiveFinite(options.frameRate, DEFAULT_FALLBACK_FRAME_RATE);
  const minimumCaptionFrames = Math.max(1, Math.round(positiveFinite(options.minimumCaptionFrames, DEFAULT_MINIMUM_CAPTION_FRAMES)));
  const minimumWordSeconds = positiveFinite(options.minimumWordSeconds, DEFAULT_MINIMUM_WORD_SECONDS);
  const segmentHoldSeconds = Math.max(0, options.segmentHoldSeconds ?? DEFAULT_SEGMENT_HOLD_SECONDS);
  const maximumDriftSeconds = Math.max(0, options.maximumDisplayDriftSeconds ?? DEFAULT_MAXIMUM_DISPLAY_DRIFT_SECONDS);
  const minimumMeasuredSeconds = 2 / frameRate;
  const frameFloorSeconds = minimumCaptionFrames / frameRate;
  const minimumDisplaySeconds = Math.max(frameFloorSeconds, minimumWordSeconds);
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

  const normalized = measured.map((word) => {
    const start = nonNegativeFinite(word.start);
    const end = Math.max(start + EPSILON, nonNegativeFinite(word.end, start + EPSILON));
    return { ...word, start, end };
  });

  const windows = solveDisplayWindows(
    normalized,
    minimumDisplaySeconds,
    frameFloorSeconds,
    segmentHoldSeconds,
    maximumDriftSeconds,
  );

  let displayExtendedWords = 0;
  let belowMinimumWords = 0;
  let maximumDisplayShiftSeconds = 0;
  const words = normalized.map((word, index) => {
    const window = windows[index]!;
    if (window.end > word.end + EPSILON) displayExtendedWords += 1;
    if (window.end - window.start < minimumDisplaySeconds - EPSILON) belowMinimumWords += 1;
    maximumDisplayShiftSeconds = Math.max(maximumDisplayShiftSeconds, window.start - word.start);
    return { ...word, displayStart: window.start, displayEnd: window.end };
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
      belowMinimumWords,
    },
  };
}
