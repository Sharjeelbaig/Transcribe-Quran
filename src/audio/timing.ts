import type { AlignedWord } from "../types.js";
import type { QuranIndex } from "../quran/corpus.js";

const SAMPLE_RATE = 16_000;
const FRAME_SECONDS = 0.04;
const HOP_SECONDS = 0.02;
/**
 * Recording level drifts across a long recitation. Deriving the noise floor
 * per block, rather than once for the whole file, keeps the detector honest
 * when gain, room, or microphone changes part-way through.
 */
const BLOCK_SECONDS = 10;
/** Blocks searched either side for the quietest audio, at BLOCK_SECONDS each. */
const NOISE_BLOCK_RADIUS = 6;
/** How far above the noise floor a frame must sit to count as voice. */
const SPEECH_THRESHOLD_FRACTION = 0.12;
/** Level, relative to the threshold, needed to declare speech has started. */
const SPEECH_ONSET_RATIO = 1.5;
/** Level, relative to the threshold, below which speech is declared over. */
const SPEECH_RELEASE_RATIO = 0.8;
const MINIMUM_VOICED_SECONDS = 0.08;
const BOUNDARY_SEARCH_SECONDS = 0.12;
/** How far a word may be pulled onto a stretch of speech it just missed. */
const ORPHAN_SNAP_SECONDS = 0.5;

/**
 * A short breath must not be mistaken for the end of a recited word. This is
 * deliberately a user-configurable speech rule, rather than an ayah, word,
 * Qari, or fixed-duration rule.
 */
export const DEFAULT_SPEECH_PAUSE_SECONDS = 0.6;

export interface SpeechTimingOptions {
  /** Quiet audio must persist for this long before recitation is considered stopped. */
  pauseSeconds?: number;
}

export interface SpeechSegment {
  start: number;
  end: number;
}

