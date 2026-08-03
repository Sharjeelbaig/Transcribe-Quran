import type {
  AlignedWord,
  MatchedTranscriptWord,
  TranscriptWord,
  TranslationKey,
} from "../types.js";
import type { QuranIndex } from "./corpus.js";
import { stringSimilarity } from "./similarity.js";

interface CandidateAlignment {
  start: number;
  end: number;
  confidence: number;
  score: number;
  mappings: Array<{
    transcriptIndex: number;
    canonicalIndex: number;
    similarity: number;
    partIndex?: number;
    partCount?: number;
  }>;
}

const WINDOW_WORDS = 12;
const CONTINUITY_GAP_SECONDS = 3;
const MAX_INFERRED_WORD_SECONDS = 4;
/**
 * Longest run of recognizer-skipped words that is still safe to restore. The
 * words themselves are certain, since they are the canonical text between two
 * confident anchors; only their timing is estimated, so a generous limit is
 * still preferable to leaving the screen blank while they are recited.
 */
const MAX_GAP_WORDS = 16;
/** Smallest measured interval given to a restored word before display timing. */
const MINIMUM_INFERRED_SECONDS = 0.12;
/** How far behind the expected position a window must land to count as a return. */
const BACKWARD_RETURN_WORDS = 2;
/** Confidence a backwards jump needs before it is treated as a real return. */
const BACKWARD_RETURN_CONFIDENCE = 0.55;
const MAX_POSTINGS_PER_TOKEN = 512;
const MAX_CANDIDATES = 36;

function candidateStarts(tokens: TranscriptWord[], index: QuranIndex, expected?: number): number[] {
  const votes = new Map<number, number>();
  if (expected !== undefined) votes.set(expected, 10);

  tokens.forEach((token, transcriptIndex) => {
    const postings = index.postings.get(token.normalized);
    if (!postings?.length || postings.length > MAX_POSTINGS_PER_TOKEN) return;
    const weight = 1 / Math.log2(postings.length + 2);
    for (const position of postings) {
      const start = position - transcriptIndex;
      votes.set(start, (votes.get(start) ?? 0) + weight);
    }
  });

  if (!votes.size) {
    // A Quran-specific recognizer should normally produce exact anchors. This
    // limited fuzzy fallback avoids scanning all 77k words for every token.
    for (let transcriptIndex = 0; transcriptIndex < tokens.length; transcriptIndex += 1) {
      const token = tokens[transcriptIndex];
      if (!token || token.normalized.length < 4) continue;
      let found = 0;
      for (const [canonical, postings] of index.postings) {
        if (canonical[0] !== token.normalized[0] || Math.abs(canonical.length - token.normalized.length) > 2) {
          continue;
        }
        if (stringSimilarity(token.normalized, canonical) < 0.72) continue;
        for (const position of postings.slice(0, 20)) {
          votes.set(position - transcriptIndex, (votes.get(position - transcriptIndex) ?? 0) + 0.25);
        }
        found += 1;
        if (found >= 8) break;
      }
    }
  }

  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([start]) => Math.max(0, Math.min(index.words.length - 1, start)));
}

