import type { SpeechAnalysis, SpeechSegment } from "./timing.js";

/** A phrase shorter than this is noise rather than recitation. */
const MINIMUM_PHRASE_SECONDS = 0.25;

export interface PhraseSegment extends SpeechSegment {
  /** True when the reciter genuinely stops here, rather than the phrase being split to fit the model. */
  endsOnSilence: boolean;
}

function quietestTime(analysis: SpeechAnalysis, from: number, to: number): number {
  const first = Math.max(0, Math.round(from / analysis.hopSeconds));
  const last = Math.min(analysis.levels.length - 1, Math.round(to / analysis.hopSeconds));
  let bestTime = (from + to) / 2;
  let bestLevel = Number.POSITIVE_INFINITY;
  for (let frame = first; frame <= last; frame += 1) {
    const level = analysis.levels[frame] ?? 0;
    if (level < bestLevel) {
      bestLevel = level;
      bestTime = analysis.times[frame] ?? bestTime;
    }
  }
  return bestTime;
}

/**
 * Turns the detected stretches of recitation into phrases the recognizer can
 * take in one piece.
 *
 * A phrase longer than the model's audio window is split at its quietest
 * interior moment, which lands the cut between words rather than inside one.
 * The split is recorded so that later stages know the reciter did not actually
 * stop there.
 */
export function buildPhraseSegments(
  analysis: SpeechAnalysis,
  maximumSeconds: number,
): PhraseSegment[] {
  const phrases: PhraseSegment[] = [];

  for (const segment of analysis.segments) {
    if (segment.end - segment.start < MINIMUM_PHRASE_SECONDS) continue;
    const pending: Array<{ start: number; end: number }> = [{ ...segment }];

    while (pending.length) {
      const current = pending.shift()!;
      const span = current.end - current.start;
      if (span <= maximumSeconds) {
        phrases.push({ start: current.start, end: current.end, endsOnSilence: current.end === segment.end });
        continue;
      }
      // Search the middle for the cut so neither half is left too small to
      // recognise, and so a long phrase divides evenly rather than shedding a
      // sliver at a time.
      const pieces = Math.ceil(span / maximumSeconds);
      const target = current.start + span / pieces;
      const cut = quietestTime(
        analysis,
        Math.max(current.start + 0.5, target - span / (pieces * 4)),
        Math.min(current.end - 0.5, target + span / (pieces * 4)),
      );
      if (!(cut > current.start && cut < current.end)) {
        phrases.push({ start: current.start, end: current.end, endsOnSilence: current.end === segment.end });
        continue;
      }
      pending.unshift({ start: cut, end: current.end });
      phrases.push({ start: current.start, end: cut, endsOnSilence: false });
    }
  }

  phrases.sort((left, right) => left.start - right.start);
  return phrases;
}