export interface SpeechAnalysis {
  /** Contiguous stretches of recitation, with short breaths already absorbed. */
  segments: SpeechSegment[];
  /** Frame start times, evenly spaced by the analysis hop. */
  times: Float64Array;
  /** RMS level per frame. */
  levels: Float64Array;
  /** Speech/silence decision threshold per frame. */
  thresholds: Float64Array;
  hopSeconds: number;
  duration: number;
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function quantileSorted(sorted: readonly number[], percentile: number): number {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function frameLevels(audio: Float32Array, duration: number): { times: Float64Array; levels: Float64Array } {
  const count = Math.max(1, Math.ceil(duration / HOP_SECONDS));
  const times = new Float64Array(count);
  const levels = new Float64Array(count);
  const frameSamples = Math.max(1, Math.round(FRAME_SECONDS * SAMPLE_RATE));
  for (let frame = 0; frame < count; frame += 1) {
    const time = frame * HOP_SECONDS;
    const first = Math.min(audio.length, Math.floor(time * SAMPLE_RATE));
    const last = Math.min(audio.length, first + frameSamples);
    let sum = 0;
    for (let sample = first; sample < last; sample += 1) {
      const value = audio[sample] ?? 0;
      sum += value * value;
    }
    times[frame] = time;
    levels[frame] = last > first ? Math.sqrt(sum / (last - first)) : 0;
  }
  return { times, levels };
}

/**
 * Derives a speech/silence threshold for every frame from the quiet and loud
 * percentiles of its own neighbourhood. Nothing here is specific to a reciter,
 * a word, or a recording; it only assumes that recitation is louder than the
 * room it was recorded in.
 */
function frameThresholds(levels: Float64Array): Float64Array {
  const framesPerBlock = Math.max(1, Math.round(BLOCK_SECONDS / HOP_SECONDS));
  const blockCount = Math.max(1, Math.ceil(levels.length / framesPerBlock));
  const quiet = new Float64Array(blockCount);
  const loud = new Float64Array(blockCount);

  for (let block = 0; block < blockCount; block += 1) {
    const first = block * framesPerBlock;
    const last = Math.min(levels.length, first + framesPerBlock);
    const values: number[] = [];
    for (let frame = first; frame < last; frame += 1) values.push(levels[frame] ?? 0);
    values.sort((a, b) => a - b);
    quiet[block] = quantileSorted(values, 0.1);
    loud[block] = quantileSorted(values, 0.9);
  }

  const thresholds = new Float64Array(levels.length);
  for (let frame = 0; frame < levels.length; frame += 1) {
    const block = Math.min(blockCount - 1, Math.floor(frame / framesPerBlock));
    // The room is quietest somewhere in the last minute or so, even during
    // continuous recitation. Looking that far for the noise floor stops a long
    // unbroken passage from mistaking its own quietest breath for silence,
    // which would cut a fading elongation short. The speech level is taken
    // from close by instead, so it still tracks changes in recording level.
    let noise = Number.POSITIVE_INFINITY;
    for (let offset = -NOISE_BLOCK_RADIUS; offset <= NOISE_BLOCK_RADIUS; offset += 1) {
      const neighbour = block + offset;
      if (neighbour < 0 || neighbour >= blockCount) continue;
      noise = Math.min(noise, quiet[neighbour] ?? 0);
    }
    let speech = 0;
    for (let offset = -1; offset <= 1; offset += 1) {
      const neighbour = block + offset;
      if (neighbour < 0 || neighbour >= blockCount) continue;
      speech = Math.max(speech, loud[neighbour] ?? 0);
    }
    if (!Number.isFinite(noise)) noise = 0;
    const span = Math.max(0, speech - noise);
    thresholds[frame] = span <= 1e-6 ? Number.POSITIVE_INFINITY : noise + span * SPEECH_THRESHOLD_FRACTION;
  }
  return thresholds;
}

/**
 * Segments the recitation using hysteresis so that a single frame dipping
 * between syllables never splits a word, and merges anything separated by less
 * than the configured pause.
 */
export function analyzeSpeech(audio: Float32Array, options: SpeechTimingOptions = {}): SpeechAnalysis {
  const duration = audio.length / SAMPLE_RATE;
  const pauseSeconds = positiveFinite(options.pauseSeconds, DEFAULT_SPEECH_PAUSE_SECONDS);
  const { times, levels } = frameLevels(audio, duration);
  const thresholds = frameThresholds(levels);

  const raw: SpeechSegment[] = [];
  let openedAt: number | undefined;
  for (let frame = 0; frame < levels.length; frame += 1) {
    const level = levels[frame] ?? 0;
    const threshold = thresholds[frame] ?? Number.POSITIVE_INFINITY;
    const time = times[frame] ?? frame * HOP_SECONDS;
    if (openedAt === undefined) {
      // Entering speech demands clear evidence; staying in speech does not.
      // A sustained ending fades gradually, so releasing it at a lower level
      // than it took to trigger keeps the word on screen while it dies away.
      if (level >= threshold * SPEECH_ONSET_RATIO) openedAt = time;
    } else if (level < threshold * SPEECH_RELEASE_RATIO) {
      raw.push({ start: openedAt, end: Math.min(duration, time) });
      openedAt = undefined;
    }
  }
  if (openedAt !== undefined) raw.push({ start: openedAt, end: duration });

  const merged: SpeechSegment[] = [];
  for (const segment of raw) {
    const previous = merged.at(-1);
    if (previous && segment.start - previous.end < pauseSeconds) previous.end = segment.end;
    else merged.push({ ...segment });
  }

  const segments = merged.filter((segment) => segment.end - segment.start >= MINIMUM_VOICED_SECONDS);
  return { segments, times, levels, thresholds, hopSeconds: HOP_SECONDS, duration };
}

function frameIndex(analysis: SpeechAnalysis, time: number): number {
  return clamp(Math.round(time / analysis.hopSeconds), 0, analysis.levels.length - 1);
}

/** Overlap in seconds between two intervals. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Chooses the stretch of recitation a recognized word belongs to. Overlap wins.
 * A word whose timestamps landed just outside a stretch is pulled onto it, but
 * one stranded far away in silence keeps its own timing rather than being
 * dragged into a phrase it was never part of.
 */
function owningSegment(analysis: SpeechAnalysis, start: number, end: number): number {
  let best = -1;
  let bestOverlap = 0;
  for (let index = 0; index < analysis.segments.length; index += 1) {
    const segment = analysis.segments[index]!;
    if (segment.start > end) break;
    const shared = overlap(start, end, segment.start, segment.end);
    if (shared > bestOverlap) {
      bestOverlap = shared;
      best = index;
    }
  }
  if (best >= 0) return best;

  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const midpoint = (start + end) / 2;
  for (let index = 0; index < analysis.segments.length; index += 1) {
    const segment = analysis.segments[index]!;
    const distance = midpoint < segment.start ? segment.start - midpoint : midpoint > segment.end ? midpoint - segment.end : 0;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  }
  return nearestDistance <= ORPHAN_SNAP_SECONDS ? nearest : -1;
}

/**
 * Nudges a boundary between two words onto a nearby dip in vocal energy. The
 * move is only accepted when the dip is clearly quieter than the recognizer's
 * own boundary, so continuous recitation without a real gap is left untouched.
 */
function snapToEnergyValley(analysis: SpeechAnalysis, boundary: number, earliest: number, latest: number): number {
  const low = Math.max(earliest, boundary - BOUNDARY_SEARCH_SECONDS);
  const high = Math.min(latest, boundary + BOUNDARY_SEARCH_SECONDS);
  if (high <= low) return boundary;
  const current = analysis.levels[frameIndex(analysis, boundary)] ?? 0;
  let bestTime = boundary;
  let bestLevel = current;
  for (let frame = frameIndex(analysis, low); frame <= frameIndex(analysis, high); frame += 1) {
    const level = analysis.levels[frame] ?? 0;
    if (level < bestLevel) {
      bestLevel = level;
      bestTime = analysis.times[frame] ?? boundary;
    }
  }
  return bestLevel <= current * 0.6 ? bestTime : boundary;
}

/**
 * Places `count` word boundaries across a span by equal share of vocal energy
 * rather than equal share of wall-clock time. Words the recognizer missed then
 * land on the syllables that were actually recited, instead of being smeared
 * evenly over the silence between them.
 */
export function distributeAcrossSpeech(
  analysis: SpeechAnalysis,
  start: number,
  end: number,
  count: number,
): number[] {
  const boundaries: number[] = [];
  if (count <= 1 || end <= start) {
    for (let step = 1; step < count; step += 1) boundaries.push(start + ((end - start) * step) / count);
    return boundaries;
  }

  const first = frameIndex(analysis, start);
  const last = frameIndex(analysis, end);
  const cumulative: number[] = [];
  let total = 0;
  for (let frame = first; frame <= last; frame += 1) {
    const level = analysis.levels[frame] ?? 0;
    const threshold = analysis.thresholds[frame] ?? Number.POSITIVE_INFINITY;
    // Only voiced energy earns a share, so silence between two recited words
    // is never handed to a caption.
    total += Number.isFinite(threshold) && level >= threshold ? level : 0;
    cumulative.push(total);
  }

  if (total <= 0) {
    for (let step = 1; step < count; step += 1) boundaries.push(start + ((end - start) * step) / count);
    return boundaries;
  }

  let cursor = 0;
  // Two phrases of equal energy make the target land exactly on the boundary
  // between them, where rounding decides the answer. The tolerance settles it
  // at the end of the earlier phrase rather than the start of the later one.
  const tolerance = total * 1e-9;
  for (let step = 1; step < count; step += 1) {
    const target = (total * step) / count;
    while (cursor < cumulative.length - 1 && (cumulative[cursor] ?? 0) < target - tolerance) cursor += 1;
    // Silence adds no energy, so the target is first reached at the end of the
    // preceding phrase and stays reached until the next one starts. Rewinding
    // over that flat stretch ends the word where its voice ended, rather than
    // carrying it across the pause to the start of the next word.
    let boundary = cursor;
    while (boundary > 0 && (cumulative[boundary - 1] ?? 0) >= (cumulative[boundary] ?? 0) - 1e-12) boundary -= 1;
    const time = analysis.times[first + boundary] ?? start + ((end - start) * step) / count;
    boundaries.push(clamp(time, start, end));
  }

  // Guarantee a strictly increasing, in-range sequence even if the energy
  // profile is degenerate.
  for (let step = 0; step < boundaries.length; step += 1) {
    const floor = step === 0 ? start : boundaries[step - 1]!;
    boundaries[step] = clamp(boundaries[step]!, floor, end);
  }
  return boundaries;
}

/**
 * Reports how much recitation never had a caption on screen. This is the one
 * number that says whether a viewer would notice a word missing, so it is
 * measured on the finished display windows rather than assumed.
 */
export function measureCaptionCoverage(
  analysis: SpeechAnalysis,
  windows: ReadonlyArray<{ start: number; end: number }>,
): { voicedSeconds: number; uncoveredSeconds: number } {
  const ordered = [...windows].sort((a, b) => a.start - b.start);
  let voicedSeconds = 0;
  let uncoveredSeconds = 0;
  let cursor = 0;

  for (const segment of analysis.segments) {
    voicedSeconds += segment.end - segment.start;
    let position = segment.start;
    while (cursor < ordered.length && ordered[cursor]!.end <= position) cursor += 1;
    for (let scan = cursor; scan < ordered.length; scan += 1) {
      const window = ordered[scan]!;
      if (window.start >= segment.end) break;
      if (window.start > position) uncoveredSeconds += window.start - position;
      position = Math.max(position, window.end);
      if (position >= segment.end) break;
    }
    if (position < segment.end) uncoveredSeconds += segment.end - position;
  }

  return { voicedSeconds, uncoveredSeconds };
}

/**
 * Re-places runs of words the recognizer missed onto the voice.
 *
 * Restored words arrive spread evenly over wall-clock time, which puts them on
 * silence as often as on speech. Splitting the same span by vocal energy lands
 * each one on a syllable that was actually recited, so a fast passage stays in
 * step with the reciter instead of sliding out of it.
 */
export function placeInferredWordsOnSpeech(
  words: readonly AlignedWord[],
  analysis: SpeechAnalysis,
): AlignedWord[] {
  const output = words.map((word) => ({ ...word }));
  let runStart = -1;

  const settle = (first: number, last: number): void => {
    const count = last - first + 1;
    if (count < 1) return;
    const spanStart = output[first]!.start;
    const spanEnd = output[last]!.end;
    if (!(spanEnd > spanStart)) return;
    const boundaries = distributeAcrossSpeech(analysis, spanStart, spanEnd, count);
    for (let offset = 0; offset < count; offset += 1) {
      const word = output[first + offset]!;
      word.start = offset === 0 ? spanStart : boundaries[offset - 1]!;
      word.end = offset === count - 1 ? spanEnd : boundaries[offset]!;
      if (word.end <= word.start) word.end = word.start + 0.02;
    }
  };

  for (let position = 0; position < output.length; position += 1) {
    if (output[position]!.inferredTiming) {
      if (runStart < 0) runStart = position;
      continue;
    }
    if (runStart >= 0) settle(runStart, position - 1);
    runStart = -1;
  }
  if (runStart >= 0) settle(runStart, output.length - 1);

  return output;
}

/**
 * Aligns caption boundaries to the recitation itself.
 *
 * Every word is attached to the stretch of speech it belongs to. The last word
 * of a stretch is held until the reciter actually stops, which is what keeps an
 * elongated ending on screen; interior boundaries are nudged onto energy dips;
 * and a word whose timestamps fell into silence is pulled back onto the voice.
 * It never adds Qur'an text and never relies on a word, ayah, or reciter rule.
 */
export function refineSpeechWordTimings(
  words: readonly AlignedWord[],
  audio: Float32Array,
  options: SpeechTimingOptions = {},
  precomputed?: SpeechAnalysis,
): AlignedWord[] {
  const analysis = precomputed ?? analyzeSpeech(audio, options);
  const output = words.map((word) => ({ ...word }));
  if (!analysis.segments.length) return output;

  // Attach each word to a stretch of recitation.
  const owners = output.map((word) =>
    Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start
      ? owningSegment(analysis, word.start, word.end)
      : -1,
  );

  // Words never move backwards past an earlier word's stretch.
  for (let position = 1; position < owners.length; position += 1) {
    const previous = owners[position - 1]!;
    if (owners[position]! >= 0 && previous >= 0 && owners[position]! < previous) owners[position] = previous;
  }

  for (let position = 0; position < output.length; position += 1) {
    const word = output[position]!;
    const owner = owners[position]!;
    if (owner < 0) continue;
    const segment = analysis.segments[owner]!;
    const firstOfSegment = position === 0 || owners[position - 1] !== owner;
    const lastOfSegment = position === output.length - 1 || owners[position + 1] !== owner;

    let start = clamp(word.start, segment.start, segment.end);
    let end = clamp(word.end, segment.start, segment.end);

    // The opening word of a stretch begins where the voice does; the closing
    // word is held until the voice stops, however long the reciter sustains it.
    if (firstOfSegment) start = segment.start;
    if (lastOfSegment) end = segment.end;

    if (!firstOfSegment) {
      const previous = output[position - 1]!;
      start = snapToEnergyValley(analysis, start, previous.start + 0.04, Math.max(previous.start + 0.06, end - 0.04));
      previous.end = start;
    }
    if (end <= start) end = Math.min(segment.end, start + 0.04);
    word.start = start;
    word.end = end;
    word.endsSpeechSegment = lastOfSegment;
  }

  // Guard against a following word that the recognizer placed before this one.
  for (let position = 1; position < output.length; position += 1) {
    const previous = output[position - 1]!;
    const current = output[position]!;
    if (current.start < previous.end) {
      const boundary = Math.max(previous.start + 0.02, Math.min(current.end - 0.02, current.start));
      previous.end = boundary;
      current.start = boundary;
    }
    if (current.end <= current.start) current.end = current.start + 0.04;
  }

  return output;
}

/**
 * Backwards-compatible name for callers of earlier versions. Timing is now
 * evaluated for every recognized word boundary, not just the final word of an
 * ayah; the index is retained only to avoid breaking the public API.
 */
export function refineFinalWordTimings(
  words: AlignedWord[],
  _index: QuranIndex,
  audio: Float32Array,
): AlignedWord[] {
  return refineSpeechWordTimings(words, audio);
}