function alignCandidate(
  transcript: TranscriptWord[],
  index: QuranIndex,
  candidateStart: number,
  expected?: number,
): CandidateAlignment {
  const sliceStart = Math.max(0, candidateStart - 5);
  const sliceEnd = Math.min(index.words.length, candidateStart + transcript.length + 12);
  const canonical = index.words.slice(sliceStart, sliceEnd);
  const rows = transcript.length + 1;
  const columns = canonical.length + 1;
  const costs = new Float64Array(rows * columns);
  const back = new Uint8Array(rows * columns);
  const at = (row: number, column: number) => row * columns + column;

  for (let column = 0; column < columns; column += 1) costs[at(0, column)] = 0;
  for (let row = 1; row < rows; row += 1) {
    costs[at(row, 0)] = row * 0.8;
    back[at(row, 0)] = 1;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const transcriptWord = transcript[row - 1];
      const canonicalWord = canonical[column - 1];
      if (!transcriptWord || !canonicalWord) continue;
      const similarity = stringSimilarity(transcriptWord.normalized, canonicalWord.normalized);
      const diagonal = (costs[at(row - 1, column - 1)] ?? Number.POSITIVE_INFINITY) + (1 - similarity);
      const dropTranscript = (costs[at(row - 1, column)] ?? Number.POSITIVE_INFINITY) + 0.8;
      const missedCanonical = (costs[at(row, column - 1)] ?? Number.POSITIVE_INFINITY) + 0.58;
      let splitAcrossTwo = Number.POSITIVE_INFINITY;
      if (column >= 2) {
        const previousCanonical = canonical[column - 2];
        if (previousCanonical) {
          const combined = `${previousCanonical.normalized}${canonicalWord.normalized}`;
          const combinedSimilarity = stringSimilarity(transcriptWord.normalized, combined);
          if (combinedSimilarity >= 0.75) {
            splitAcrossTwo =
              (costs[at(row - 1, column - 2)] ?? Number.POSITIVE_INFINITY) +
              (1 - combinedSimilarity) +
              0.08;
          }
        }
      }
      const minimum = Math.min(diagonal, dropTranscript, missedCanonical, splitAcrossTwo);
      costs[at(row, column)] = minimum;
      back[at(row, column)] =
        minimum === diagonal ? 0 : minimum === dropTranscript ? 1 : minimum === missedCanonical ? 2 : 3;
    }
  }

  let endColumn = 0;
  let minimumCost = Number.POSITIVE_INFINITY;
  for (let column = 1; column < columns; column += 1) {
    const cost = costs[at(rows - 1, column)] ?? Number.POSITIVE_INFINITY;
    if (cost < minimumCost) {
      minimumCost = cost;
      endColumn = column;
    }
  }

  let row = rows - 1;
  let column = endColumn;
  const mappings: CandidateAlignment["mappings"] = [];
  while (row > 0 && column >= 0) {
    const direction = back[at(row, column)];
    if (column >= 2 && direction === 3) {
      const transcriptWord = transcript[row - 1];
      const firstCanonical = canonical[column - 2];
      const secondCanonical = canonical[column - 1];
      if (transcriptWord && firstCanonical && secondCanonical) {
        const similarity = stringSimilarity(
          transcriptWord.normalized,
          `${firstCanonical.normalized}${secondCanonical.normalized}`,
        );
        mappings.push({
          transcriptIndex: row - 1,
          canonicalIndex: sliceStart + column - 1,
          similarity,
          partIndex: 1,
          partCount: 2,
        });
        mappings.push({
          transcriptIndex: row - 1,
          canonicalIndex: sliceStart + column - 2,
          similarity,
          partIndex: 0,
          partCount: 2,
        });
      }
      row -= 1;
      column -= 2;
    } else if (column > 0 && direction === 0) {
      const transcriptWord = transcript[row - 1];
      const canonicalWord = canonical[column - 1];
      if (transcriptWord && canonicalWord) {
        const similarity = stringSimilarity(transcriptWord.normalized, canonicalWord.normalized);
        if (similarity >= 0.3) {
          mappings.push({
            transcriptIndex: row - 1,
            canonicalIndex: sliceStart + column - 1,
            similarity,
          });
        }
      }
      row -= 1;
      column -= 1;
    } else if (direction === 1 || column === 0) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  mappings.reverse();

  const similarityTotal = mappings.reduce((total, mapping) => total + mapping.similarity, 0);
  const coverage = mappings.length / Math.max(1, transcript.length);
  const averageSimilarity = similarityTotal / Math.max(1, mappings.length);
  const confidence = coverage * averageSimilarity;
  const actualStart = mappings[0]?.canonicalIndex ?? candidateStart;
  const continuityBonus =
    expected === undefined ? 0 : Math.max(-0.08, 0.08 - Math.abs(actualStart - expected) * 0.004);

  return {
    start: actualStart,
    end: mappings.at(-1)?.canonicalIndex ?? actualStart,
    confidence,
    score: confidence + continuityBonus,
    mappings,
  };
}

