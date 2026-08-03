import type { AlignedWord, TranslationKey } from "../types.js";
import type { QuranIndex } from "./corpus.js";

/**
 * Longest run of canonical words that may be bridged between two phrases so
 * the displayed text stays contiguous across a breath.
 */
export const MAX_BRIDGE_WORDS = 8;
/** How far behind the previous phrase a span must sit to count as a return. */
const RETURN_MARGIN_WORDS = 2;

export interface CanonicalSpan {
  first: number;
  last: number;
}

/**
 * Largest gap between two matched positions that can still be the same passage
 * rather than a stray match somewhere else in the Qur'an.
 */
const MAX_CLUSTER_GAP = 8;
/** No reciter articulates a word faster than this, so a span implying it is wrong. */
const MINIMUM_SECONDS_PER_WORD = 0.12;

/**
 * The canonical passage a phrase covers.
 *
 * Matched positions are grouped into runs that could belong to one passage and
 * the largest run wins, so a single stray match elsewhere in the Qur'an cannot
 * stretch the span across thousands of words. Everything between the ends of
 * that run is then included even where the recognizer missed it: a reciter
 * does not skip a word in the middle of a phrase, so the canonical text is
 * more trustworthy than the recognition.
 */
export function canonicalSpanOf(
  canonicalIndices: readonly number[],
  index: QuranIndex,
  phraseSeconds?: number,
): CanonicalSpan | undefined {
  const valid = canonicalIndices
    .filter((value) => Number.isInteger(value) && value >= 0 && value < index.words.length)
    .sort((left, right) => left - right);
  if (!valid.length) return undefined;

  let best = { first: valid[0]!, last: valid[0]!, count: 1 };
  let runFirst = valid[0]!;
  let runCount = 1;
  for (let position = 1; position < valid.length; position += 1) {
    const value = valid[position]!;
    const previous = valid[position - 1]!;
    if (value - previous <= MAX_CLUSTER_GAP) {
      runCount += 1;
    } else {
      if (runCount > best.count) best = { first: runFirst, last: previous, count: runCount };
      runFirst = value;
      runCount = 1;
    }
    if (position === valid.length - 1 && runCount > best.count) {
      best = { first: runFirst, last: value, count: runCount };
    }
  }

  if (phraseSeconds !== undefined && phraseSeconds > 0) {
    const maximumWords = Math.max(1, Math.floor(phraseSeconds / MINIMUM_SECONDS_PER_WORD));
    if (best.last - best.first + 1 > maximumWords) return undefined;
  }
  return { first: best.first, last: best.last };
}

/**
 * Keeps consecutive phrases from repeating or skipping canonical words.
 *
 * A phrase that starts behind where the previous one ended is pulled forward,
 * and a small gap left between them is closed, because a reciter moving on
 * within the same passage does not leave words out.
 */
export function reconcileSpan(
  span: CanonicalSpan,
  previousLast: number | undefined,
  continued: boolean,
): CanonicalSpan | undefined {
  if (previousLast === undefined) return span;
  // Every rak'ah returns to al-Fatiha, and reciters repeat an ayah they want to
  // dwell on. A phrase sitting clearly behind the previous one is such a
  // return, and pushing it forward would caption words that were not recited.
  if (span.last < previousLast - RETURN_MARGIN_WORDS) return span;
  let first = span.first;
  const last = span.last;
  if (first <= previousLast) first = previousLast + 1;
  if (continued && first > previousLast + 1 && first - previousLast - 1 <= MAX_BRIDGE_WORDS) {
    first = previousLast + 1;
  }
  return first > last ? undefined : { first, last };
}

/** Most words a phrase may be optimistically extended by to finish its verse. */
export const MAX_VERSE_COMPLETION = 4;

/**
 * Extends a span to the end of the verse it stops inside.
 *
 * A recognizer that drops the closing words of an ayah leaves the span short,
 * and the last matched word then absorbs the rest of the recitation. Offering
 * the remaining canonical words to forced alignment lets the audio decide: if
 * they were recited they receive real boundaries, and if they were not they
 * collapse and are trimmed away.
 */
export function completeVerse(span: CanonicalSpan, index: QuranIndex): CanonicalSpan {
  const canonical = index.words[span.last];
  if (!canonical) return span;
  const remaining = canonical.verseData.words.length - canonical.position;
  if (remaining <= 0) return span;
  const last = Math.min(
    index.words.length - 1,
    span.last + Math.min(remaining, MAX_VERSE_COMPLETION),
  );
  return last > span.last ? { first: span.first, last } : span;
}

/**
 * Drops words from the end of an alignment that the audio did not actually
 * contain. Forced alignment marks them by collapsing them onto a single
 * instant at the close of the phrase.
 */
export function trimCollapsedTail(
  timings: ReadonlyArray<{ start: number; end: number }>,
  keepAtLeast: number,
  minimumSeconds = 0.1,
): number {
  let count = timings.length;
  while (count > keepAtLeast) {
    const timing = timings[count - 1];
    if (!timing || timing.end - timing.start >= minimumSeconds) break;
    count -= 1;
  }
  return count;
}

/**
 * Builds the caption words for a canonical span, taking every displayed value
 * from the corpus rather than from the recognizer.
 */
export function materializeSpan(
  span: CanonicalSpan,
  index: QuranIndex,
  translation: TranslationKey,
  timings: ReadonlyArray<{ start: number; end: number }>,
  confidence: number,
  measured: boolean,
): AlignedWord[] {
  const words: AlignedWord[] = [];
  for (let position = span.first; position <= span.last; position += 1) {
    const canonical = index.words[position];
    const timing = timings[position - span.first];
    if (!canonical || !timing) continue;
    words.push({
      start: timing.start,
      end: Math.max(timing.start + 0.02, timing.end),
      surah: canonical.surah,
      verse: canonical.verse,
      verseKey: canonical.verseKey,
      position: canonical.position,
      arabic: canonical.word.text.uthmani,
      imlaei: canonical.word.text.imlaei,
      wordTranslation: canonical.word.translation,
      verseTranslation: canonical.verseData.translations[translation],
      confidence,
      inferredTiming: !measured,
      canonicalIndex: position,
      timingSource: measured ? "forced" : "inferred",
    });
  }
  return words;
}

/**
 * Spreads a span evenly across a phrase. Used only when forced alignment is
 * unavailable, so that a phrase still produces captions rather than nothing.
 */
export function evenTimings(count: number, duration: number): Array<{ start: number; end: number }> {
  const share = duration / Math.max(1, count);
  return Array.from({ length: count }, (_, position) => ({
    start: position * share,
    end: (position + 1) * share,
  }));
}