export interface MatchResult {
  matched: MatchedTranscriptWord[];
  unmatchedWindows: number;
  windowScores: number[];
  /**
   * Where the reciter is expected to continue. Passing this into the next call
   * lets a caller that matches one phrase at a time keep the same continuity a
   * single whole-transcript call would have had.
   */
  expectedCanonical?: number;
}

export interface MatchOptions {
  /** Canonical position the passage is expected to continue from. */
  expectedCanonical?: number;
}

export function matchTranscript(
  transcript: TranscriptWord[],
  index: QuranIndex,
  confidenceThreshold = 0.5,
  options: MatchOptions = {},
): MatchResult {
  const matched: MatchedTranscriptWord[] = [];
  const windowScores: number[] = [];
  let unmatchedWindows = 0;
  let expectedCanonical: number | undefined = options.expectedCanonical;

  const windows: Array<{ words: TranscriptWord[]; resetContinuity: boolean }> = [];
  let current: TranscriptWord[] = [];
  // Continuity supplied by the caller must survive the first window, or a
  // phrase-at-a-time caller would lose the context it just established.
  let resetContinuity = options.expectedCanonical === undefined;
  for (const word of transcript) {
    const previous = current.at(-1);
    const hasLongGap = previous !== undefined && word.start - previous.end >= CONTINUITY_GAP_SECONDS;
    if (current.length >= WINDOW_WORDS || hasLongGap) {
      windows.push({ words: current, resetContinuity });
      current = [];
      resetContinuity = hasLongGap;
    }
    current.push(word);
  }
  if (current.length) windows.push({ words: current, resetContinuity });

  for (const windowInfo of windows) {
    const window = windowInfo.words;
    if (!window.length) continue;
    if (windowInfo.resetContinuity) expectedCanonical = undefined;
    const continuityFloor = expectedCanonical;
    const starts = candidateStarts(window, index, expectedCanonical);
    const uniqueCandidates = new Map<string, CandidateAlignment>();
    for (const start of starts) {
      const candidate = alignCandidate(window, index, start, expectedCanonical);
      const key = `${candidate.start}:${candidate.end}`;
      const existing = uniqueCandidates.get(key);
      if (!existing || candidate.score > existing.score) uniqueCandidates.set(key, candidate);
    }
    const candidates = [...uniqueCandidates.values()];
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1];

    const effectiveThreshold =
      expectedCanonical === undefined
        ? confidenceThreshold
        : Math.max(0.38, confidenceThreshold - 0.1);
    if (!best || best.confidence < effectiveThreshold) {
      unmatchedWindows += 1;
      expectedCanonical = undefined;
      windowScores.push(best?.confidence ?? 0);
      continue;
    }

    const strongAnchors = best.mappings.filter((mapping) => mapping.similarity >= 0.72).length;
    const requiredAnchors = window.length >= 5 ? Math.min(3, Math.ceil(window.length / 5)) : 1;
    if (expectedCanonical === undefined && strongAnchors < requiredAnchors) {
      unmatchedWindows += 1;
      windowScores.push(best.confidence);
      continue;
    }

    // With no preceding context, two equally good locations are genuinely
    // ambiguous even when every recognized word is exact. Never choose one
    // merely because it appears first in the corpus.
    const margin = best.score - (second?.score ?? 0);
    if (margin < 0.015 && expectedCanonical === undefined) {
      unmatchedWindows += 1;
      windowScores.push(best.confidence);
      continue;
    }

    // Every rak'ah returns to al-Fatiha, and reciters repeat an ayah they want
    // to dwell on. The continuity floor exists to stop a word being re-matched
    // just behind the passage in progress, not to forbid those returns. When a
    // whole window lands confidently before the floor, it is a return: accept
    // it in full and continue from there instead of discarding every word.
    const returnedToEarlierPassage =
      continuityFloor !== undefined &&
      best.end < continuityFloor - BACKWARD_RETURN_WORDS &&
      best.confidence >= Math.max(confidenceThreshold, BACKWARD_RETURN_CONFIDENCE);
    const acceptedMappings =
      continuityFloor === undefined || returnedToEarlierPassage
        ? best.mappings
        : best.mappings.filter((mapping) => mapping.canonicalIndex >= continuityFloor);
    const firstMapping = acceptedMappings[0];
    if (best.confidence >= 0.75 && firstMapping && firstMapping.transcriptIndex > 0) {
      const firstCanonical = index.words[firstMapping.canonicalIndex];
      const firstSource = window[firstMapping.transcriptIndex];
      const leading = window.slice(0, firstMapping.transcriptIndex);
      const lastLeading = leading.at(-1);
      const missingPrefix = (firstCanonical?.position ?? 1) - 1;
      if (
        firstCanonical &&
        firstSource &&
        leading.length &&
        lastLeading &&
        missingPrefix > 0 &&
        missingPrefix <= 2 &&
        firstSource.start - lastLeading.end <= CONTINUITY_GAP_SECONDS
      ) {
        const spanStart = leading[0]!.start;
        const spanEnd = firstSource.start;
        const duration = (spanEnd - spanStart) / missingPrefix;
        if (duration <= MAX_INFERRED_WORD_SECONDS) {
          for (let missing = 0; missing < missingPrefix; missing += 1) {
            matched.push({
              ...leading[Math.min(missing, leading.length - 1)]!,
              start: spanStart + duration * missing,
              end: spanStart + duration * (missing + 1),
              canonicalIndex: firstMapping.canonicalIndex - missingPrefix + missing,
              matchConfidence: best.confidence * 0.5,
              inferredTiming: true,
            });
          }
        }
      }
    }

    for (const mapping of acceptedMappings) {
      const source = window[mapping.transcriptIndex];
      if (!source) continue;
      const partCount = mapping.partCount ?? 1;
      const partIndex = mapping.partIndex ?? 0;
      const duration = Math.max(0.02, source.end - source.start);
      matched.push({
        ...source,
        start: source.start + (duration * partIndex) / partCount,
        end: source.start + (duration * (partIndex + 1)) / partCount,
        canonicalIndex: mapping.canonicalIndex,
        matchConfidence: mapping.similarity * best.confidence,
      });
    }

    let acceptedEnd = acceptedMappings.at(-1)?.canonicalIndex ?? best.end;
    const lastMapping = acceptedMappings.at(-1);
    if (best.confidence >= 0.62 && lastMapping) {
      const lastCanonical = index.words[lastMapping.canonicalIndex];
      const lastSource = window[lastMapping.transcriptIndex];
      const trailing = window.slice(lastMapping.transcriptIndex + 1);
      const firstTrailing = trailing[0];
      const remainingInVerse = lastCanonical
        ? lastCanonical.verseData.words.length - lastCanonical.position
        : 0;
      if (
        lastCanonical &&
        lastSource &&
        firstTrailing &&
        remainingInVerse > 0 &&
        remainingInVerse <= 2 &&
        firstTrailing.start - lastSource.end <= 0.75
      ) {
        const spanStart = Math.max(lastSource.end, firstTrailing.start);
        const spanEnd = trailing[Math.min(remainingInVerse, trailing.length) - 1]?.end ?? firstTrailing.end;
        const duration = (spanEnd - spanStart) / remainingInVerse;
        const inferredRemaining = duration <= MAX_INFERRED_WORD_SECONDS ? remainingInVerse : 0;
        if (inferredRemaining > 0) {
          for (let missing = 1; missing <= inferredRemaining; missing += 1) {
            matched.push({
              ...trailing[Math.min(missing - 1, trailing.length - 1)]!,
              start: spanStart + duration * (missing - 1),
              end: spanStart + duration * missing,
              canonicalIndex: lastMapping.canonicalIndex + missing,
              matchConfidence: best.confidence * 0.5,
              inferredTiming: true,
            });
          }
        } else {
          // A long span usually means the next token belongs to a later
          // passage after a pause. Do not carry captions across that silence.
        }
        acceptedEnd = lastMapping.canonicalIndex + inferredRemaining;
      }
    }

    expectedCanonical = returnedToEarlierPassage
      ? acceptedEnd + 1
      : Math.max(continuityFloor ?? 0, acceptedEnd + 1);
    windowScores.push(best.confidence);
  }

  return {
    matched,
    unmatchedWindows,
    windowScores,
    ...(expectedCanonical !== undefined ? { expectedCanonical } : {}),
  };
}

function toAlignedWord(
  source: MatchedTranscriptWord,
  index: QuranIndex,
  translation: TranslationKey,
): AlignedWord | null {
  const canonical = index.words[source.canonicalIndex];
  if (!canonical) return null;
  return {
    start: source.start,
    end: Math.max(source.start + 0.02, source.end),
    surah: canonical.surah,
    verse: canonical.verse,
    verseKey: canonical.verseKey,
    position: canonical.position,
    arabic: canonical.word.text.uthmani,
    imlaei: canonical.word.text.imlaei,
    wordTranslation: canonical.word.translation,
    verseTranslation: canonical.verseData.translations[translation],
    confidence: Math.max(0, Math.min(1, source.matchConfidence * (source.confidence ?? 1))),
    inferredTiming: source.inferredTiming ?? false,
    canonicalIndex: source.canonicalIndex,
  };
}

export function materializeAlignedWords(
  matched: MatchedTranscriptWord[],
  index: QuranIndex,
  translation: TranslationKey,
): AlignedWord[] {
  const direct = matched
    .map((word) => toAlignedWord(word, index, translation))
    .filter((word): word is AlignedWord => word !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const output: AlignedWord[] = [];
  for (const current of direct) {
    const previous = output.at(-1);
    if (previous) {
      const missingCount = current.canonicalIndex - previous.canonicalIndex - 1;
      if (
        missingCount > 0 &&
        missingCount <= MAX_GAP_WORDS &&
        current.start - previous.end <= missingCount * MAX_INFERRED_WORD_SECONDS
      ) {
        // A word the recognizer skipped was still recited. Rather than drop it
        // from the Qur'an text, take the room it needs from the neighbouring
        // words, which are the two whose boundaries absorbed it.
        const needed = missingCount * MINIMUM_INFERRED_SECONDS;
        let deficit = needed - (current.start - previous.end);
        if (deficit > 0) {
          const fromPrevious = Math.min(
            deficit / 2,
            Math.max(0, previous.end - previous.start - MINIMUM_INFERRED_SECONDS),
          );
          previous.end -= fromPrevious;
          deficit -= fromPrevious;
          const fromCurrent = Math.min(
            deficit,
            Math.max(0, current.end - current.start - MINIMUM_INFERRED_SECONDS),
          );
          current.start += fromCurrent;
        }
        const availableTime = Math.max(missingCount * 0.01, current.start - previous.end);
        const duration = availableTime / missingCount;
        for (let missing = 1; missing <= missingCount; missing += 1) {
          const canonicalIndex = previous.canonicalIndex + missing;
          const canonical = index.words[canonicalIndex];
          if (!canonical) continue;
          output.push({
            start: previous.end + duration * (missing - 1),
            end: previous.end + duration * missing,
            surah: canonical.surah,
            verse: canonical.verse,
            verseKey: canonical.verseKey,
            position: canonical.position,
            arabic: canonical.word.text.uthmani,
            imlaei: canonical.word.text.imlaei,
            wordTranslation: canonical.word.translation,
            verseTranslation: canonical.verseData.translations[translation],
            confidence: Math.min(previous.confidence, current.confidence) * 0.65,
            inferredTiming: true,
            canonicalIndex,
          });
        }
      }
    }
    output.push(current);
  }

  // Whisper timestamps from adjacent inference windows can overlap slightly.
  // ASS renders every active event, so even a small overlap draws two copies of
  // the Arabic context line at once. Split overlaps at their midpoint to keep
  // the word highlight continuous while guaranteeing one active word at a time.
  for (let index = 1; index < output.length; index += 1) {
    const previous = output[index - 1];
    const current = output[index];
    if (!previous || !current || current.start >= previous.end) continue;

    const midpoint = (current.start + previous.end) / 2;
    const earliestBoundary = previous.start + 0.02;
    const latestBoundary = current.end - 0.02;
    const boundary = Math.max(earliestBoundary, Math.min(latestBoundary, midpoint));
    previous.end = boundary;
    current.start = boundary;
  }

  return output;
}
